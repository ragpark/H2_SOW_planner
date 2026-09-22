import { randomUUID } from 'node:crypto';
import { getDb } from '../db/index.js';

const parse = (row) =>
  row && {
    id: row.id,
    name: row.name,
    issuer: row.issuer,
    clientId: row.client_id,
    authLoginUrl: row.auth_login_url,
    authTokenUrl: row.auth_token_url,
    jwksUrl: row.jwks_url,
    deploymentIds: JSON.parse(row.deployment_ids)
  };

export function registerPlatform(input) {
  const db = getDb();
  const required = ['name', 'issuer', 'clientId', 'authLoginUrl', 'authTokenUrl', 'jwksUrl'];
  const missing = required.filter((k) => !input[k]);
  if (missing.length) throw Object.assign(new Error(`missing: ${missing.join(', ')}`), { status: 400 });

  const existing = db
    .prepare('SELECT * FROM lti_platforms WHERE issuer = ? AND client_id = ?')
    .get(input.issuer, input.clientId);
  const deploymentIds = [...new Set([...(existing ? JSON.parse(existing.deployment_ids) : []), ...(input.deploymentIds || [])])];

  if (existing) {
    db.prepare(
      `UPDATE lti_platforms SET name = ?, auth_login_url = ?, auth_token_url = ?, jwks_url = ?, deployment_ids = ?
       WHERE id = ?`
    ).run(input.name, input.authLoginUrl, input.authTokenUrl, input.jwksUrl, JSON.stringify(deploymentIds), existing.id);
    return getPlatformById(existing.id);
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO lti_platforms (id, name, issuer, client_id, auth_login_url, auth_token_url, jwks_url, deployment_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.name, input.issuer, input.clientId, input.authLoginUrl, input.authTokenUrl, input.jwksUrl, JSON.stringify(deploymentIds));
  return getPlatformById(id);
}

export const getPlatformById = (id) =>
  parse(getDb().prepare('SELECT * FROM lti_platforms WHERE id = ?').get(id));

export const listPlatforms = () =>
  getDb().prepare('SELECT * FROM lti_platforms ORDER BY name').all().map(parse);

/**
 * Find the registration for an incoming login. A single issuer can host more
 * than one registration of the same tool, so client_id narrows it when the
 * platform sends one.
 */
export function findPlatform(issuer, clientId) {
  const db = getDb();
  if (clientId) {
    return parse(db.prepare('SELECT * FROM lti_platforms WHERE issuer = ? AND client_id = ?').get(issuer, clientId));
  }
  const rows = db.prepare('SELECT * FROM lti_platforms WHERE issuer = ?').all(issuer);
  if (rows.length !== 1) return null; // ambiguous without a client_id
  return parse(rows[0]);
}

export function addDeploymentId(platformId, deploymentId) {
  const db = getDb();
  const p = getPlatformById(platformId);
  if (!p) return null;
  if (p.deploymentIds.includes(deploymentId)) return p;
  const next = [...p.deploymentIds, deploymentId];
  db.prepare('UPDATE lti_platforms SET deployment_ids = ? WHERE id = ?').run(JSON.stringify(next), platformId);
  return getPlatformById(platformId);
}
