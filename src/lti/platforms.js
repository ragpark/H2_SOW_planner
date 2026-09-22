import { randomUUID } from 'node:crypto';
import { many, one, query } from '../db/index.js';

const parse = (row) =>
  row && {
    id: row.id,
    name: row.name,
    issuer: row.issuer,
    clientId: row.client_id,
    authLoginUrl: row.auth_login_url,
    authTokenUrl: row.auth_token_url,
    jwksUrl: row.jwks_url,
    deploymentIds: row.deployment_ids || []
  };

export async function registerPlatform(input) {
  const required = ['name', 'issuer', 'clientId', 'authLoginUrl', 'authTokenUrl', 'jwksUrl'];
  const missing = required.filter((k) => !input[k]);
  if (missing.length) throw Object.assign(new Error(`missing: ${missing.join(', ')}`), { status: 400 });

  const existing = await one('SELECT * FROM lti_platforms WHERE issuer = $1 AND client_id = $2', [
    input.issuer,
    input.clientId
  ]);
  // Re-registering a platform adds deployments rather than replacing them, so
  // an administrator adding a second course cannot break the first.
  const deploymentIds = [
    ...new Set([...(existing ? existing.deployment_ids || [] : []), ...(input.deploymentIds || [])])
  ];

  const row = await one(
    `INSERT INTO lti_platforms (id, name, issuer, client_id, auth_login_url, auth_token_url, jwks_url, deployment_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (issuer, client_id) DO UPDATE SET
       name = EXCLUDED.name,
       auth_login_url = EXCLUDED.auth_login_url,
       auth_token_url = EXCLUDED.auth_token_url,
       jwks_url = EXCLUDED.jwks_url,
       deployment_ids = EXCLUDED.deployment_ids
     RETURNING *`,
    [
      existing?.id || randomUUID(),
      input.name,
      input.issuer,
      input.clientId,
      input.authLoginUrl,
      input.authTokenUrl,
      input.jwksUrl,
      JSON.stringify(deploymentIds)
    ]
  );
  return parse(row);
}

export async function getPlatformById(id) {
  return parse(await one('SELECT * FROM lti_platforms WHERE id = $1', [id]));
}

export async function listPlatforms() {
  return (await many('SELECT * FROM lti_platforms ORDER BY name')).map(parse);
}

/**
 * Find the registration for an incoming login. A single issuer can host more
 * than one registration of the same tool, so client_id narrows it when the
 * platform sends one.
 */
export async function findPlatform(issuer, clientId) {
  if (clientId) {
    return parse(
      await one('SELECT * FROM lti_platforms WHERE issuer = $1 AND client_id = $2', [issuer, clientId])
    );
  }
  const rows = await many('SELECT * FROM lti_platforms WHERE issuer = $1', [issuer]);
  if (rows.length !== 1) return null; // ambiguous without a client_id
  return parse(rows[0]);
}

export async function addDeploymentId(platformId, deploymentId) {
  const p = await getPlatformById(platformId);
  if (!p) return null;
  if (p.deploymentIds.includes(deploymentId)) return p;
  await query('UPDATE lti_platforms SET deployment_ids = $1::jsonb WHERE id = $2', [
    JSON.stringify([...p.deploymentIds, deploymentId]),
    platformId
  ]);
  return getPlatformById(platformId);
}
