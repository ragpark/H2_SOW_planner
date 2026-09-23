import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { startServer } from './helpers.js';

/**
 * The LMS selecting the curriculum — the point of the whole subject axis.
 * Each case drives a real signed launch through the real validation path.
 */
const CLAIM = {
  messageType: 'https://purl.imsglobal.org/spec/lti/claim/message_type',
  version: 'https://purl.imsglobal.org/spec/lti/claim/version',
  deploymentId: 'https://purl.imsglobal.org/spec/lti/claim/deployment_id',
  targetLinkUri: 'https://purl.imsglobal.org/spec/lti/claim/target_link_uri',
  resourceLink: 'https://purl.imsglobal.org/spec/lti/claim/resource_link',
  context: 'https://purl.imsglobal.org/spec/lti/claim/context',
  roles: 'https://purl.imsglobal.org/spec/lti/claim/roles',
  custom: 'https://purl.imsglobal.org/spec/lti/claim/custom'
};
const INSTRUCTOR = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor';
const CLIENT_ID = 'curriculum-client';
const DEPLOYMENT_ID = 'deployment-1';

let tool;
let platform;
let keys;
let issuer;

before(async () => {
  tool = await startServer();
  keys = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'platform-key', alg: 'RS256', use: 'sig' };
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

  await tool.call('POST', '/lti/platforms', {
    headers: { 'x-admin-token': 'test-admin-token' },
    body: {
      name: 'Curriculum LMS',
      issuer,
      clientId: CLIENT_ID,
      authLoginUrl: `${issuer}/auth`,
      authTokenUrl: `${issuer}/token`,
      jwksUrl: `${issuer}/jwks`,
      deploymentIds: [DEPLOYMENT_ID]
    }
  });
});

after(async () => {
  await tool.close();
  await new Promise((resolve) => platform.close(resolve));
});

/** Run a whole launch and return the session token plus the LTI context. */
async function launch({
  custom = {},
  context = {},
  sub = 'teacher-1',
  resourceLinkId = 'rl-1',
  targetLinkUri = 'http://localhost/lti/launch'
} = {}) {
  const login = await tool.call(
    'GET',
    `/lti/login?iss=${encodeURIComponent(issuer)}&client_id=${CLIENT_ID}&login_hint=u`
  );
  const redirect = new URL(login.headers.get('location'));
  const state = redirect.searchParams.get('state');
  const nonce = redirect.searchParams.get('nonce');

  const idToken = await new SignJWT({
    nonce,
    sub,
    name: 'Miss Hart',
    [CLAIM.messageType]: 'LtiResourceLinkRequest',
    [CLAIM.version]: '1.3.0',
    [CLAIM.deploymentId]: DEPLOYMENT_ID,
    [CLAIM.targetLinkUri]: targetLinkUri,
    [CLAIM.roles]: [INSTRUCTOR],
    [CLAIM.resourceLink]: { id: resourceLinkId, title: 'Planner' },
    [CLAIM.context]: { id: context.id || 'course-1', title: context.title, label: context.label },
    [CLAIM.custom]: custom
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'platform-key', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(CLIENT_ID)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(keys.privateKey);

  const res = await tool.call('POST', '/lti/launch', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, state }).toString()
  });
  assert.equal(res.status, 302, 'launch should succeed');
  const handoff = new URL(res.headers.get('location'), 'http://x').searchParams.get('handoff');
  const exchanged = await tool.call('POST', '/api/session/exchange', { body: { handoff } });
  const token = exchanged.body.token;
  const ctx = await tool.call('GET', '/api/lti/context', { token });
  return { token, ctx: ctx.body };
}

test('a custom subject parameter selects the curriculum', async () => {
  const { ctx } = await launch({ custom: { subject: 'physics' }, context: { id: 'c-phys', title: 'Science' } });
  assert.equal(ctx.curriculum.spineId, 'physics-ks3');
  assert.equal(ctx.curriculum.source, 'custom');
  assert.equal(ctx.curriculum.requested, 'physics');
  assert.deepEqual(ctx.curriculum.warnings, []);
});

test('subject and key stage together select across the axis', async () => {
  const { ctx } = await launch({
    custom: { subject: 'chemistry', key_stage: 'KS3' },
    context: { id: 'c-chem' }
  });
  assert.equal(ctx.curriculum.spineId, 'chemistry-ks3');
  assert.equal(ctx.curriculum.source, 'custom');
  assert.equal(ctx.curriculum.requested, 'chemistry KS3');
});

