/**
 * Configuration, with sensible behaviour on a platform-as-a-service host.
 *
 * On Railway the public URL and the volume mount path are injected as
 * environment variables, so both are derived automatically. Getting TOOL_URL
 * wrong silently breaks every LTI launch (the redirect URI would not match the
 * one registered with the platform), so deriving it is a correctness measure,
 * not a convenience.
 */

const bool = (v, fallback = false) =>
  v === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

const trimSlash = (url) => url.replace(/\/$/, '');

/**
 * The host's own idea of where this service is publicly reachable, together
 * with where that answer came from. The source is recorded so that validation
 * is a pure function of the config object rather than of the environment.
 */
function derivePublicUrl() {
  if (process.env.TOOL_URL) return { url: trimSlash(process.env.TOOL_URL), source: 'explicit' };
  // Railway injects the service's primary public domain.
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (railwayDomain) return { url: `https://${trimSlash(railwayDomain)}`, source: 'host' };
  return { url: `http://localhost:${process.env.PORT || 3000}`, source: 'fallback' };
}

const publicUrl = derivePublicUrl();

/**
 * The SQLite file this service used before Postgres. Still resolved so a
 * deployment that has one on its volume can import it exactly once.
 */
function deriveLegacySqliteFile() {
  if (process.env.SQLITE_IMPORT_PATH) return process.env.SQLITE_IMPORT_PATH;
  if (process.env.DATABASE_FILE) return process.env.DATABASE_FILE;
  const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (volume) return `${trimSlash(volume)}/sow.db`;
  return 'data/sow.db';
}

/**
 * Postgres connects over the platform's private network in production, where
 * TLS is neither offered nor needed; anywhere else it is required. An explicit
 * PGSSLMODE always wins.
 */
function deriveSsl(databaseUrl) {
  const mode = process.env.PGSSLMODE;
  if (mode === 'disable') return false;
  if (mode === 'require' || mode === 'no-verify') return { rejectUnauthorized: false };
  if (!databaseUrl) return false;
  let host = '';
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    return false;
  }
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const isPrivate = host.endsWith('.railway.internal') || host.endsWith('.internal');
  if (isLocal || isPrivate) return false;
  // A managed provider reached over the public internet terminates TLS with a
  // certificate we have no chain for, so verification is relaxed rather than
  // TLS being dropped altogether.
  return { rejectUnauthorized: false };
}

export const config = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  // Public base URL of this tool. LTI redirect URIs are derived from it.
  toolUrl: publicUrl.url,
  toolUrlSource: publicUrl.source,
  // Postgres is the store. Railway supplies this as a reference variable.
  databaseUrl: process.env.DATABASE_URL || process.env.POSTGRES_URL || null,
  databaseSsl: deriveSsl(process.env.DATABASE_URL || process.env.POSTGRES_URL),
  databasePoolMax: Number(process.env.DATABASE_POOL_MAX || 10),
  // A pre-Postgres SQLite file to import once, if one is present.
  legacySqliteFile: deriveLegacySqliteFile(),
  sqliteImportEnabled: !['0', 'false', 'off', 'no'].includes(String(process.env.SQLITE_IMPORT ?? '').toLowerCase()),
  hostPlatform: process.env.RAILWAY_PROJECT_ID ? 'railway' : null,
  // Recorded so the unused-variable warning does not depend on the environment.
  sessionSecretSet: Boolean(process.env.SESSION_SECRET),
  // Standalone mode lets a teacher use the planner without an LMS. Disable it
  // when the tool is deployed purely as an LTI tool.
  standaloneEnabled: bool(process.env.STANDALONE_ENABLED, true),
  lti: {
    enabled: bool(process.env.LTI_ENABLED, true),
    // Identifier for the tool's own signing key, published in our JWKS.
    keyId: process.env.LTI_KEY_ID || 'h2-sow-planner-key-1',
    // Clock skew tolerance when validating platform JWTs, in seconds.
    clockToleranceSec: Number(process.env.LTI_CLOCK_TOLERANCE || 60)
  }
};

/**
 * Conditions that must hold before serving real users. Returned as problems
 * (refuse to start) and warnings (start, but say so loudly).
 */
export function assertProductionConfig(cfg = config) {
  const problems = [];
  const warnings = [];
  if (cfg.nodeEnv !== 'production') return { problems, warnings };

  if (cfg.toolUrlSource === 'fallback') {
    problems.push(
      'TOOL_URL must be set in production (no host-provided public domain was found to derive it from)'
    );
  }
  if (cfg.toolUrl.startsWith('http://') && !cfg.toolUrl.startsWith('http://localhost')) {
    problems.push(`TOOL_URL must use https in production (got ${cfg.toolUrl})`);
  }
  if (!cfg.databaseUrl) {
    problems.push(
      'DATABASE_URL must be set. On Railway, add a Postgres service and set ' +
        'DATABASE_URL=${{Postgres.DATABASE_URL}} on this service.'
    );
  }

  if (cfg.sessionSecretSet) {
    warnings.push(
      'SESSION_SECRET is set but unused. Session tokens are random opaque values stored in the ' +
        'database, so there is nothing to sign. You can remove it.'
    );
  }
  return { problems, warnings };
}
