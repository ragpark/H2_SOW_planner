import { randomUUID } from 'node:crypto';
import { SignJWT, createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { getToolKey } from './keys.js';
import { findPlatform } from './platforms.js';

export const CLAIM = {
  messageType: 'https://purl.imsglobal.org/spec/lti/claim/message_type',
  version: 'https://purl.imsglobal.org/spec/lti/claim/version',
  deploymentId: 'https://purl.imsglobal.org/spec/lti/claim/deployment_id',
  targetLinkUri: 'https://purl.imsglobal.org/spec/lti/claim/target_link_uri',
  resourceLink: 'https://purl.imsglobal.org/spec/lti/claim/resource_link',
  context: 'https://purl.imsglobal.org/spec/lti/claim/context',
  roles: 'https://purl.imsglobal.org/spec/lti/claim/roles',
  platform: 'https://purl.imsglobal.org/spec/lti/claim/tool_platform',
  launchPresentation: 'https://purl.imsglobal.org/spec/lti/claim/launch_presentation',
  custom: 'https://purl.imsglobal.org/spec/lti/claim/custom',
  deepLinkingSettings: 'https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings',
  contentItems: 'https://purl.imsglobal.org/spec/lti-dl/claim/content_items',
  deepLinkingData: 'https://purl.imsglobal.org/spec/lti-dl/claim/data'
};

export const MESSAGE_TYPE = {
  resourceLink: 'LtiResourceLinkRequest',
  deepLinking: 'LtiDeepLinkingRequest'
};

const jwksCache = new Map();
const remoteJwks = (url) => {
  if (!jwksCache.has(url)) {
    jwksCache.set(url, createRemoteJWKSet(new URL(url), { cacheMaxAge: 10 * 60 * 1000 }));
  }
  return jwksCache.get(url);
};

export const redirectUri = () => `${config.toolUrl}/lti/launch`;

class LtiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.name = 'LtiError';
  }
}

/**
 * Step 1 of the OIDC third-party-initiated login. The platform tells us who is
 * launching; we hand back an authentication request carrying a state and nonce
 * we will insist on seeing again in the id_token.
 */
export function buildLoginRedirect(params) {
  const issuer = params.iss;
  if (!issuer) throw new LtiError('iss is required');
  const platform = findPlatform(issuer, params.client_id);
  if (!platform) throw new LtiError(`no registration for issuer ${issuer}`, 404);

  const state = randomUUID();
  const nonce = randomUUID();
  getDb()
    .prepare(
      'INSERT INTO lti_login_state (state, nonce, issuer, client_id, target_link_uri) VALUES (?, ?, ?, ?, ?)'
    )
    .run(state, nonce, issuer, platform.clientId, params.target_link_uri || null);

  const url = new URL(platform.authLoginUrl);
  const q = url.searchParams;
  q.set('scope', 'openid');
  q.set('response_type', 'id_token');
  q.set('response_mode', 'form_post');
  q.set('prompt', 'none');
  q.set('client_id', platform.clientId);
  q.set('redirect_uri', redirectUri());
  q.set('state', state);
  q.set('nonce', nonce);
  if (params.login_hint) q.set('login_hint', params.login_hint);
  if (params.lti_message_hint) q.set('lti_message_hint', params.lti_message_hint);
  if (params.lti_deployment_id) q.set('lti_deployment_id', params.lti_deployment_id);

  return { url: url.toString(), state, nonce, platform };
}

/**
 * Step 2: validate the id_token the platform posts back. Every check here is
 * required by the LTI 1.3 security framework — signature, issuer, audience,
 * expiry, the state we issued, single-use nonce, and a known deployment.
 */
