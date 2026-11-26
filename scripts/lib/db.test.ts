import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupDb, backupStamp, listMigrations, migrate, openDb } from './db.ts';
import { repoRoot } from './paths.ts';

const MIGRATIONS = path.join(repoRoot(), 'schema', 'migrations');

function tmpDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'db-test-')));
}

test('openDb: foreign keys on, journal mode DELETE, file created', () => {
  const file = path.join(tmpDir(), 'a.sqlite');
  const db = openDb(file);
  assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
  assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'delete');
  db.close();
  assert.ok(fs.existsSync(file));
});

test('openDb readonly: reads work, writes fail', () => {
  const file = path.join(tmpDir(), 'a.sqlite');
  const w = openDb(file);
  migrate(w, MIGRATIONS);
  w.close();
  const r = openDb(file, { readonly: true });
  assert.ok((r.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n as number) >= 2);
  assert.throws(() => r.exec("INSERT INTO schema_migrations VALUES ('x', 'y')"), /readonly/i);
  r.close();
});

test('migrate applies every migration in order on a fresh database, bootstrapping schema_migrations', () => {
  const db = openDb(path.join(tmpDir(), 'a.sqlite'));
  const expected = listMigrations(MIGRATIONS);
  assert.ok(expected.length >= 2);
  assert.deepEqual(expected.slice(0, 2), ['0001_init', '0002_views']);
  assert.deepEqual(migrate(db, MIGRATIONS), expected);
  const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);
  assert.deepEqual(versions, expected);
  // schema from 0001 and views from 0002 exist
  const names = db.prepare("SELECT name FROM sqlite_master WHERE name IN ('contacts', 'v_sendable_strict', 'v_not_blocked')").all();
  assert.equal(names.length, 3);
  db.close();
});

test('migrate twice is a no-op', () => {
  const db = openDb(path.join(tmpDir(), 'a.sqlite'));
  migrate(db, MIGRATIONS);
  const before = db.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version').all();
  assert.deepEqual(migrate(db, MIGRATIONS), []);
  const after = db.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version').all();
  assert.deepEqual(after, before);
  db.close();
});

test('migrate applies only the migrations not yet recorded', () => {
  const dir = tmpDir();
  fs.copyFileSync(path.join(MIGRATIONS, '0001_init.sql'), path.join(dir, '0001_init.sql'));
  const db = openDb(path.join(tmpDir(), 'a.sqlite'));
  assert.deepEqual(migrate(db, dir), ['0001_init']);
  fs.writeFileSync(path.join(dir, '0003_extra.sql'), 'CREATE TABLE extra (id INTEGER PRIMARY KEY);\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'not a migration\n');
  assert.deepEqual(migrate(db, dir), ['0003_extra']);
  assert.deepEqual(migrate(db, dir), []);
  db.close();
});

test('a failing migration is rolled back together with its bookkeeping row', () => {
  const dir = tmpDir();
  fs.copyFileSync(path.join(MIGRATIONS, '0001_init.sql'), path.join(dir, '0001_init.sql'));
  fs.writeFileSync(path.join(dir, '0002_bad.sql'), 'CREATE TABLE half (id INTEGER);\nTHIS IS NOT SQL;\n');
  const db = openDb(path.join(tmpDir(), 'a.sqlite'));
  assert.throws(() => migrate(db, dir), /0002_bad.*rolled back/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'half'").get()?.n, 0);
  assert.deepEqual(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version), ['0001_init']);
  db.close();
});

test('the database stays one file after writes and migrations', () => {
  const dir = tmpDir();
  const db = openDb(path.join(dir, 'a.sqlite'));
  migrate(db, MIGRATIONS);
  db.close();
  assert.deepEqual(fs.readdirSync(dir), ['a.sqlite']);
});

test('backupStamp is UTC yyyymmddThhmmssZ', () => {
  assert.equal(backupStamp(new Date('2026-11-26T09:08:07.654Z')), '20261126T090807Z');
});

test('backupDb returns null when the database does not exist and creates nothing', () => {
  const dir = tmpDir();
  assert.equal(backupDb(path.join(dir, 'none.sqlite'), path.join(dir, 'backups'), 5), null);
  assert.ok(!fs.existsSync(path.join(dir, 'backups')));
});

test('backupDb writes a readable VACUUM INTO copy with the UTC-stamped name', () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'a.sqlite');
  const db = openDb(dbPath);
  migrate(db, MIGRATIONS);
  db.close();
  const out = backupDb(dbPath, path.join(dir, 'backups'), 5, new Date('2026-11-26T09:08:07Z'));
  assert.equal(out, path.join(dir, 'backups', 'mail-list-20261126T090807Z.sqlite'));
  const copy = openDb(out as string, { readonly: true });
  assert.ok((copy.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n as number) >= 2);
  copy.close();
  assert.deepEqual(fs.readdirSync(path.join(dir, 'backups')), ['mail-list-20261126T090807Z.sqlite']);
});

test('backupDb prunes the oldest backups beyond keep, ignores unrelated files, handles same-second ties', () => {
  const dir = tmpDir();
  const backups = path.join(dir, 'backups');
  const dbPath = path.join(dir, 'a.sqlite');
  const db = openDb(dbPath);
  migrate(db, MIGRATIONS);
  db.close();

  fs.mkdirSync(backups);
  fs.writeFileSync(path.join(backups, 'notes.txt'), 'keep me');
  const times = ['2026-01-01T00:00:01Z', '2026-01-01T00:00:02Z', '2026-01-01T00:00:03Z', '2026-01-01T00:00:04Z'];
  for (const t of times) backupDb(dbPath, backups, 3, new Date(t));
  const sqliteFiles = () => fs.readdirSync(backups).filter((f) => f.endsWith('.sqlite')).sort();
  assert.deepEqual(sqliteFiles(), [
    'mail-list-20260101T000002Z.sqlite', 'mail-list-20260101T000003Z.sqlite', 'mail-list-20260101T000004Z.sqlite',
  ]);
  assert.ok(fs.existsSync(path.join(backups, 'notes.txt')));

  // Two backups in the same second: the second gets a suffix, and the older (-less) one is pruned first.
  backupDb(dbPath, backups, 3, new Date('2026-01-01T00:00:04Z'));
  assert.deepEqual(sqliteFiles(), [
    'mail-list-20260101T000003Z.sqlite', 'mail-list-20260101T000004Z-1.sqlite', 'mail-list-20260101T000004Z.sqlite',
  ]);
});
