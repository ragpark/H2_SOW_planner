import pg from 'pg';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const here = dirname(fileURLToPath(import.meta.url));

// Postgres returns BIGINT as a string to avoid precision loss. The only
// bigints here are COUNT(*) results, which are safely small.
pg.types.setTypeParser(20, (value) => Number(value));

let pool = null;

export function getPool() {
  if (pool) return pool;
  if (!config.databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. Point it at a Postgres database — on Railway, ' +
        'add a Postgres service and set DATABASE_URL=${{Postgres.DATABASE_URL}} on this service.'
    );
  }
  pool = new pg.Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl,
    max: config.databasePoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });
  // An idle client erroring (a dropped connection, a database restart) must not
  // take the process down; the pool discards it and the next query reconnects.
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  return pool;
}

/** Run a query. Returns the pg result. */
export const query = (text, params) => getPool().query(text, params);

/** Run a query and return the first row, or null. */
export async function one(text, params) {
  const { rows } = await query(text, params);
  return rows[0] ?? null;
}

/** Run a query and return all rows. */
export async function many(text, params) {
  const { rows } = await query(text, params);
  return rows;
}

/**
 * Run a function inside a transaction on a single client. Used wherever a
 * write must be all-or-nothing, such as rewriting a scheme's placements.
 */
export async function withTx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[db] rollback failed:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Apply the schema. Every statement is idempotent, so this runs on each boot
 * and a new deploy converges the database without a separate migration step.
 */
export async function migrate() {
  const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
  await query(sql);
}

/** Wait for the database to accept connections, which lags container start. */
export async function waitForDatabase({ attempts = 10, delayMs = 1000 } = {}) {
  let lastError = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await query('SELECT 1');
      return;
    } catch (err) {
      lastError = err;
      if (i < attempts) {
        console.warn(`[db] not ready (attempt ${i}/${attempts}): ${err.message}`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw new Error(
    `Database did not become available: ${lastError?.message}. ` +
      'Check DATABASE_URL and that the Postgres service is running.'
  );
}

/** Housekeeping for the short-lived LTI and session tables. */
export async function pruneExpired() {
  await query("DELETE FROM lti_login_state WHERE created_at < now() - interval '15 minutes'");
  await query("DELETE FROM lti_used_nonces WHERE created_at < now() - interval '24 hours'");
  await query('DELETE FROM sessions WHERE expires_at < now()');
  await query('DELETE FROM session_handoffs WHERE expires_at < now()');
}

export async function closeDb() {
  if (!pool) return;
  const closing = pool;
  pool = null;
  try {
    await closing.end();
  } catch (err) {
    console.error('[db] error closing pool:', err.message);
  }
}

/** Test helper: drop everything and rebuild, giving each test file a clean slate. */
export async function resetDbForTests() {
  await query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
}