export async function validateLaunch({ idToken, state }) {
  if (!idToken) throw new LtiError('id_token is required');
  const db = getDb();

  const stateRow = state ? db.prepare('SELECT * FROM lti_login_state WHERE state = ?').get(state) : null;
  if (!stateRow) throw new LtiError('unknown or expired state — restart the launch', 401);
  db.prepare('DELETE FROM lti_login_state WHERE state = ?').run(state);

  let unverified;
  try {
    unverified = decodeJwt(idToken);
  } catch {
    throw new LtiError('id_token is not a JWT', 401);
  }
  if (unverified.iss !== stateRow.issuer) throw new LtiError('id_token issuer does not match the login request', 401);

  const audience = Array.isArray(unverified.aud) ? unverified.aud[0] : unverified.aud;
  const platform = findPlatform(unverified.iss, audience);
  if (!platform) throw new LtiError('id_token is from an unregistered platform', 401);

  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, remoteJwks(platform.jwksUrl), {
      issuer: platform.issuer,
      audience: platform.clientId,
      clockTolerance: config.lti.clockToleranceSec
    }));
  } catch (err) {
    throw new LtiError(`id_token verification failed: ${err.message}`, 401);
  }

  if (payload.nonce !== stateRow.nonce) throw new LtiError('nonce does not match the login request', 401);
  const replayed = db.prepare('SELECT 1 FROM lti_used_nonces WHERE nonce = ?').get(payload.nonce);
  if (replayed) throw new LtiError('id_token has already been used', 401);
  db.prepare('INSERT INTO lti_used_nonces (nonce) VALUES (?)').run(payload.nonce);

  if (payload[CLAIM.version] !== '1.3.0') throw new LtiError('only LTI 1.3 is supported', 400);

  const deploymentId = payload[CLAIM.deploymentId];
  if (!deploymentId) throw new LtiError('deployment_id claim is missing', 400);
  if (platform.deploymentIds.length > 0 && !platform.deploymentIds.includes(deploymentId)) {
    throw new LtiError(`deployment ${deploymentId} is not registered for this platform`, 401);
  }

  const messageType = payload[CLAIM.messageType];
  if (![MESSAGE_TYPE.resourceLink, MESSAGE_TYPE.deepLinking].includes(messageType)) {
    throw new LtiError(`unsupported message type ${messageType}`, 400);
  }

  return { payload, platform, messageType, deploymentId };
}

/** Everything the app needs from a validated launch, in its own vocabulary. */
export function summariseLaunch({ payload, platform, messageType, deploymentId }) {
  const resourceLink = payload[CLAIM.resourceLink] || {};
  const context = payload[CLAIM.context] || {};
  const presentation = payload[CLAIM.launchPresentation] || {};
  return {
    messageType,
    deploymentId,
    platform: { id: platform.id, name: platform.name, issuer: platform.issuer, clientId: platform.clientId },
    user: {
      sub: payload.sub,
      name: payload.name || [payload.given_name, payload.family_name].filter(Boolean).join(' ') || null,
      email: payload.email || null
    },
    roles: payload[CLAIM.roles] || [],
    context: { id: context.id || null, title: context.title || null, label: context.label || null },
    resourceLink: { id: resourceLink.id || null, title: resourceLink.title || null },
    custom: payload[CLAIM.custom] || {},
    returnUrl: presentation.return_url || null,
    deepLinking: payload[CLAIM.deepLinkingSettings] || null,
    deepLinkingData: payload[CLAIM.deepLinkingSettings]?.data || null
  };
}

/**
 * Build the signed Deep Linking response the browser auto-posts back to the
 * platform, carrying the resources the teacher chose.
 */
export async function buildDeepLinkingResponse({ launch, contentItems }) {
  const { privateKey, kid } = await getToolKey();
  const settings = launch.deepLinking;
  if (!settings?.deep_link_return_url) throw new LtiError('launch has no deep link return url', 400);

  const jwt = await new SignJWT({
    [CLAIM.messageType]: 'LtiDeepLinkingResponse',
    [CLAIM.version]: '1.3.0',
    [CLAIM.deploymentId]: launch.deploymentId,
    [CLAIM.contentItems]: contentItems,
    ...(settings.data ? { [CLAIM.deepLinkingData]: settings.data } : {})
  })
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
    .setIssuer(launch.platform.clientId)
    .setAudience(launch.platform.issuer)
    .setIssuedAt()
    .setExpirationTime('5m')
    .setJti(randomUUID())
    .sign(privateKey);

  return { returnUrl: settings.deep_link_return_url, jwt };
}

export { LtiError };
