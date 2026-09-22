import { exportJWK, exportPKCS8, generateKeyPair, importPKCS8 } from 'jose';
import { one, query } from '../db/index.js';
import { config } from '../config.js';

/**
 * The tool's signing keypair. Generated on first use and persisted, so that a
 * platform which has cached our JWKS keeps working across restarts.
 */
export async function getToolKey() {
  const existing = await one('SELECT * FROM lti_keys WHERE kid = $1', [config.lti.keyId]);
  if (existing) {
    return {
      kid: existing.kid,
      publicJwk: existing.public_jwk,
      privateKey: await importPKCS8(existing.private_pkcs8, 'RS256')
    };
  }

  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid: config.lti.keyId, alg: 'RS256', use: 'sig' };
  const pkcs8 = await exportPKCS8(privateKey);

  // Two instances booting together must not each publish a different key, so
  // the first write wins and the loser reads back what was stored.
  await query(
    `INSERT INTO lti_keys (kid, public_jwk, private_pkcs8) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (kid) DO NOTHING`,
    [config.lti.keyId, JSON.stringify(publicJwk), pkcs8]
  );
  const stored = await one('SELECT * FROM lti_keys WHERE kid = $1', [config.lti.keyId]);
  return {
    kid: stored.kid,
    publicJwk: stored.public_jwk,
    privateKey: await importPKCS8(stored.private_pkcs8, 'RS256')
  };
}

export async function getJwks() {
  const { publicJwk } = await getToolKey();
  return { keys: [publicJwk] };
}
