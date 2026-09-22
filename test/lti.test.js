import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { startServer } from './helpers.js';

const CLAIM = {
  messageType: 'https://purl.imsglobal.org/spec/lti/claim/message_type',
  version: 'https://purl.imsglobal.org/spec/lti/claim/version',
  deploymentId: 'https://purl.imsglobal.org/spec/lti/claim/deployment_id',
  targetLinkUri: 'https://purl.imsglobal.org/spec/lti/claim/target_link_uri',
  resourceLink: 'https://purl.imsglobal.org/spec/lti/claim/resource_link',
  context: 'https://purl.imsglobal.org/spec/lti/claim/context',
  roles: 'https://purl.imsglobal.org/spec/lti/claim/roles',
  deepLinkingSettings: 'https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings',
  contentItems: 'https://purl.imsglobal.org/spec/lti-dl/claim/content_items'
};

const INSTRUCTOR = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor';
const LEARNER = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Learner';

let tool;
let platform;      // the fake LMS: a JWKS endpoint plus a signing key
let platformKeys;
let issuer;
const CLIENT_ID = 'test-client-id';
const DEPLOYMENT_ID = 'deployment-1';

before(async () => {
  tool = await startServer();

  platformKeys = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(platformKeys.publicKey)), kid: 'platform-key', alg: 'RS256', use: 'sig' };

  platform = createServer((req, res) => {
    if (req.url.startsWith('/jwks')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => platform.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${platform.address().port}`;

  const registered = await tool.call('POST', '/lti/platforms', {
    headers: { 'x-admin-token': 'test-admin-token' },
    body: {
      name: 'Test LMS',
      issuer,
      clientId: CLIENT_ID,
      authLoginUrl: `${issuer}/auth`,
      authTokenUrl: `${issuer}/token`,
      jwksUrl: `${issuer}/jwks`,
      deploymentIds: [DEPLOYMENT_ID]
    }
  });
  assert.equal(registered.status, 201);
});

after(async () => {
  await tool.close();
  await new Promise((resolve) => platform.close(resolve));
});

/** Run the OIDC login step and return the state and nonce the tool issued. */
async function beginLogin() {
  const res = await tool.call(
    'GET',
    `/lti/login?iss=${encodeURIComponent(issuer)}&client_id=${CLIENT_ID}&login_hint=user-1&target_link_uri=${encodeURIComponent('http://localhost:3000/lti/launch')}`
  );
  assert.equal(res.status, 302);
  const redirect = new URL(res.headers.get('location'));
  assert.equal(redirect.origin + redirect.pathname, `${issuer}/auth`);
  assert.equal(redirect.searchParams.get('response_mode'), 'form_post');
  assert.equal(redirect.searchParams.get('response_type'), 'id_token');
  assert.equal(redirect.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(redirect.searchParams.get('login_hint'), 'user-1');
  return {
    state: redirect.searchParams.get('state'),
    nonce: redirect.searchParams.get('nonce')
  };
}

async function signIdToken(claims, { key = platformKeys.privateKey } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'platform-key', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(CLIENT_ID)
    .setSubject(claims.sub || 'user-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

function baseClaims({ nonce, roles = [INSTRUCTOR], messageType = 'LtiResourceLinkRequest', extra = {} }) {
  return {
    nonce,
    sub: 'user-1',
    name: 'Miss Hart',
    email: 'hart@school.example',
    [CLAIM.messageType]: messageType,
    [CLAIM.version]: '1.3.0',
    [CLAIM.deploymentId]: DEPLOYMENT_ID,
    [CLAIM.targetLinkUri]: 'http://localhost:3000/lti/launch',
    [CLAIM.roles]: roles,
    [CLAIM.resourceLink]: { id: 'resource-link-1', title: 'Scheme of Work' },
    [CLAIM.context]: { id: 'course-9c', title: 'Year 9 Chemistry', label: '9C' },
    ...extra
  };
}

const postLaunch = (idToken, state) =>
  tool.call('POST', '/lti/launch', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, state }).toString()
  });

/** Complete a whole launch and return the app session token. */
async function launchAsSession(options = {}) {
  const { state, nonce } = await beginLogin();
  const idToken = await signIdToken(baseClaims({ nonce, ...options }));
  const res = await postLaunch(idToken, state);
  assert.equal(res.status, 302);
  const location = res.headers.get('location');
  assert.match(location, /^\/launch\.html\?handoff=/);
  const handoff = new URL(location, 'http://x').searchParams.get('handoff');
  const exchanged = await tool.call('POST', '/api/session/exchange', { body: { handoff } });
  assert.equal(exchanged.status, 200);
  return exchanged.body;
}

test('the tool publishes a JWKS and a registration configuration', async () => {
  const jwks = await tool.call('GET', '/lti/jwks.json');
  assert.equal(jwks.status, 200);
  assert.equal(jwks.body.keys.length, 1);
  assert.equal(jwks.body.keys[0].kty, 'RSA');
  assert.ok(!jwks.body.keys[0].d, 'the private exponent must never be published');

  const config = await tool.call('GET', '/lti/config.json');
  assert.equal(config.status, 200);
  assert.match(config.body.oidc_initiation_url, /\/lti\/login$/);
  assert.match(config.body.target_link_uri, /\/lti\/launch$/);
  assert.ok(config.body.extensions[0].settings.placements.some((p) => p.message_type === 'LtiDeepLinkingRequest'));
});

test('login from an unregistered issuer is refused', async () => {
  const res = await tool.call('GET', '/lti/login?iss=https://not-registered.example&client_id=x');
  assert.equal(res.status, 404);
});

test('a valid resource link launch signs the teacher in with editing rights', async () => {
  const session = await launchAsSession();
  assert.equal(session.session.user.displayName, 'Miss Hart');
  assert.equal(session.session.source, 'lti');
  assert.equal(session.session.permissions.role, 'teacher');
  assert.equal(session.session.permissions.canEdit, true);
  assert.equal(session.session.context.title, 'Year 9 Chemistry');

  const ctx = await tool.call('GET', '/api/lti/context', { token: session.token });
  assert.equal(ctx.body.lti, true);
  assert.equal(ctx.body.platformName, 'Test LMS');
  assert.equal(ctx.body.contextTitle, 'Year 9 Chemistry');
});

test('a learner launch is read-only', async () => {
  const session = await launchAsSession({ roles: [LEARNER] });
  assert.equal(session.session.permissions.role, 'student');
  assert.equal(session.session.permissions.canEdit, false);

  const create = await tool.call('POST', '/api/schemes', { token: session.token, body: { title: 'Nope' } });
  assert.equal(create.status, 403);
  // Reading the library is still allowed.
  assert.equal((await tool.call('GET', '/api/curriculum', { token: session.token })).status, 200);
});

test('a replayed id_token is rejected', async () => {
  const { state, nonce } = await beginLogin();
  const idToken = await signIdToken(baseClaims({ nonce }));
  assert.equal((await postLaunch(idToken, state)).status, 302);
  // The same token, and even a fresh state, must not work a second time.
  const second = await beginLogin();
  const replay = await postLaunch(idToken, second.state);
  assert.equal(replay.status, 401);
});

test('a launch with a state the tool never issued is rejected', async () => {
  const { nonce } = await beginLogin();
  const idToken = await signIdToken(baseClaims({ nonce }));
  const res = await postLaunch(idToken, randomUUID());
  assert.equal(res.status, 401);
});

test('a launch whose nonce does not match the login request is rejected', async () => {
  const { state } = await beginLogin();
  const idToken = await signIdToken(baseClaims({ nonce: randomUUID() }));
  const res = await postLaunch(idToken, state);
  assert.equal(res.status, 401);
});

test('an id_token signed by the wrong key is rejected', async () => {
  const { state, nonce } = await beginLogin();
  const impostor = await generateKeyPair('RS256', { extractable: true });
  const idToken = await signIdToken(baseClaims({ nonce }), { key: impostor.privateKey });
  const res = await postLaunch(idToken, state);
  assert.equal(res.status, 401);
});

test('an id_token for an unregistered deployment is rejected', async () => {
  const { state, nonce } = await beginLogin();
  const claims = baseClaims({ nonce });
  claims[CLAIM.deploymentId] = 'deployment-not-registered';
  const res = await postLaunch(await signIdToken(claims), state);
  assert.equal(res.status, 401);
});

test('an unsupported message type is rejected', async () => {
  const { state, nonce } = await beginLogin();
  const claims = baseClaims({ nonce });
  claims[CLAIM.messageType] = 'LtiSubmissionReviewRequest';
  const res = await postLaunch(await signIdToken(claims), state);
  assert.equal(res.status, 400);
});

test('an LTI 1.1 style version claim is rejected', async () => {
  const { state, nonce } = await beginLogin();
  const claims = baseClaims({ nonce });
  claims[CLAIM.version] = '1.1.0';
  const res = await postLaunch(await signIdToken(claims), state);
  assert.equal(res.status, 400);
});

test('a handoff token works only once', async () => {
  const { state, nonce } = await beginLogin();
  const idToken = await signIdToken(baseClaims({ nonce }));
  const res = await postLaunch(idToken, state);
  const handoff = new URL(res.headers.get('location'), 'http://x').searchParams.get('handoff');
  assert.equal((await tool.call('POST', '/api/session/exchange', { body: { handoff } })).status, 200);
  assert.equal((await tool.call('POST', '/api/session/exchange', { body: { handoff } })).status, 401);
});

test('relaunching the same resource link reopens the bound scheme', async () => {
  const session = await launchAsSession();
  const created = await tool.call('POST', '/api/schemes', {
    token: session.token,
    body: { title: 'Bound scheme', autoPlan: true }
  });
  const schemeId = created.body.scheme.id;
  assert.equal((await tool.call('POST', '/api/lti/bind', { token: session.token, body: { schemeId } })).status, 200);

  const { state, nonce } = await beginLogin();
  const relaunch = await postLaunch(await signIdToken(baseClaims({ nonce })), state);
  const handoff = new URL(relaunch.headers.get('location'), 'http://x').searchParams.get('handoff');
  const exchanged = await tool.call('POST', '/api/session/exchange', { body: { handoff } });
  assert.equal(exchanged.body.target, `/#/schemes/${schemeId}`);
});

test('two teachers on the same course share the scheme; a learner sees it read-only', async () => {
  const teacherA = await launchAsSession();
  const created = await tool.call('POST', '/api/schemes', {
    token: teacherA.token,
    body: { title: 'Department plan', autoPlan: true }
  });
  const schemeId = created.body.scheme.id;

  const teacherB = await launchAsSession({ extra: { sub: 'user-2' }, roles: [INSTRUCTOR] });
  const seen = await tool.call('GET', `/api/schemes/${schemeId}`, { token: teacherB.token });
  assert.equal(seen.status, 200);
  assert.equal(seen.body.access.canEdit, true);
  const edited = await tool.call('POST', `/api/schemes/${schemeId}/units`, {
    token: teacherB.token,
    body: { unitId: 'u-materials' }
  });
  assert.ok([200, 409].includes(edited.status));
  // Only the owner may delete.
  assert.equal((await tool.call('DELETE', `/api/schemes/${schemeId}`, { token: teacherB.token })).status, 403);

  const learner = await launchAsSession({ extra: { sub: 'pupil-1' }, roles: [LEARNER] });
  const learnerView = await tool.call('GET', `/api/schemes/${schemeId}`, { token: learner.token });
  assert.equal(learnerView.status, 200);
  assert.equal(learnerView.body.access.canEdit, false);
});

test('deep linking returns a signed response the platform can verify', async () => {
  const { state, nonce } = await beginLogin();
  const claims = baseClaims({
    nonce,
    messageType: 'LtiDeepLinkingRequest',
    extra: {
      [CLAIM.deepLinkingSettings]: {
        deep_link_return_url: `${issuer}/deep-link-return`,
        accept_types: ['ltiResourceLink'],
        accept_multiple: true,
        data: 'opaque-platform-data'
      }
    }
  });
  const res = await postLaunch(await signIdToken(claims), state);
  const handoff = new URL(res.headers.get('location'), 'http://x').searchParams.get('handoff');
  const exchanged = await tool.call('POST', '/api/session/exchange', { body: { handoff } });
  assert.equal(exchanged.body.target, '/#/deep-link');
  const token = exchanged.body.token;

  const ctx = await tool.call('GET', '/api/lti/context', { token });
  assert.equal(ctx.body.canDeepLink, true);
  assert.equal(ctx.body.messageType, 'LtiDeepLinkingRequest');

  const scheme = await tool.call('POST', '/api/schemes', { token, body: { title: 'Linked scheme', autoPlan: true } });
  const linked = await tool.call('POST', '/api/lti/deep-link', {
    token,
    body: {
      items: [
        { schemeId: scheme.body.scheme.id, title: 'Year 9 Chemistry scheme of work' },
        { unitId: 'u-periodic', title: 'The Periodic Table' }
      ]
    }
  });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.returnUrl, `${issuer}/deep-link-return`);

  // The platform verifies our JWT against the tool's published JWKS.
  const jwks = await tool.call('GET', '/lti/jwks.json');
  const { payload } = await jwtVerify(linked.body.jwt, createLocalJWKSet(jwks.body), {
    issuer: CLIENT_ID,
    audience: issuer
  });
  assert.equal(payload['https://purl.imsglobal.org/spec/lti/claim/message_type'], 'LtiDeepLinkingResponse');
  assert.equal(payload['https://purl.imsglobal.org/spec/lti/claim/deployment_id'], DEPLOYMENT_ID);
  assert.equal(payload['https://purl.imsglobal.org/spec/lti-dl/claim/data'], 'opaque-platform-data');
  const items = payload[CLAIM.contentItems];
  assert.equal(items.length, 2);
  assert.equal(items[0].type, 'ltiResourceLink');
  assert.equal(items[0].custom.scheme_id, scheme.body.scheme.id);
  assert.equal(items[1].custom.unit_id, 'u-periodic');
});

test('deep linking is refused on a launch that did not ask for it', async () => {
  const session = await launchAsSession();
  const res = await tool.call('POST', '/api/lti/deep-link', {
    token: session.token,
    body: { items: [{ unitId: 'u-earth', title: 'Earth' }] }
  });
  assert.equal(res.status, 400);
});

test('platform registration requires the admin token', async () => {
  const res = await tool.call('POST', '/lti/platforms', {
    body: { name: 'Rogue', issuer: 'https://rogue.example', clientId: 'x' }
  });
  assert.equal(res.status, 401);
  const listed = await tool.call('GET', '/lti/platforms', { headers: { 'x-admin-token': 'test-admin-token' } });
  assert.equal(listed.status, 200);
  assert.ok(listed.body.platforms.some((p) => p.issuer === issuer));
});
