import { randomBytes, randomUUID } from 'node:crypto';
import { getDb } from '../db/index.js';

const SESSION_TTL_HOURS = 12;
const HANDOFF_TTL_SECONDS = 120;

const token = () => randomBytes(32).toString('base64url');

const sqlTime = (date) => date.toISOString().replace('T', ' ').slice(0, 19);

/** LTI role URIs that should be able to edit a scheme of work. */
const STAFF_ROLE_FRAGMENTS = [
  'Instructor',
  'ContentDeveloper',
  'TeachingAssistant',
  'Mentor',
  'Administrator',
  'Manager',
  'Faculty',
  'Staff'
];

export function rolesToPermissions(roles = []) {
  const isStaff = roles.some((r) => STAFF_ROLE_FRAGMENTS.some((frag) => r.includes(frag)));
  return {
    role: isStaff ? 'teacher' : 'student',
    canEdit: isStaff,
    canConfigure: roles.some((r) => r.includes('Administrator') || r.includes('Manager'))
  };
}

export function upsertLtiUser({ issuer, sub, name, email }) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM users WHERE lti_issuer = ? AND lti_sub = ?').get(issuer, sub);
  const displayName = name || email || 'Teacher';
  if (existing) {
    db.prepare('UPDATE users SET display_name = ?, email = ? WHERE id = ?').run(displayName, email || null, existing.id);
    return { ...existing, display_name: displayName, email: email || null };
  }
  const id = randomUUID();
  db.prepare(
    'INSERT INTO users (id, display_name, email, source, lti_issuer, lti_sub) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, displayName, email || null, 'lti', issuer, sub);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function createLocalUser({ displayName, email }) {
  const db = getDb();
  const id = randomUUID();
  db.prepare('INSERT INTO users (id, display_name, email, source) VALUES (?, ?, ?, ?)').run(
    id,
    displayName || 'Teacher',
    email || null,
    'local'
  );
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function upsertLtiContext({ issuer, contextId, title, label }) {
  const db = getDb();
  if (!contextId) return null;
  const existing = db
    .prepare('SELECT * FROM contexts WHERE lti_issuer = ? AND lti_context_id = ?')
    .get(issuer, contextId);
  const resolvedTitle = title || label || 'Course';
  if (existing) {
    db.prepare('UPDATE contexts SET title = ?, label = ? WHERE id = ?').run(resolvedTitle, label || null, existing.id);
    return { ...existing, title: resolvedTitle, label: label || null };
  }
  const id = randomUUID();
  db.prepare(
    'INSERT INTO contexts (id, title, label, source, lti_issuer, lti_context_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, resolvedTitle, label || null, 'lti', issuer, contextId);
  return db.prepare('SELECT * FROM contexts WHERE id = ?').get(id);
}

export function createSession({ userId, contextId = null, roles = [], source = 'local' }) {
  const db = getDb();
  const id = token();
  const expiresAt = sqlTime(new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000));
  db.prepare(
    'INSERT INTO sessions (id, user_id, context_id, roles, source, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, userId, contextId, JSON.stringify(roles), source, expiresAt);
  return { id, expiresAt };
}

export function getSession(sessionId) {
  if (!sessionId) return null;
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM sessions WHERE id = ? AND expires_at > datetime('now')")
    .get(sessionId);
  if (!row) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!user) return null;
  const context = row.context_id
    ? db.prepare('SELECT * FROM contexts WHERE id = ?').get(row.context_id)
    : null;
  const roles = JSON.parse(row.roles);
  return {
    id: row.id,
    source: row.source,
    roles,
    permissions: row.source === 'lti' ? rolesToPermissions(roles) : { role: 'teacher', canEdit: true, canConfigure: true },
    user: { id: user.id, displayName: user.display_name, email: user.email, source: user.source },
    context: context ? { id: context.id, title: context.title, label: context.label, source: context.source } : null
  };
}

export function destroySession(sessionId) {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

/**
 * Mint a single-use token that the browser exchanges for its session. Used to
 * carry an LTI launch into the SPA when third-party cookies are unavailable.
 */
export function createHandoff(sessionId, target = null) {
  const db = getDb();
  const t = token();
  const expiresAt = sqlTime(new Date(Date.now() + HANDOFF_TTL_SECONDS * 1000));
  db.prepare('INSERT INTO session_handoffs (token, session_id, target, expires_at) VALUES (?, ?, ?, ?)').run(
    t,
    sessionId,
    target,
    expiresAt
  );
  return t;
}

export function redeemHandoff(handoffToken) {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM session_handoffs WHERE token = ? AND expires_at > datetime('now')")
    .get(handoffToken);
  if (!row) return null;
  db.prepare('DELETE FROM session_handoffs WHERE token = ?').run(handoffToken);
  const session = getSession(row.session_id);
  return session ? { session, target: row.target } : null;
}
