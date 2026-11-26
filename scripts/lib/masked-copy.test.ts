import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { migrate, openDb } from './db.ts';
import { hmacLocalPart } from './mask.ts';
import { writeMaskedCopy } from './masked-copy.ts';
import { layoutDirs, workspaceLayout } from './paths.ts';

const migrations = path.resolve(import.meta.dirname, '../../schema/migrations');

test('masked copy is deterministic, preserves constraints, and never copies raw addresses or names', (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'mask-copy-test-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const layout = workspaceLayout(ws);
  for (const dir of layoutDirs(layout)) fs.mkdirSync(dir, { recursive: true });
  const source = openDb(layout.dbPath);
  migrate(source, migrations);
  source.exec(`
    INSERT INTO sources (name, label, kind, priority, updated_at) VALUES ('one', 'Alice Example', 'other', 1, '2026');
    INSERT INTO contacts (id, email, email_domain, name, locale, email_status, flags, suggested_email, created_at, updated_at)
      VALUES (1, 'alice@example.con', 'example.con', 'Alice Example', 'ja', 'typo_suspect', '["typo_suspect"]', 'alice@example.com', '2026', '2026'),
        (2, 'bob@example.org', 'example.org', 'Bob Example', NULL, 'valid', '[]', NULL, '2026', '2026');
    INSERT INTO contact_sources (contact_id, source, raw_email, raw_fields, files) VALUES
      (1, 'one', 'Alice Example <ALICE＠example.con>', '{"label":"Alice Example","primary":"mail to alice@example.con","nullable":null}', '["source.csv"]'),
      (2, 'one', 'Bob <bob@example.org>', '{"label":"Bob Example","nullable":"010-0000-1212"}', '["source.csv"]');
    INSERT INTO consents (contact_id, source, status, evidence) VALUES
      (1, 'one', 'granted', '{"value":"Ｙｅｓ","file":"source.csv","row_number":1}'),
      (2, 'one', 'unknown', '{"value":"Bob Example bob@example.org","column":"consent"}');
    INSERT INTO suppressions (id, email, reason, source, note, created_at)
      VALUES (1, 'alice@example.con', 'manual', 'override', 'Alice Example alice@example.com', '2026');
    INSERT INTO runs (id, command, started_at, status, report_path)
      VALUES ('demo', 'clean-and-merge', '2026', 'ok', 'Alice Example.md');
    INSERT INTO rejected_rows (run_id, source, file, row_number, raw_value, reason)
      VALUES ('demo', 'one', 'source.csv', 3, 'Bob Example', 'invalid_syntax');
    INSERT INTO imports (run_id, source, file, sha256, encoding, rows_read, imported_at)
      VALUES ('demo', 'one', 'source.csv', 'hash', 'cp932', 2, '2025'), ('demo', 'one', 'source.csv', 'hash', 'utf-8', 3, '2026');
    INSERT INTO sync_log (provider, direction, dry_run, started_at, counts, status)
      VALUES ('listmonk', 'push', 1, '2026', '{"to_add":2}', 'ok');
  `);
  source.close();
  const originals = fs.readFileSync(layout.dbPath);
  const key = 'fixture-mask-key';
  const kept = writeMaskedCopy(layout, migrations, { key, keepDomain: true, shape: true });
  const first = fs.readFileSync(kept.masked_db);
  const firstShape = fs.readFileSync(kept.shape_file!);
  const repeated = writeMaskedCopy(layout, migrations, { key, keepDomain: true, shape: true });
  assert.deepEqual(fs.readFileSync(repeated.masked_db), first);
  assert.deepEqual(fs.readFileSync(repeated.shape_file!), firstShape);
  const verify = (dbPath: string) => {
    const db = openDb(dbPath, { readonly: true });
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    for (const table of Object.keys(kept.rows)) {
      const rows = db.prepare(`SELECT * FROM ${table}`).all();
      assert.equal(rows.length, kept.rows[table]);
      for (const row of rows) for (const cell of Object.values(row)) {
        if (typeof cell === 'string') assert.doesNotMatch(cell, /(?:alice|bob)[＠@]|(?:Alice|Bob) Example/i);
      }
    }
    return db;
  };
  const copy = verify(kept.masked_db);
  const maskedAlice = hmacLocalPart('alice@example.con', key);
  assert.equal(copy.prepare('SELECT email FROM contacts WHERE id = 1').get()?.email, maskedAlice);
  assert.equal(copy.prepare('SELECT email FROM suppressions').get()?.email, maskedAlice);
  assert.equal(copy.prepare('SELECT raw_email FROM contact_sources WHERE contact_id = 1').get()?.raw_email, maskedAlice);
  assert.deepEqual(JSON.parse(String(copy.prepare('SELECT raw_fields FROM contact_sources WHERE contact_id = 1').get()?.raw_fields)),
    { label: '', primary: maskedAlice, nullable: null });
  assert.equal(copy.prepare('SELECT suggested_email FROM contacts WHERE id = 1').get()?.suggested_email, hmacLocalPart('alice@example.com', key));
  assert.equal(copy.prepare('SELECT name FROM contacts WHERE id = 1').get()?.name, null);
  assert.equal(copy.prepare('SELECT raw_value FROM rejected_rows').get()?.raw_value, '<redacted len=11>');
  assert.deepEqual(copy.prepare("SELECT json_extract(evidence, '$.value') AS value FROM consents ORDER BY contact_id").all().map((r) => r.value),
    ['Ｙｅｓ', '']);
  copy.close();

  const shape = JSON.parse(firstShape.toString('utf8'));
  const [one] = shape.sources;
  assert.equal(one.rows_read, 3);
  assert.deepEqual(one.encodings, ['utf-8']);
  assert.deepEqual(one.columns, ['label', 'nullable', 'primary']);
  assert.deepEqual(one.null_rates, { label: 0, nullable: 0.5, primary: 0.5 });
  assert.equal(one.files[0].encoding, 'utf-8');
  assert.equal(one.files[0].rows_read, 3);
  assert.deepEqual(one.files[0].null_rates, one.null_rates);
  assert.deepEqual(one.files[0].reject_reasons, { invalid_syntax: 1 });
  assert.deepEqual(one.files[0].statuses, { typo_suspect: 1, valid: 1 });
  assert.deepEqual(one.files[0].flags, { typo_suspect: 1 });
  assert.doesNotMatch(firstShape.toString('utf8'), /example\.(com|con|org)|Alice|Bob|010-0000-1212/);

  const hashed = writeMaskedCopy(layout, migrations, { key, keepDomain: false, shape: false });
  const copyHashed = verify(hashed.masked_db);
  const hashedAlice = hmacLocalPart('alice@example.con', key, { keepDomain: false });
  assert.equal(copyHashed.prepare('SELECT email FROM contacts WHERE id = 1').get()?.email, hashedAlice);
  assert.equal(copyHashed.prepare('SELECT email_domain FROM contacts WHERE id = 1').get()?.email_domain, hashedAlice.split('@')[1]);
  assert.doesNotMatch(fs.readFileSync(hashed.masked_db).toString('utf8'), /example\.(com|con|org)/);
  copyHashed.close();
  assert.deepEqual(fs.readFileSync(layout.dbPath), originals, 'main database is untouched');
});
