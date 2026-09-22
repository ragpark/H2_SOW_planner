import { randomBytes } from 'node:crypto';

const bool = (v, fallback = false) =>
  v === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

export const config = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  // Public base URL of this tool. LTI redirect URIs are derived from it.
  toolUrl: (process.env.TOOL_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),
  databaseFile: process.env.DATABASE_FILE || 'data/sow.db',
  // Session cookies are signed with this. Generated per-boot in dev so the app
  // runs with zero configuration; must be set explicitly in production.
  sessionSecret: process.env.SESSION_SECRET || randomBytes(32).toString('hex'),
  // Standalone mode lets a teacher use the planner without an LMS. Disable it
  // when the tool is deployed purely as an LTI tool.
  standaloneEnabled: bool(process.env.STANDALONE_ENABLED, true),
  lti: {
    enabled: bool(process.env.LTI_ENABLED, true),
    // Tool's own keypair (PKCS#8 PEM). Generated and stored in the DB if absent.
    keyId: process.env.LTI_KEY_ID || 'h2-sow-planner-key-1',
    // Clock skew tolerance when validating platform JWTs, in seconds.
    clockToleranceSec: Number(process.env.LTI_CLOCK_TOLERANCE || 60)
  }
};

export function assertProductionConfig(cfg = config) {
  const problems = [];
  if (cfg.nodeEnv === 'production') {
    if (!process.env.SESSION_SECRET) problems.push('SESSION_SECRET must be set in production');
    if (!process.env.TOOL_URL) problems.push('TOOL_URL must be set in production');
    if (cfg.toolUrl.startsWith('http://') && !cfg.toolUrl.startsWith('http://localhost')) {
      problems.push('TOOL_URL must use https in production');
    }
  }
  return problems;
}
