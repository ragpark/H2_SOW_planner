import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const here = dirname(fileURLToPath(import.meta.url));

let db = null;

/**
 * A mounted volume is owned by root until something claims it, so "cannot open
 * the database" is usually a permission problem rather than a missing file.
 * The raw SQLite error does not say that, so it is translated here.
 */
function describeOpenFailure(file, err) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'unknown';
  const gid = typeof process.getgid === 'function' ? process.getgid() : 'unknown';
  return new Error(
    `Cannot open the database at ${file} (${err.code || err.message}). ` +
      `This process runs as uid ${uid}, gid ${gid}. ` +
      'Check that the directory exists and is writable by that user — a mounted volume ' +
      'is owned by root until the container takes ownership of it.',
    { cause: err }
  );
}

export function getDb() {
  if (db) return db;
  const file = config.databaseFile;
  try {
    if (file !== ':memory:') {
      const dir = dirname(file);
      // Only create the directory when it is genuinely missing. mkdir on a
      // directory that already exists fails with EACCES (not EEXIST) when the
      // process cannot write to its PARENT — which is exactly the case for a
      // volume mounted at the filesystem root, such as /data.
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    db = new Database(file);
  } catch (err) {
    if (err.code === 'SQLITE_CANTOPEN' || err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS') {
      throw describeOpenFailure(file, err);
    }
    throw err;
  }
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  return db;
}

/** Test helper: point the module at a fresh in-memory database. */
export function resetDbForTests() {
  if (db) db.close();
  db = null;
  config.databaseFile = ':memory:';
  return getDb();
}

/** Housekeeping for the short-lived LTI and session tables. */
export function pruneExpired(now = new Date()) {
  const d = getDb();
  const cutoff = new Date(now.getTime() - 15 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  d.prepare('DELETE FROM lti_login_state WHERE created_at < ?').run(cutoff);
  d.prepare('DELETE FROM lti_used_nonces WHERE created_at < ?').run(dayAgo);
  d.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
}

/** Close the database, checkpointing the write-ahead log. */
export function closeDb() {
  if (!db) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  } catch (err) {
    console.error('error closing database:', err.message);
  }
  db = null;
}
