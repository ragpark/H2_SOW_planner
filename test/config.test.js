import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The tool URL and database path are derived from the host's environment.
 * Getting either wrong is a silent production failure — a mismatched redirect
 * URI breaks every LTI launch, and an ephemeral database loses every scheme —
 * so the derivation is tested directly.
 */
async function loadConfig(env) {
  const saved = { ...process.env };
  for (const key of ['TOOL_URL', 'RAILWAY_PUBLIC_DOMAIN', 'RAILWAY_VOLUME_MOUNT_PATH',
                     'RAILWAY_PROJECT_ID', 'DATABASE_FILE', 'DATABASE_PERSISTENT',
                     'NODE_ENV', 'SESSION_SECRET', 'PORT']) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  // A cache-busting query gives a fresh module instance per case.
  const mod = await import(`../src/config.js?case=${encodeURIComponent(JSON.stringify(env))}`);
  process.env = saved;
  return mod;
}

test('locally, the tool URL falls back to localhost on the configured port', async () => {
  const { config } = await loadConfig({ PORT: '4000' });
  assert.equal(config.toolUrl, 'http://localhost:4000');
  assert.equal(config.databaseFile, 'data/sow.db');
  assert.equal(config.databaseIsPersistent, false);
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

test('the database moves into a mounted volume automatically', async () => {
  const { config } = await loadConfig({ RAILWAY_VOLUME_MOUNT_PATH: '/data' });
  assert.equal(config.databaseFile, '/data/sow.db');
  assert.equal(config.databaseIsPersistent, true);
});

test('an explicit database path wins over the volume default', async () => {
  const { config } = await loadConfig({ RAILWAY_VOLUME_MOUNT_PATH: '/data', DATABASE_FILE: '/data/custom.db' });
  assert.equal(config.databaseFile, '/data/custom.db');
});

test('production refuses to start without a resolvable public https url', async () => {
  const { config, assertProductionConfig } = await loadConfig({ NODE_ENV: 'production' });
  const { problems } = assertProductionConfig(config);
  assert.ok(problems.some((p) => p.includes('TOOL_URL must be set')));
});

test('production refuses a plaintext public url', async () => {
  const { config, assertProductionConfig } = await loadConfig({
    NODE_ENV: 'production',
    TOOL_URL: 'http://planner.school.uk'
  });
  const { problems } = assertProductionConfig(config);
  assert.ok(problems.some((p) => p.includes('must use https')));
});

test('production warns, but still starts, when the database is ephemeral', async () => {
  const { config, assertProductionConfig } = await loadConfig({
    NODE_ENV: 'production',
    RAILWAY_PUBLIC_DOMAIN: 'sow.up.railway.app',
    RAILWAY_PROJECT_ID: 'proj-1'
  });
  const { problems, warnings } = assertProductionConfig(config);
  assert.deepEqual(problems, []);
  assert.ok(warnings.some((w) => w.includes('not on a persistent volume')));
  assert.ok(warnings.some((w) => w.includes('Attach a Railway volume')));
});

test('a correctly configured production deployment is clean', async () => {
  const { config, assertProductionConfig } = await loadConfig({
    NODE_ENV: 'production',
    RAILWAY_PUBLIC_DOMAIN: 'sow.up.railway.app',
    RAILWAY_VOLUME_MOUNT_PATH: '/data',
    RAILWAY_PROJECT_ID: 'proj-1'
  });
  const { problems, warnings } = assertProductionConfig(config);
  assert.deepEqual(problems, []);
  assert.deepEqual(warnings, []);
  assert.equal(config.toolUrl, 'https://sow.up.railway.app');
  assert.equal(config.databaseFile, '/data/sow.db');
});

test('a leftover SESSION_SECRET is reported as unused rather than silently ignored', async () => {
  const { config, assertProductionConfig } = await loadConfig({
    NODE_ENV: 'production',
    RAILWAY_PUBLIC_DOMAIN: 'sow.up.railway.app',
    RAILWAY_VOLUME_MOUNT_PATH: '/data',
    SESSION_SECRET: 'left-over-from-an-older-deploy'
  });
  const { warnings } = assertProductionConfig(config);
  assert.ok(warnings.some((w) => w.includes('SESSION_SECRET is set but unused')));
});
