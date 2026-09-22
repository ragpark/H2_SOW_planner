import express from 'express';
import cookieParser from 'cookie-parser';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertProductionConfig, config } from './config.js';
import { closeDb, migrate, pruneExpired, query, waitForDatabase } from './db/index.js';
import { importFromSqliteIfNeeded } from './db/import-sqlite.js';
import { registry, validateCurriculum } from './curriculum/index.js';
import { attachSession } from './middleware/auth.js';
import { apiRouter } from './routes/api.js';
import { ltiRouter } from './routes/lti.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');

export function createApp() {
  const contentErrors = validateCurriculum();
  if (contentErrors.length) {
    throw new Error(`curriculum content is invalid:\n  ${contentErrors.join('\n  ')}`);
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // The tool is designed to run inside an LMS iframe, so framing must be
    // allowed; a frame-ancestors policy is the deployment's job to narrow.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'self'; form-action 'self' https:"
    );
    next();
  });

  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use(attachSession);

  app.use('/lti', ltiRouter());
  app.use('/api', apiRouter());
  app.use('/api/lti', ltiRouter());

  app.get('/healthz', async (_req, res) => {
    // The platform gates a deploy on this, so it must prove the database is
    // usable, not merely that the process is up.
    try {
      await query('SELECT 1');
    } catch {
      return res.status(503).json({ ok: false, error: 'database unavailable' });
    }
    res.json({
      ok: true,
      store: 'postgres',
      lti: config.lti.enabled,
      curricula: registry.summaries().map((s) => s.id)
    });
  });

  app.use(express.static(publicDir, { index: 'index.html', maxAge: config.nodeEnv === 'production' ? '1h' : 0 }));

  // The client routes on the hash, so any unmatched GET serves the shell.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/lti')) return next();
    res.sendFile(join(publicDir, 'index.html'));
  });

  app.use((req, res) => res.status(404).json({ error: `no route for ${req.method} ${req.path}` }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'internal server error' : err.message });
  });

  return app;
}

/** Bring the database up to date before the app serves anything. */
export async function prepareDatabase() {
  await waitForDatabase();
  await migrate();
  const result = await importFromSqliteIfNeeded();
  if (result.imported) {
    const summary = Object.entries(result.imported)
      .map(([table, n]) => `${table}=${n}`)
      .join(' ');
    console.log(`Imported pre-Postgres data from ${result.file}: ${summary}`);
  }
  return result;
}

const isEntryPoint = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntryPoint) {
  const { problems, warnings } = assertProductionConfig();
  if (problems.length) {
    console.error('Refusing to start:\n  ' + problems.map((p) => `- ${p}`).join('\n  '));
    process.exit(1);
  }
  for (const warning of warnings) console.warn(`WARNING: ${warning}`);

  try {
    await prepareDatabase();
  } catch (err) {
    console.error(`Refusing to start: ${err.message}`);
    process.exit(1);
  }

  const app = createApp();
  await pruneExpired().catch((err) => console.error('[db] initial prune failed:', err.message));
  const pruneTimer = setInterval(() => {
    pruneExpired().catch((err) => console.error('[db] prune failed:', err.message));
  }, 10 * 60 * 1000);
  pruneTimer.unref();

  // Bind on all interfaces: a container host routes to the service from outside.
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`SOW Planner listening on port ${config.port} as ${config.toolUrl} (${config.nodeEnv})`);
    console.log(`Store: postgres · curricula: ${registry.summaries().map((s) => s.id).join(', ')}`);
    if (config.lti.enabled) console.log(`LTI tool configuration: ${config.toolUrl}/lti/config.json`);
  });

  // Containers are replaced on every deploy. Finish in-flight requests and
  // close the connection pool cleanly.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    clearInterval(pruneTimer);
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
    // Do not hang a deploy if a connection refuses to drain.
    setTimeout(async () => {
      await closeDb();
      process.exit(0);
    }, 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
