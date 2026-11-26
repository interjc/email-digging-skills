// SQLite access (node:sqlite): open, migrate, back up. The database stays a single file
// (journal mode DELETE), so a backup or a copy is one file.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface OpenDbOpts {
  readonly?: boolean;
}

export function openDb(dbPath: string, opts: OpenDbOpts = {}): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly: opts.readonly === true });
  db.exec('PRAGMA foreign_keys = ON');
  // A read-only connection cannot change the journal mode; the writer already set it.
  if (opts.readonly !== true) db.exec('PRAGMA journal_mode = DELETE');
  return db;
}

const MIGRATION_FILE = /^(\d{4})_[A-Za-z0-9_.-]+\.sql$/;

/** Migration file names (without `.sql`) in `dir`, sorted by number. */
export function listMigrations(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => MIGRATION_FILE.test(f))
    .sort()
    .map((f) => f.slice(0, -'.sql'.length));
}

function hasMigrationsTable(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  return row !== undefined;
}

/**
 * Apply every `NNNN_*.sql` in `dir` that is not yet recorded in `schema_migrations`, in order, each in
 * its own transaction together with its bookkeeping row. The first migration creates the
 * `schema_migrations` table itself, so a fresh database is bootstrapped without special handling.
 * Returns the versions applied by this call (empty when up to date).
 */
export function migrate(db: DatabaseSync, dir: string): string[] {
  const applied = new Set<string>();
  if (hasMigrationsTable(db)) {
    for (const row of db.prepare('SELECT version FROM schema_migrations').all()) applied.add(row.version as string);
  }

  const done: string[] = [];
  for (const version of listMigrations(dir)) {
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(dir, `${version}.sql`), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${version} failed and was rolled back: ${err instanceof Error ? err.message : String(err)}`);
    }
    done.push(version);
  }
  return done;
}

/** UTC timestamp for backup names: yyyymmddThhmmssZ. */
export function backupStamp(d: Date = new Date()): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

const BACKUP_FILE = /^mail-list-(\d{8}T\d{6}Z)(?:-(\d+))?\.sqlite$/;

/**
 * Copy the database with `VACUUM INTO` to `<backupsDir>/mail-list-<UTC stamp>.sqlite`, then delete the
 * oldest backups beyond `keep`. Returns the new backup path, or null when the database does not exist.
 */
export function backupDb(dbPath: string, backupsDir: string, keep: number, now: Date = new Date()): string | null {
  if (!fs.existsSync(dbPath)) return null;
  fs.mkdirSync(backupsDir, { recursive: true });

  const stamp = backupStamp(now);
  // Same-second backups get the next number after the highest one present (not the first free name:
  // pruning may have removed the unsuffixed one, and reusing it would make a new backup look oldest).
  let highest = -1;
  for (const f of fs.readdirSync(backupsDir)) {
    const m = BACKUP_FILE.exec(f);
    if (m && m[1] === stamp) highest = Math.max(highest, m[2] === undefined ? 0 : Number(m[2]));
  }
  const target = path.join(backupsDir, highest < 0 ? `mail-list-${stamp}.sqlite` : `mail-list-${stamp}-${highest + 1}.sqlite`);

  const db = openDb(dbPath, { readonly: true });
  try {
    db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }

  // Oldest first: by timestamp, then by the same-second suffix as a number (-10 is newer than -2;
  // a name without suffix is the first of its second). Never delete the backup just created.
  const order = (f: string): [string, number] => {
    const m = BACKUP_FILE.exec(f);
    return [m?.[1] ?? '', m?.[2] === undefined ? 0 : Number(m[2])];
  };
  const backups = fs.readdirSync(backupsDir).filter((f) => BACKUP_FILE.test(f)).sort((a, b) => {
    const [ta, na] = order(a);
    const [tb, nb] = order(b);
    return ta === tb ? na - nb : ta < tb ? -1 : 1;
  });
  const excess = backups.length - Math.max(1, keep);
  const doomed = backups.slice(0, Math.max(0, excess)).filter((f) => path.join(backupsDir, f) !== target);
  for (const old of doomed) fs.rmSync(path.join(backupsDir, old), { force: true });

  return target;
}