test('an explicit spine id is accepted', async () => {
  const { ctx } = await launch({ custom: { spine: 'physics-ks3' }, context: { id: 'c-spine' } });
  assert.equal(ctx.curriculum.spineId, 'physics-ks3');
  assert.equal(ctx.curriculum.source, 'custom');
});

test('a subject that is not installed warns and falls back, rather than failing', async () => {
  const { ctx } = await launch({ custom: { subject: 'biology' }, context: { id: 'c-bio' } });
  // The launch still works — a teacher is not locked out by a platform typo.
  assert.equal(ctx.lti, true);
  assert.equal(ctx.curriculum.spineId, 'chemistry-ks3', 'falls back to the deployment default');
  assert.equal(ctx.curriculum.source, 'default');
  assert.ok(ctx.curriculum.warnings.some((w) => /biology/.test(w)));
  assert.ok(ctx.curriculum.installed.includes('physics-ks3'));
});

test('a hostile custom value cannot reach the registry', async () => {
  const { ctx } = await launch({
    custom: { spine: '../../etc/passwd', subject: '<script>alert(1)</script>' },
    context: { id: 'c-evil' }
  });
  assert.equal(ctx.curriculum.source, 'default');
  assert.equal(ctx.curriculum.spineId, 'chemistry-ks3');
  assert.equal(ctx.curriculum.warnings.length, 2);
});

test('the course name is used as a suggestion when nothing else says', async () => {
  const { ctx } = await launch({ context: { id: 'c-inferred', title: 'Year 9 Physics — Set 2' } });
  assert.equal(ctx.curriculum.spineId, 'physics-ks3');
  assert.equal(ctx.curriculum.source, 'inferred');
  assert.equal(ctx.curriculum.suggestion, true, 'an inference is offered, never silently applied');
  assert.equal(ctx.curriculum.inferredFrom, 'Year 9 Physics — Set 2');
});

test('a course name naming a key stage picks that key stage', async () => {
  const { ctx } = await launch({ context: { id: 'c-ks', title: 'KS3 Chemistry' } });
  assert.equal(ctx.curriculum.spineId, 'chemistry-ks3');
  assert.equal(ctx.curriculum.source, 'inferred');
});

test('a course name with no subject in it infers nothing', async () => {
  const { ctx } = await launch({ context: { id: 'c-vague', title: 'Double Award Science' } });
  assert.equal(ctx.curriculum.source, 'default');
});

test('an explicit parameter beats an inference from the course name', async () => {
  const { ctx } = await launch({
    custom: { subject: 'chemistry' },
    context: { id: 'c-conflict', title: 'Year 9 Physics' }
  });
  assert.equal(ctx.curriculum.spineId, 'chemistry-ks3');
  assert.equal(ctx.curriculum.source, 'custom');
});

test('a course remembers its curriculum for the next launch', async () => {
  const first = await launch({ custom: { subject: 'physics' }, context: { id: 'c-memory' } });
  const scheme = await tool.call('POST', '/api/schemes', {
    token: first.token,
    body: { title: 'Physics audit', subject: 'physics', keyStage: 'KS3' }
  });
  assert.equal(scheme.status, 201);
  // Binding records both the scheme and its curriculum against the course.
  const bound = await tool.call('POST', '/api/lti/bind', {
    token: first.token,
    body: { schemeId: scheme.body.scheme.id, spineId: 'physics-ks3' }
  });
  assert.equal(bound.body.spineId, 'physics-ks3');

  // A launch from a different link in the same course still lands on physics,
  // with no custom parameter and nothing in the course name.
  const second = await launch({ context: { id: 'c-memory' }, resourceLinkId: 'rl-elsewhere' });
  assert.equal(second.ctx.curriculum.spineId, 'physics-ks3');
  assert.equal(second.ctx.curriculum.source, 'context');
});

test('the link itself outranks everything, including a conflicting parameter', async () => {
  const first = await launch({ custom: { subject: 'physics' }, context: { id: 'c-link' }, resourceLinkId: 'rl-pinned' });
  const scheme = await tool.call('POST', '/api/schemes', {
    token: first.token,
    body: { title: 'Pinned', subject: 'physics', keyStage: 'KS3' }
  });
  await tool.call('POST', '/api/lti/bind', {
    token: first.token,
    body: { schemeId: scheme.body.scheme.id, spineId: 'physics-ks3' }
  });

  // The same link relaunched, now with the platform asking for chemistry.
  const again = await launch({
    custom: { subject: 'chemistry' },
    context: { id: 'c-link' },
    resourceLinkId: 'rl-pinned'
  });
  assert.equal(again.ctx.curriculum.spineId, 'physics-ks3');
  assert.equal(again.ctx.curriculum.source, 'link');
  assert.equal(again.ctx.boundSchemeId, scheme.body.scheme.id);
});

