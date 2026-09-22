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
 * Where the SQLite file lives. A container filesystem is ephemeral, so when the
 * host gives us a mounted volume we put the database inside it by default.
 */
function deriveDatabaseFile() {
  if (process.env.DATABASE_FILE) return process.env.DATABASE_FILE;
  const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (volume) return `${trimSlash(volume)}/sow.db`;
  return 'data/sow.db';
}

export const config = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  // Public base URL of this tool. LTI redirect URIs are derived from it.
  toolUrl: publicUrl.url,
  toolUrlSource: publicUrl.source,
  databaseFile: deriveDatabaseFile(),
  // True when the database is on a mount the host promises to keep.
  databaseIsPersistent: Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATABASE_PERSISTENT),
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

  // Losing the database loses every scheme of work AND every LTI platform
  // registration, so an ephemeral container filesystem is a real hazard.
  if (!cfg.databaseIsPersistent && cfg.databaseFile !== ':memory:') {
    warnings.push(
      `The database at ${cfg.databaseFile} is not on a persistent volume. ` +
        'Schemes of work and LTI platform registrations will be lost on the next deploy or restart. ' +
        (cfg.hostPlatform === 'railway'
          ? 'Attach a Railway volume to this service; the database will move into it automatically.'
          : 'Mount a volume and point DATABASE_FILE at it.')
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
