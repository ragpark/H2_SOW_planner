import pg from 'pg';
import { randomBytes } from 'node:crypto';

// Tests run against a real PostgreSQL database — the same engine as production,
// so dialect differences cannot hide here and surface only on deploy.
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres@127.0.0.1:5433/postgres';

/**
 * Each test file gets its own database rather than its own schema. A schema
 * would have to be selected per connection, and a pool hands out many — so one
 * missed connection would silently read the wrong tables.
 */
async function createTestDatabase() {
  const name = `sow_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return { name, url: url.toString() };
}

async function dropTestDatabase(name) {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
}

export async function startServer() {
  const { name, url } = await createTestDatabase();

  // Set before importing anything that reads configuration.
  process.env.DATABASE_URL = url;
  process.env.LTI_ADMIN_TOKEN = 'test-admin-token';
  process.env.SQLITE_IMPORT = 'off';

  const { createApp } = await import('../src/server.js');
  const { migrate, closeDb } = await import('../src/db/index.js');
  await migrate();

  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, { body, token, headers = {}, redirect = 'manual' } = {}) => {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined && typeof body === 'object') h['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${path}`, {
      method,
      headers: h,
      redirect,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    });
    const contentType = res.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await res.json() : await res.text();
    return { status: res.status, body: payload, headers: res.headers };
  };

  return {
    base,
    call,
    databaseName: name,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await closeDb();
      await dropTestDatabase(name);
    }
  };
}

export async function signIn(call, displayName = 'Miss Hart') {
  const res = await call('POST', '/api/session/local', { body: { displayName } });
  return res.body.token;
}
