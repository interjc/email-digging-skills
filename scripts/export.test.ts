import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { migrate, openDb } from './lib/db.ts';
import { withWorkspaceLock } from './lib/lock.ts';
import { layoutDirs, workspaceLayout } from './lib/paths.ts';

const migrations = path.resolve(import.meta.dirname, '../schema/migrations');

test('export writes only eligible local CSV rows, masks summaries, audits success and failure, and refuses apply', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'export-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'test-root');
  fs.mkdirSync(root);
  const ws = path.join(temp, 'test@example.com');
  const layout = workspaceLayout(ws);
  for (const dir of layoutDirs(layout)) fs.mkdirSync(dir, { recursive: true });
  const db = openDb(layout.dbPath);
  migrate(db, migrations);
  db.exec(`
    INSERT INTO sources (name, kind, priority, updated_at) VALUES ('shop', 'product', 1, '2026'), ('meet', 'event', 2, '2026');
    INSERT INTO contacts (id, email, email_domain, name, locale, email_status, flags, orphaned_at, created_at, updated_at)
      VALUES (1, 'granted@example.com', 'example.com', 'Test "quoted", name', 'ja', 'role', '["role_address"]', NULL, '2026', '2026'),
        (2, 'unknown@example.com', 'example.com', NULL, NULL, 'valid', '[]', NULL, '2026', '2026'),
        (3, 'denied@example.com', 'example.com', NULL, NULL, 'valid', '[]', NULL, '2026', '2026'),
        (4, 'suppressed@example.com', 'example.com', NULL, NULL, 'valid', '[]', NULL, '2026', '2026'),
        (5, 'orphan@example.com', 'example.com', NULL, NULL, 'valid', '[]', '2026', '2026', '2026'),
        (6, 'typo@example.con', 'example.con', NULL, NULL, 'typo_suspect', '["typo_suspect"]', NULL, '2026', '2026');
    INSERT INTO contact_sources (contact_id, source, raw_email)
      SELECT id, 'shop', email FROM contacts WHERE id <> 5;
    INSERT INTO contact_sources (contact_id, source, raw_email) VALUES (1, 'meet', 'granted@example.com');
    INSERT INTO consents (contact_id, source, status) VALUES
      (1, 'shop', 'granted'), (2, 'shop', 'unknown'), (3, 'shop', 'denied'),
      (4, 'shop', 'granted'), (6, 'shop', 'granted');
    INSERT INTO suppressions (email, reason, source, created_at) VALUES ('suppressed@example.com', 'manual', 'override', '2026');
  `);
  db.close();
  const entry = `
    import { main } from ${JSON.stringify(new URL('./export.ts', import.meta.url).href)};
    import { runCli } from ${JSON.stringify(new URL('./lib/cli.ts', import.meta.url).href)};
    await runCli(() => main(process.argv.slice(2), process.argv[1]));
  `;
  const run = (...args: string[]) => spawnSync(process.execPath,
    ['--input-type=module', '--eval', entry, '--', root, '--workspace', ws, ...args], { encoding: 'utf8' });

  assert.equal(run('--workspace', path.join(temp, 'missing'), '--provider', 'listmonk').status, 2);
  const unknown = run('--provider', '../provider@example.com');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Available providers: listmonk/);
  assert.doesNotMatch(unknown.stderr, /@example/);
  const apply = run('--provider', 'listmonk', '--apply');
  assert.equal(apply.status, 2);
  assert.match(apply.stderr, /applying to a provider is not available in phase 1; it will require explicit human confirmation/);
  await withWorkspaceLock(ws, 'mask-data', () => assert.equal(run('--provider', 'listmonk').status, 2));
  assert.deepEqual(fs.readdirSync(layout.exports), []);
  const before = openDb(layout.dbPath, { readonly: true });
  assert.equal(before.prepare('SELECT count(*) AS n FROM sync_log').get()?.n, 0);
  before.close();

  for (const [list, args, expected] of [
    ['strict', [] as string[], 1], ['not_blocked', ['--list', 'not_blocked'], 3],
  ] as const) {
    const result = run('--provider', 'listmonk', '--json', ...args);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /[@＠][a-z0-9-]+\./i);
    if (list === 'not_blocked') assert.match(result.stderr, /includes contacts without positive consent/);
    else assert.doesNotMatch(result.stderr, /positive consent/);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.list, list);
    assert.equal(plan.to_add, expected);
    assert.equal(plan.to_update, 0);
    assert.equal(plan.to_remove, 0);
    assert.match(plan.notes[0], /requires the Listmonk API/);
    const files = fs.readdirSync(layout.exports).filter((file) => file.startsWith(`listmonk-${list}-`));
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^listmonk-(strict|not_blocked)-\d{8}T\d{6}Z\.csv$/);
    const csv = fs.readFileSync(path.join(layout.exports, files[0]!), 'utf8');
    const attributes = JSON.stringify({ sources: ['meet', 'shop'], flags: ['role_address'], locale: 'ja', email_status: 'role' });
    assert.ok(csv.startsWith(`email,name,attributes\r\ngranted@example.com,"Test ""quoted"", name","${attributes.replaceAll('"', '""')}"\r\n`));
    assert.doesNotMatch(csv, /denied@|suppressed@|orphan@/);
    assert.equal(csv.includes('unknown@example.com'), list === 'not_blocked');
    assert.equal(csv.includes('typo@example.con'), list === 'not_blocked');
  }
  const bad = openDb(layout.dbPath);
  bad.prepare('UPDATE contacts SET flags = ? WHERE id = 1').run('broken@example.com');
  bad.close();
  const failed = run('--provider', 'listmonk', '--json');
  assert.equal(failed.status, 1);
  assert.doesNotMatch(failed.stdout + failed.stderr, /@example\.com/);
  assert.equal(fs.readdirSync(layout.exports).length, 2, 'partial CSV discarded');
  const after = openDb(layout.dbPath, { readonly: true });
  try {
    const events = after.prepare('SELECT * FROM sync_log ORDER BY id').all();
    assert.deepEqual(events.map((r) => [r.provider, r.direction, r.dry_run, r.status, JSON.parse(String(r.counts))]), [
      ['listmonk', 'push', 1, 'ok', { to_add: 1, to_update: 0, to_remove: 0 }],
      ['listmonk', 'push', 1, 'ok', { to_add: 3, to_update: 0, to_remove: 0 }],
      ['listmonk', 'push', 1, 'failed', {}],
    ]);
    assert.ok(events.every((r) => typeof r.started_at === 'string' && typeof r.finished_at === 'string'));
  } finally {
    after.close();
  }
});
