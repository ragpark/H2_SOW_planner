import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The public URL and the database connection are derived from the host's
 * environment. Getting either wrong is a silent production failure — a
 * mismatched redirect URI breaks every LTI launch, and a missing DATABASE_URL
 * means no persistence at all — so the derivation is tested directly.
 */
const ENV_KEYS = [
  'TOOL_URL', 'RAILWAY_PUBLIC_DOMAIN', 'RAILWAY_VOLUME_MOUNT_PATH', 'RAILWAY_PROJECT_ID',
  'DATABASE_URL', 'POSTGRES_URL', 'DATABASE_FILE', 'SQLITE_IMPORT_PATH', 'SQLITE_IMPORT',
  'PGSSLMODE', 'NODE_ENV', 'SESSION_SECRET', 'PORT'
];

async function loadConfig(env) {
  const saved = { ...process.env };
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  const mod = await import(`../src/config.js?case=${encodeURIComponent(JSON.stringify(env))}`);
  process.env = saved;
  return mod;
}

test('locally, the tool URL falls back to localhost on the configured port', async () => {
  const { config } = await loadConfig({ PORT: '4000' });
  assert.equal(config.toolUrl, 'http://localhost:4000');
  assert.equal(config.databaseUrl, null);
});

test('the tool URL is derived from the host public domain', async () => {
  const { config } = await loadConfig({ RAILWAY_PUBLIC_DOMAIN: 'sow-planner-production.up.railway.app' });
  assert.equal(config.toolUrl, 'https://sow-planner-production.up.railway.app');
});

test('an explicit tool URL wins over the host domain, for custom domains', async () => {
  const { config } = await loadConfig({
    TOOL_URL: 'https://planner.school.uk/',
    RAILWAY_PUBLIC_DOMAIN: 'sow-planner-production.up.railway.app'
  });
  assert.equal(config.toolUrl, 'https://planner.school.uk', 'trailing slash is trimmed');
});

test('DATABASE_URL is read, with POSTGRES_URL accepted as an alias', async () => {
  const a = await loadConfig({ DATABASE_URL: 'postgresql://u:p@db.internal:5432/sow' });
  assert.equal(a.config.databaseUrl, 'postgresql://u:p@db.internal:5432/sow');
  const b = await loadConfig({ POSTGRES_URL: 'postgresql://u:p@db.internal:5432/sow' });
  assert.equal(b.config.databaseUrl, 'postgresql://u:p@db.internal:5432/sow');
});

test('TLS is off on a private network and on relaxed verification in public', async () => {
  const internal = await loadConfig({ DATABASE_URL: 'postgresql://u:p@postgres.railway.internal:5432/sow' });
  assert.equal(internal.config.databaseSsl, false, 'the private network needs no TLS');

  const local = await loadConfig({ DATABASE_URL: 'postgresql://postgres@127.0.0.1:5433/sow' });
  assert.equal(local.config.databaseSsl, false);

  const public_ = await loadConfig({ DATABASE_URL: 'postgresql://u:p@abc.proxy.rlwy.net:1234/sow' });
  assert.deepEqual(public_.config.databaseSsl, { rejectUnauthorized: false });
});

test('an explicit PGSSLMODE overrides the derived setting either way', async () => {
  const off = await loadConfig({
    DATABASE_URL: 'postgresql://u:p@abc.proxy.rlwy.net:1234/sow',
    PGSSLMODE: 'disable'
  });
  assert.equal(off.config.databaseSsl, false);

  const on = await loadConfig({
    DATABASE_URL: 'postgresql://u:p@postgres.railway.internal:5432/sow',
    PGSSLMODE: 'require'
  });
  assert.deepEqual(on.config.databaseSsl, { rejectUnauthorized: false });
});

test('production refuses to start without a resolvable public https url', async () => {
  const { config, assertProductionConfig } = await loadConfig({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://u:p@db.internal:5432/sow'
  });
  const { problems } = assertProductionConfig(config);
  assert.ok(problems.some((p) => p.includes('TOOL_URL must be set')));
});

test('production refuses a plaintext public url', async () => {
  const { config, assertProductionConfig } = await loadConfig({
    NODE_ENV: 'production',
    TOOL_URL: 'http://planner.school.uk',
    DATABASE_URL: 'postgresql://u:p@db.internal:5432/sow'
  });
  const { problems } = assertProductionConfig(config);
  assert.ok(problems.some((p) => p.includes('must use https')));
});

test('production refuses to start with no database configured', async () => {
  const { config, assertProductionConfig } = await loadConfig({
    NODE_ENV: 'production',
    RAILWAY_PUBLIC_DOMAIN: 'sow.up.railway.app'
  });
  const { problems } = assertProductionConfig(config);
  assert.ok(problems.some((p) => p.includes('DATABASE_URL must be set')));
  assert.ok(problems.some((p) => p.includes('Postgres.DATABASE_URL')), 'names the remedy');
});

test('a correctly configured production deployment is clean', async () => {
  const { config, assertProductionConfig } = await loadConfig({
    NODE_ENV: 'production',
    RAILWAY_PUBLIC_DOMAIN: 'sow.up.railway.app',
    RAILWAY_PROJECT_ID: 'proj-1',
    DATABASE_URL: 'postgresql://u:p@postgres.railway.internal:5432/railway'
  });
  const { problems, warnings } = assertProductionConfig(config);
  assert.deepEqual(problems, []);
  assert.deepEqual(warnings, []);
  assert.equal(config.toolUrl, 'https://sow.up.railway.app');
});

test('a leftover SESSION_SECRET is reported as unused rather than silently ignored', async () => {
  const { config, assertProductionConfig } = await loadConfig({
    NODE_ENV: 'production',
    RAILWAY_PUBLIC_DOMAIN: 'sow.up.railway.app',
    DATABASE_URL: 'postgresql://u:p@postgres.railway.internal:5432/railway',
    SESSION_SECRET: 'left-over-from-an-older-deploy'
  });
  const { warnings } = assertProductionConfig(config);
  assert.ok(warnings.some((w) => w.includes('SESSION_SECRET is set but unused')));
});

test('the legacy SQLite path still resolves, so a volume can be imported once', async () => {
  const fromVolume = await loadConfig({ RAILWAY_VOLUME_MOUNT_PATH: '/data' });
  assert.equal(fromVolume.config.legacySqliteFile, '/data/sow.db');
  assert.equal(fromVolume.config.sqliteImportEnabled, true);

  const explicit = await loadConfig({ SQLITE_IMPORT_PATH: '/mnt/old/sow.db' });
  assert.equal(explicit.config.legacySqliteFile, '/mnt/old/sow.db');

  const disabled = await loadConfig({ RAILWAY_VOLUME_MOUNT_PATH: '/data', SQLITE_IMPORT: 'off' });
  assert.equal(disabled.config.sqliteImportEnabled, false);
});

test('connecting without a database URL explains what to set', async () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const { getPool } = await import('../src/db/index.js?case=no-url');
  assert.throws(() => getPool(), (err) => {
    assert.match(err.message, /DATABASE_URL is not set/);
    assert.match(err.message, /Postgres\.DATABASE_URL/);
    return true;
  });
  if (saved !== undefined) process.env.DATABASE_URL = saved;
});
