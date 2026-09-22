import { config } from '../config.js';
import { getSession } from '../services/identity.js';

export const SESSION_COOKIE = 'sow_session';

/** Cookies must be SameSite=None to survive an LTI launch inside an iframe. */
export function sessionCookieOptions() {
  const secure = config.toolUrl.startsWith('https://');
  return {
    httpOnly: true,
    sameSite: secure ? 'none' : 'lax',
    secure,
    path: '/',
    maxAge: 12 * 60 * 60 * 1000
  };
}

/**
 * Resolve the caller's session. The bearer token is checked first: an LTI tool
 * in an iframe often cannot read its own cookie, so the SPA holds the session
 * token itself and sends it explicitly.
 */
export async function attachSession(req, _res, next) {
  const header = req.get('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  try {
    req.session = (await getSession(bearer || req.cookies?.[SESSION_COOKIE])) || null;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireSession(req, res, next) {
  if (!req.session) return res.status(401).json({ error: 'not signed in' });
  next();
}

export function requireEditor(req, res, next) {
  if (!req.session) return res.status(401).json({ error: 'not signed in' });
  if (!req.session.permissions.canEdit) {
    return res.status(403).json({ error: 'this launch is read-only' });
  }
  next();
}