test('a deep-linked item carries its curriculum back to the platform', async () => {
  // Deep linking needs its own launch type, so this exercises the picker path.
  const login = await tool.call(
    'GET',
    `/lti/login?iss=${encodeURIComponent(issuer)}&client_id=${CLIENT_ID}&login_hint=u`
  );
  const redirect = new URL(login.headers.get('location'));
  const idToken = await new SignJWT({
    nonce: redirect.searchParams.get('nonce'),
    sub: 'teacher-dl',
    [CLAIM.messageType]: 'LtiDeepLinkingRequest',
    [CLAIM.version]: '1.3.0',
    [CLAIM.deploymentId]: DEPLOYMENT_ID,
    [CLAIM.roles]: [INSTRUCTOR],
    [CLAIM.context]: { id: 'c-dl' },
    [CLAIM.resourceLink]: { id: 'rl-dl' },
    'https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings': {
      deep_link_return_url: `${issuer}/return`,
      accept_multiple: true
    }
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'platform-key', typ: 'JWT' })
    .setIssuer(issuer).setAudience(CLIENT_ID).setSubject('teacher-dl')
    .setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);

  const res = await tool.call('POST', '/lti/launch', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, state: redirect.searchParams.get('state') }).toString()
  });
  const handoff = new URL(res.headers.get('location'), 'http://x').searchParams.get('handoff');
  const { body: session } = await tool.call('POST', '/api/session/exchange', { body: { handoff } });

  const linked = await tool.call('POST', '/api/lti/deep-link', {
    token: session.token,
    body: { items: [{ unitId: 'u-acids', title: 'Acids', spineId: 'chemistry-ks3' }] }
  });
  assert.equal(linked.status, 200);

  const { decodeJwt } = await import('jose');
  const payload = decodeJwt(linked.body.jwt);
  const item = payload['https://purl.imsglobal.org/spec/lti-dl/claim/content_items'][0];
  assert.equal(item.custom.unit_id, 'u-acids');
  assert.equal(item.custom.spine, 'chemistry-ks3');
  assert.equal(item.custom.subject, 'chemistry');
  assert.equal(item.custom.key_stage, 'KS3');
});


/* ---------- the teacher's own link ---------- */

test('a teacher pasting a URL with the subject in it selects that curriculum', async () => {
  // The quickest thing a teacher can do in most platforms is paste a URL, so
  // query parameters on the link itself have to work.
  const { ctx } = await launch({
    context: { id: 'c-url' },
    resourceLinkId: 'rl-url-1',
    targetLinkUri: 'http://localhost/lti/launch?subject=physics&keyStage=KS3'
  });
  assert.equal(ctx.curriculum.spineId, 'physics-ks3');
  assert.equal(ctx.curriculum.source, 'link-url');
  assert.equal(ctx.curriculum.requested, 'physics KS3');
});

test('a subject alone in the link URL is enough when one key stage is installed', async () => {
  const { ctx } = await launch({
    context: { id: 'c-url-subject' },
    resourceLinkId: 'rl-url-2',
    targetLinkUri: 'http://localhost/lti/launch?subject=physics'
  });
  assert.equal(ctx.curriculum.spineId, 'physics-ks3');
  assert.equal(ctx.curriculum.source, 'link-url');
});

test('a configured custom parameter outranks the link URL', async () => {
  const { ctx } = await launch({
    custom: { subject: 'chemistry' },
    context: { id: 'c-url-conflict' },
    resourceLinkId: 'rl-url-3',
    targetLinkUri: 'http://localhost/lti/launch?subject=physics'
  });
  assert.equal(ctx.curriculum.spineId, 'chemistry-ks3');
  assert.equal(ctx.curriculum.source, 'custom');
});

test('an uninstalled subject in the link URL warns and falls back', async () => {
  const { ctx } = await launch({
    context: { id: 'c-url-bad' },
    resourceLinkId: 'rl-url-4',
    targetLinkUri: 'http://localhost/lti/launch?subject=biology'
  });
  assert.equal(ctx.curriculum.spineId, 'chemistry-ks3');
  assert.equal(ctx.curriculum.source, 'default');
  assert.ok(ctx.curriculum.warnings.some((w) => /biology/.test(w)));
});

test('a malformed link URL is ignored rather than throwing', async () => {
  const { ctx } = await launch({
    context: { id: 'c-url-junk' },
    resourceLinkId: 'rl-url-5',
    targetLinkUri: 'not a url at all'
  });
  assert.equal(ctx.lti, true);
  assert.equal(ctx.curriculum.spineId, 'chemistry-ks3');
});
