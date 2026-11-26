import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { migrate, openDb } from './lib/db.ts';
import { layoutDirs, workspaceLayout } from './lib/paths.ts';

const cli = path.join(import.meta.dirname, 'query.ts');
const migrations = path.resolve(import.meta.dirname, '../schema/migrations');
const unmaskedAddress = /[@＠][a-z0-9-]+\./i;

test('query CLI masks fields, aliases, embedded addresses, JSON and diagnostics', (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'query-test-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const layout = workspaceLayout(ws);
  for (const dir of layoutDirs(layout)) fs.mkdirSync(dir, { recursive: true });
  const db = openDb(layout.dbPath);
  migrate(db, migrations);
  db.exec(`
    INSERT INTO sources (name, kind, priority, updated_at) VALUES ('one', 'other', 1, '2026');
    INSERT INTO contacts (id, email, email_domain, name, email_status, created_at, updated_at)
      VALUES (1, 'alice@example.com', 'example.com', 'Alice Example', 'valid', '2026', '2026'),
        (2, 'bob@example.org', 'example.org', 'Bob, Example', 'valid', '2026', '2026');
    INSERT INTO contact_sources (contact_id, source, raw_email, raw_fields) VALUES
      (1, 'one', 'ALICE@example.com', '{"電話":"010-0000-1212","地址":"Sample Street","邮箱":"nested@example.net"}');
    INSERT INTO consents (contact_id, source, status, evidence) VALUES
      (1, 'one', 'unknown', '{"column":"氏名","value":"Alice Example"}');
  `);
  db.close();
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, '--workspace', ws, ...args], { encoding: 'utf8' });

  // Read-only queries remain possible while writers hold the workspace lock.
  fs.writeFileSync(path.join(ws, '.lock'), '{"pid":1,"command":"export","started_at":"2026"}');
  for (const output of [[], ['--json']]) {
    const result = run('--sql', `
      SELECT c.email, c.name AS alias, 'copy alice@example.com here' AS free_text,
        'hidden＠example．org' AS "header@example.jp", c.flags, cs.raw_fields, k.evidence
      FROM contacts c JOIN contact_sources cs ON cs.contact_id = c.id JOIN consents k ON k.contact_id = c.id
    `, ...output);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, unmaskedAddress);
    assert.doesNotMatch(result.stdout, /Alice Example|010-0000-1212|Sample Street/);
    const row = JSON.parse(result.stdout).rows[0];
    assert.equal(row.alias, 'A***');
    assert.equal(row.free_text, 'copy a***@e***e.com here');
    assert.equal(row['h***@e***e.jp'], 'h***@e***e.org');
    assert.equal(row.raw_fields['電話'], '***-****-**12');
    assert.equal(row.raw_fields['地址'], 'Sa***');
    assert.equal(row.evidence.value, 'A***');
    assert.deepEqual(row.flags, []);
  }
  for (const sql of ["ATTACH ':memory:' AS foo", 'UPDATE contacts SET name = null', 'DELETE FROM contacts', 'SELECT 1; SELECT 2']) {
    const refused = run('--sql', sql);
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /query is read-only/);
  }
  const bad = run('--sql', 'SELECT "diagnostic@example.com" FROM nonexistent');
  assert.equal(bad.status, 1);
  assert.doesNotMatch(bad.stdout + bad.stderr, unmaskedAddress);
  const diagnostics = run('--unknown@example.com');
  assert.equal(diagnostics.status, 1);
  assert.doesNotMatch(diagnostics.stdout + diagnostics.stderr, unmaskedAddress);

  const query = ['--sql', 'SELECT email, name FROM contacts ORDER BY id', '--limit', '1', '--json'];
  assert.equal(JSON.parse(run(...query).stdout).rows.length, 1);
  const exported = run(...query, '--out');
  assert.equal(exported.status, 0, exported.stderr);
  assert.doesNotMatch(exported.stdout + exported.stderr, unmaskedAddress);
  const plan = JSON.parse(exported.stdout);
  assert.deepEqual(Object.keys(plan).sort(), ['export_file', 'row_count']);
  assert.equal(plan.row_count, 2);
  assert.equal(path.dirname(fs.realpathSync(plan.export_file)), fs.realpathSync(layout.exports));
  assert.match(path.basename(plan.export_file), /^query-\d{8}T\d{6}Z\.csv$/);
  assert.equal(fs.readFileSync(plan.export_file, 'utf8'), 'email,name\r\nalice@example.com,Alice Example\r\nbob@example.org,"Bob, Example"\r\n');

  const missing = run('--workspace', path.join(ws, 'missing'), '--sql', 'SELECT 1');
  assert.equal(missing.status, 2);

  const duplicate = run('--sql', 'SELECT id AS duplicate, email AS duplicate FROM contacts');
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /distinct aliases/);

  fs.renameSync(layout.exports, path.join(layout.output, 'old-exports'));
  fs.symlinkSync(layout.masked, layout.exports, 'dir');
  const redirected = run(...query, '--out');
  assert.equal(redirected.status, 1);
  assert.match(redirected.stderr, /redirected output directory/);
  assert.deepEqual(fs.readdirSync(layout.masked), []);
});
