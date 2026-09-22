import express from 'express';
import cookieParser from 'cookie-parser';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertProductionConfig, config } from './config.js';
import { getDb, pruneExpired } from './db/index.js';
import { validateCurriculum } from './curriculum/index.js';
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
  getDb();

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

  app.get('/healthz', (_req, res) => res.json({ ok: true, subject: 'chemistry' }));

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

const isEntryPoint = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntryPoint) {
  const problems = assertProductionConfig();
  if (problems.length) {
    console.error('Refusing to start:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  const app = createApp();
  pruneExpired();
  setInterval(() => pruneExpired(), 10 * 60 * 1000).unref();
  app.listen(config.port, () => {
    console.log(`SOW Planner listening on ${config.toolUrl} (${config.nodeEnv})`);
    if (config.lti.enabled) console.log(`LTI tool configuration: ${config.toolUrl}/lti/config.json`);
  });
}
