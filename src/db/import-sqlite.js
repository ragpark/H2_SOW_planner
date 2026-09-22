import { existsSync } from 'node:fs';
import { config } from '../config.js';
import { one, query, withTx } from './index.js';

const MIGRATION_NAME = 'import-sqlite-v1';

// Copied in dependency order so foreign keys are satisfied as we go.
const TABLES = [
  { name: 'users', columns: ['id', 'display_name', 'email', 'source', 'lti_issuer', 'lti_sub', 'created_at'] },
  { name: 'contexts', columns: ['id', 'title', 'label', 'source', 'lti_issuer', 'lti_context_id', 'created_at'] },
  {
    name: 'schemes',
    columns: [
      'id', 'owner_id', 'context_id', 'title', 'subject', 'key_stage', 'year_group',
      'academic_year', 'lessons_per_week', 'terms', 'notes', 'created_at', 'updated_at'
    ],
    json: ['terms']
  },
  {
    name: 'placements',
    columns: [
      'id', 'scheme_id', 'unit_id', 'position', 'term_index', 'week_in_term',
      'lessons_allocated', 'custom_title', 'notes'
    ]
  },
  { name: 'lesson_notes', columns: ['scheme_id', 'lesson_id', 'status', 'notes', 'updated_at'] },
  {
    name: 'lti_platforms',
    columns: [
      'id', 'name', 'issuer', 'client_id', 'auth_login_url', 'auth_token_url',
      'jwks_url', 'deployment_ids', 'created_at'
    ],
    json: ['deployment_ids']
  },
  { name: 'lti_keys', columns: ['kid', 'public_jwk', 'private_pkcs8', 'created_at'], json: ['public_jwk'] },
  {
    name: 'resource_links',
    columns: [
      'id', 'issuer', 'client_id', 'deployment_id', 'resource_link_id', 'scheme_id', 'view', 'created_at'
    ]
  }
];

/**
 * Copy a pre-Postgres SQLite database into Postgres, once.
 *
 * This exists because the service ran on SQLite on a mounted volume before
 * Postgres was added, and a teacher's schemes of work must not be lost in the
 * move. It is deliberately conservative: it runs only when the file exists and
 * the target is untouched, it records that it ran, and it never overwrites.
 *
 * Short-lived rows (sessions, handoffs, nonces, login state, launches) are not
 * copied — they expire in minutes or hours, and forcing a fresh sign-in is
 * better than importing state that is about to be invalid anyway.
 */
export async function importFromSqliteIfNeeded({ force = false } = {}) {
  if (!config.sqliteImportEnabled) return { skipped: 'disabled' };

  const already = await one('SELECT name FROM data_migrations WHERE name = $1', [MIGRATION_NAME]);
  if (already && !force) return { skipped: 'already-run' };

  const file = config.legacySqliteFile;
  if (!file || file === ':memory:' || !existsSync(file)) return { skipped: 'no-sqlite-file' };

  // Refuse to merge into a database that is already in use, so a redeploy
  // cannot resurrect or duplicate data.
  const { rows } = await query('SELECT count(*)::int AS n FROM schemes');
  if (rows[0].n > 0 && !force) return { skipped: 'postgres-not-empty' };

  let Database;
  try {
    ({ default: Database } = await import('better-sqlite3'));
  } catch {
    return { skipped: 'better-sqlite3-unavailable' };
  }

  const sqlite = new Database(file, { readonly: true, fileMustExist: true });
  const counts = {};
  try {
    const existingTables = new Set(
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
    );

    await withTx(async (client) => {
      for (const table of TABLES) {
        if (!existingTables.has(table.name)) continue;
        const sourceRows = sqlite.prepare(`SELECT * FROM ${table.name}`).all();
        if (!sourceRows.length) continue;

        const placeholders = table.columns.map((_, i) => `$${i + 1}`).join(', ');
        const casts = table.columns
          .map((c, i) => ((table.json || []).includes(c) ? `$${i + 1}::jsonb` : `$${i + 1}`))
          .join(', ');
        const sql =
          `INSERT INTO ${table.name} (${table.columns.join(', ')}) VALUES (${casts}) ` +
          'ON CONFLICT DO NOTHING';

        let copied = 0;
        for (const row of sourceRows) {
          const values = table.columns.map((c) => (row[c] === undefined ? null : row[c]));
          await client.query(sql, values);
          copied += 1;
        }
        counts[table.name] = copied;
        void placeholders;
      }

      await client.query(
        'INSERT INTO data_migrations (name, detail) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
        [MIGRATION_NAME, JSON.stringify({ file, counts })]
      );
    });
  } finally {
    sqlite.close();
  }

  return { imported: counts, file };
}

export { MIGRATION_NAME };
