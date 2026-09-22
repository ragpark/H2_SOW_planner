import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import pg from 'pg';

/**
 * The service stored data in SQLite on a volume before Postgres was added.
 * A teacher's schemes of work must survive that move, so the one-time import
 * is exercised against a real SQLite file and a real Postgres database.
 */
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres@127.0.0.1:5433/postgres';
const dbName = `sow_import_${Math.random().toString(36).slice(2, 10)}`;

let sqlitePath;
let db;
let importer;

/** Build a SQLite file shaped like the one the old version wrote. */
function buildLegacySqlite(path) {
  const s = new Database(path);
  s.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, email TEXT,
      source TEXT NOT NULL, lti_issuer TEXT, lti_sub TEXT, created_at TEXT NOT NULL);
    CREATE TABLE contexts (id TEXT PRIMARY KEY, title TEXT NOT NULL, label TEXT,
      source TEXT NOT NULL, lti_issuer TEXT, lti_context_id TEXT, created_at TEXT NOT NULL);
    CREATE TABLE schemes (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, context_id TEXT,
      title TEXT NOT NULL, subject TEXT NOT NULL, key_stage TEXT NOT NULL, year_group INTEGER NOT NULL,
      academic_year TEXT, lessons_per_week INTEGER NOT NULL, terms TEXT NOT NULL, notes TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE placements (id TEXT PRIMARY KEY, scheme_id TEXT NOT NULL, unit_id TEXT NOT NULL,
      position INTEGER NOT NULL, term_index INTEGER NOT NULL, week_in_term INTEGER NOT NULL,
      lessons_allocated INTEGER NOT NULL, custom_title TEXT, notes TEXT);
    CREATE TABLE lesson_notes (scheme_id TEXT NOT NULL, lesson_id TEXT NOT NULL, status TEXT NOT NULL,
      notes TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (scheme_id, lesson_id));
  `);
  const userId = randomUUID();
  const schemeId = randomUUID();
  const now = '2026-09-22 17:21:21';
  s.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run(userId, 'Miss Hart', null, 'local', null, null, now);
  s.prepare('INSERT INTO schemes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    schemeId, userId, null, 'Year 9 Chemistry', 'chemistry', 'KS3', 9, '2026/27', 2,
    JSON.stringify([{ name: 'Autumn 1', weeks: 7 }]), 'Set 2 notes', now, now
  );
  s.prepare('INSERT INTO placements VALUES (?,?,?,?,?,?,?,?,?)').run(
    randomUUID(), schemeId, 'u-particles', 0, 0, 1, 7, null, null
  );
  s.prepare('INSERT INTO lesson_notes VALUES (?,?,?,?,?)').run(
    schemeId, 'u-particles.l2', 'ready', 'Book the trolleys', now
  );
  s.close();
  return { userId, schemeId };
}

let seeded;

before(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  sqlitePath = join(mkdtempSync(join(tmpdir(), 'sow-legacy-')), 'sow.db');
  seeded = buildLegacySqlite(sqlitePath);

  process.env.DATABASE_URL = url.toString();
  process.env.SQLITE_IMPORT_PATH = sqlitePath;
  delete process.env.SQLITE_IMPORT;

  db = await import('../src/db/index.js');
  importer = await import('../src/db/import-sqlite.js');
  await db.migrate();
});

after(async () => {
  await db.closeDb();
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

test('a pre-Postgres SQLite file is imported into an empty database', async () => {
  const result = await importer.importFromSqliteIfNeeded();
  assert.ok(result.imported, `expected an import, got ${JSON.stringify(result)}`);
  assert.equal(result.imported.users, 1);
  assert.equal(result.imported.schemes, 1);
  assert.equal(result.imported.placements, 1);
  assert.equal(result.imported.lesson_notes, 1);

  const scheme = await db.one('SELECT * FROM schemes WHERE id = $1', [seeded.schemeId]);
  assert.equal(scheme.title, 'Year 9 Chemistry');
  assert.equal(scheme.academic_year, '2026/27');
  assert.equal(scheme.notes, 'Set 2 notes');
  // The terms column was TEXT in SQLite and is JSONB here; it must arrive parsed.
  assert.deepEqual(scheme.terms, [{ name: 'Autumn 1', weeks: 7 }]);

  const note = await db.one('SELECT * FROM lesson_notes WHERE lesson_id = $1', ['u-particles.l2']);
  assert.equal(note.status, 'ready');
  assert.equal(note.notes, 'Book the trolleys');
});

test('the import does not run twice, so a redeploy cannot duplicate data', async () => {
  const second = await importer.importFromSqliteIfNeeded();
  assert.equal(second.skipped, 'already-run');
  const { rows } = await db.query('SELECT count(*)::int AS n FROM schemes');
  assert.equal(rows[0].n, 1);
});

test('the import refuses to merge into a database that is already in use', async () => {
  await db.query('DELETE FROM data_migrations');
  const result = await importer.importFromSqliteIfNeeded();
  assert.equal(result.skipped, 'postgres-not-empty');
  const { rows } = await db.query('SELECT count(*)::int AS n FROM schemes');
  assert.equal(rows[0].n, 1, 'nothing was duplicated');
});

test('the import is skipped when there is no legacy file', async () => {
  // The importer reads the shared config instance, so point that at a path
  // that does not exist rather than trying to re-import a separate copy.
  const cfg = await import('../src/config.js');
  const saved = cfg.config.legacySqliteFile;
  cfg.config.legacySqliteFile = '/nonexistent/sow.db';
  await db.query('DELETE FROM data_migrations');
  await db.query('DELETE FROM schemes');

  const result = await importer.importFromSqliteIfNeeded();
  assert.equal(result.skipped, 'no-sqlite-file');

  cfg.config.legacySqliteFile = saved;
});

test('the import can be switched off entirely', async () => {
  const cfg = await import('../src/config.js');
  const saved = cfg.config.sqliteImportEnabled;
  cfg.config.sqliteImportEnabled = false;

  const result = await importer.importFromSqliteIfNeeded();
  assert.equal(result.skipped, 'disabled');

  cfg.config.sqliteImportEnabled = saved;
});
