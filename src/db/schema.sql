PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  email         TEXT,
  source        TEXT NOT NULL CHECK (source IN ('local', 'lti')),
  lti_issuer    TEXT,
  lti_sub       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS users_lti_identity ON users (lti_issuer, lti_sub)
  WHERE lti_issuer IS NOT NULL;

-- A teaching context: an LMS course, or a locally created class in standalone mode.
CREATE TABLE IF NOT EXISTS contexts (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  label           TEXT,
  source          TEXT NOT NULL CHECK (source IN ('local', 'lti')),
  lti_issuer      TEXT,
  lti_context_id  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS contexts_lti_identity ON contexts (lti_issuer, lti_context_id)
  WHERE lti_issuer IS NOT NULL;

CREATE TABLE IF NOT EXISTS schemes (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  context_id       TEXT REFERENCES contexts (id) ON DELETE SET NULL,
  title            TEXT NOT NULL,
  subject          TEXT NOT NULL DEFAULT 'chemistry',
  key_stage        TEXT NOT NULL DEFAULT 'KS3',
  year_group       INTEGER NOT NULL DEFAULT 9,
  academic_year    TEXT,
  lessons_per_week INTEGER NOT NULL DEFAULT 2,
  terms            TEXT NOT NULL,            -- JSON: [{ name, weeks }]
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS schemes_owner ON schemes (owner_id);
CREATE INDEX IF NOT EXISTS schemes_context ON schemes (context_id);

-- A unit placed at a point in the scheme's calendar.
CREATE TABLE IF NOT EXISTS placements (
  id                TEXT PRIMARY KEY,
  scheme_id         TEXT NOT NULL REFERENCES schemes (id) ON DELETE CASCADE,
  unit_id           TEXT NOT NULL,
  position          INTEGER NOT NULL,
  term_index        INTEGER NOT NULL,
  week_in_term      INTEGER NOT NULL,
  lessons_allocated INTEGER NOT NULL,
  custom_title      TEXT,
  notes             TEXT
);
CREATE INDEX IF NOT EXISTS placements_scheme ON placements (scheme_id, position);

-- Per-lesson teacher annotations within a scheme.
CREATE TABLE IF NOT EXISTS lesson_notes (
  scheme_id   TEXT NOT NULL REFERENCES schemes (id) ON DELETE CASCADE,
  lesson_id   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'planned'
                CHECK (status IN ('planned', 'ready', 'taught', 'skipped')),
  notes       TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scheme_id, lesson_id)
);

-- ---------- LTI 1.3 ----------

CREATE TABLE IF NOT EXISTS lti_platforms (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  issuer          TEXT NOT NULL,
  client_id       TEXT NOT NULL,
  auth_login_url  TEXT NOT NULL,
  auth_token_url  TEXT NOT NULL,
  jwks_url        TEXT NOT NULL,
  deployment_ids  TEXT NOT NULL DEFAULT '[]',   -- JSON array
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (issuer, client_id)
);

-- The tool's own signing keypair, used for client_assertion and Deep Linking responses.
CREATE TABLE IF NOT EXISTS lti_keys (
  kid          TEXT PRIMARY KEY,
  public_jwk   TEXT NOT NULL,
  private_pkcs8 TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Short-lived OIDC login state, consumed once on launch.
CREATE TABLE IF NOT EXISTS lti_login_state (
  state           TEXT PRIMARY KEY,
  nonce           TEXT NOT NULL,
  issuer          TEXT NOT NULL,
  client_id       TEXT,
  target_link_uri TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Nonces already seen, to reject replayed id_tokens.
CREATE TABLE IF NOT EXISTS lti_used_nonces (
  nonce      TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Binds an LMS resource link (a place in a course) to a scheme, so relaunching
-- the same link reopens the same scheme of work.
CREATE TABLE IF NOT EXISTS resource_links (
  id               TEXT PRIMARY KEY,
  issuer           TEXT NOT NULL,
  client_id        TEXT NOT NULL,
  deployment_id    TEXT NOT NULL,
  resource_link_id TEXT NOT NULL,
  scheme_id        TEXT REFERENCES schemes (id) ON DELETE SET NULL,
  view             TEXT NOT NULL DEFAULT 'scheme',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (issuer, client_id, deployment_id, resource_link_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  context_id  TEXT REFERENCES contexts (id) ON DELETE SET NULL,
  roles       TEXT NOT NULL DEFAULT '[]',
  source      TEXT NOT NULL DEFAULT 'local',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);

-- One-time tokens handing a session from an LTI launch redirect to the SPA.
-- LTI tools run in an iframe, where third-party cookies are frequently blocked,
-- so the browser session cannot be established by cookie alone.
CREATE TABLE IF NOT EXISTS session_handoffs (
  token      TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  target     TEXT,
  expires_at TEXT NOT NULL
);

-- The validated claims of a launch, kept for the life of the session so the
-- SPA can ask what kind of launch it is and where to post a deep link back to.
CREATE TABLE IF NOT EXISTS lti_launches (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  summary    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS lti_launches_session ON lti_launches (session_id);
