import { randomBytes, randomUUID } from 'node:crypto';
import { one, query } from '../db/index.js';

const SESSION_TTL_HOURS = 12;
const HANDOFF_TTL_SECONDS = 120;

const token = () => randomBytes(32).toString('base64url');

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

export async function upsertLtiUser({ issuer, sub, name, email }) {
  const displayName = name || email || 'Teacher';
  // The partial unique index on (lti_issuer, lti_sub) makes this atomic, so a
  // burst of simultaneous launches from one user cannot create duplicates.
  return one(
    `INSERT INTO users (id, display_name, email, source, lti_issuer, lti_sub)
     VALUES ($1, $2, $3, 'lti', $4, $5)
     ON CONFLICT (lti_issuer, lti_sub) WHERE lti_issuer IS NOT NULL
     DO UPDATE SET display_name = EXCLUDED.display_name, email = EXCLUDED.email
     RETURNING *`,
    [randomUUID(), displayName, email || null, issuer, sub]
  );
}

export async function createLocalUser({ displayName, email }) {
  return one(
    `INSERT INTO users (id, display_name, email, source)
     VALUES ($1, $2, $3, 'local') RETURNING *`,
    [randomUUID(), displayName || 'Teacher', email || null]
  );
}

export async function upsertLtiContext({ issuer, contextId, title, label }) {
  if (!contextId) return null;
  const resolvedTitle = title || label || 'Course';
  return one(
    `INSERT INTO contexts (id, title, label, source, lti_issuer, lti_context_id)
     VALUES ($1, $2, $3, 'lti', $4, $5)
     ON CONFLICT (lti_issuer, lti_context_id) WHERE lti_issuer IS NOT NULL
     DO UPDATE SET title = EXCLUDED.title, label = EXCLUDED.label
     RETURNING *`,
    [randomUUID(), resolvedTitle, label || null, issuer, contextId]
  );
}

export async function createSession({ userId, contextId = null, roles = [], source = 'local' }) {
  const id = token();
  const row = await one(
    `INSERT INTO sessions (id, user_id, context_id, roles, source, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, now() + ($6 || ' hours')::interval)
     RETURNING expires_at`,
    [id, userId, contextId, JSON.stringify(roles), source, String(SESSION_TTL_HOURS)]
  );
  return { id, expiresAt: row.expires_at };
}

export async function getSession(sessionId) {
  if (!sessionId) return null;
  const row = await one(
    `SELECT s.id, s.source, s.roles,
            u.id AS user_id, u.display_name, u.email, u.source AS user_source,
            c.id AS context_id, c.title AS context_title, c.label AS context_label,
            c.source AS context_source
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN contexts c ON c.id = s.context_id
      WHERE s.id = $1 AND s.expires_at > now()`,
    [sessionId]
  );
  if (!row) return null;
  const roles = row.roles || [];
  return {
    id: row.id,
    source: row.source,
    roles,
    permissions:
      row.source === 'lti'
        ? rolesToPermissions(roles)
        : { role: 'teacher', canEdit: true, canConfigure: true },
    user: {
      id: row.user_id,
      displayName: row.display_name,
      email: row.email,
      source: row.user_source
    },
    context: row.context_id
      ? {
          id: row.context_id,
          title: row.context_title,
          label: row.context_label,
          source: row.context_source
        }
      : null
  };
}

export async function destroySession(sessionId) {
  await query('DELETE FROM sessions WHERE id = $1', [sessionId]);
}

/**
 * Mint a single-use token that the browser exchanges for its session. Used to
 * carry an LTI launch into the SPA when third-party cookies are unavailable.
 */
export async function createHandoff(sessionId, target = null) {
  const t = token();
  await query(
    `INSERT INTO session_handoffs (token, session_id, target, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)`,
    [t, sessionId, target, String(HANDOFF_TTL_SECONDS)]
  );
  return t;
}

export async function redeemHandoff(handoffToken) {
  if (!handoffToken) return null;
  // Deleting and returning in one statement makes redemption atomic: two
  // simultaneous exchanges cannot both succeed.
  const row = await one(
    `DELETE FROM session_handoffs
      WHERE token = $1 AND expires_at > now()
      RETURNING session_id, target`,
    [handoffToken]
  );
  if (!row) return null;
  const session = await getSession(row.session_id);
  return session ? { session, target: row.target } : null;
}

