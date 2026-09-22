import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const here = dirname(fileURLToPath(import.meta.url));

let db = null;

export function getDb() {
  if (db) return db;
  const file = config.databaseFile;
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  db = new Database(file);
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
