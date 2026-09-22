import { exportJWK, exportPKCS8, generateKeyPair, importPKCS8 } from 'jose';
import { getDb } from '../db/index.js';
import { config } from '../config.js';

/**
 * The tool's signing keypair. Generated on first use and persisted, so that a
 * platform which has cached our JWKS keeps working across restarts.
 */
export async function getToolKey() {
  const db = getDb();
  const row = db.prepare('SELECT * FROM lti_keys WHERE kid = ?').get(config.lti.keyId);
  if (row) {
    return {
      kid: row.kid,
      publicJwk: JSON.parse(row.public_jwk),
      privateKey: await importPKCS8(row.private_pkcs8, 'RS256')
    };
  }
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid: config.lti.keyId, alg: 'RS256', use: 'sig' };
  const pkcs8 = await exportPKCS8(privateKey);
  db.prepare('INSERT INTO lti_keys (kid, public_jwk, private_pkcs8) VALUES (?, ?, ?)').run(
    config.lti.keyId,
    JSON.stringify(publicJwk),
    pkcs8
  );
  return { kid: config.lti.keyId, publicJwk, privateKey };
}

export async function getJwks() {
  const { publicJwk } = await getToolKey();
  return { keys: [publicJwk] };
}
