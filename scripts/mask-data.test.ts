import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { migrate, openDb } from './lib/db.ts';
import { withWorkspaceLock } from './lib/lock.ts';
import { layoutDirs, workspaceLayout } from './lib/paths.ts';

test('mask-data validates key, obeys the lock, masks paths, and honors both keep-domain controls', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mask-cli-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'test-root');
  const ws = path.join(temp, 'test@example.com');
  const layout = workspaceLayout(ws);
  for (const dir of layoutDirs(layout)) fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(root, 'schema'), { recursive: true });
  const migrations = path.join(root, 'schema/migrations');
  fs.cpSync(path.resolve(import.meta.dirname, '../schema/migrations'), migrations, { recursive: true });
  const db = openDb(layout.dbPath);
  migrate(db, migrations);
  db.exec(`INSERT INTO contacts (email, email_domain, name, email_status, created_at, updated_at)
    VALUES ('tester@example.com', 'example.com', 'Test Person', 'valid', '2026', '2026')`);
  db.close();
  const entry = `
    import { main } from ${JSON.stringify(new URL('./mask-data.ts', import.meta.url).href)};
    import { runCli } from ${JSON.stringify(new URL('./lib/cli.ts', import.meta.url).href)};
    await runCli(() => main(process.argv.slice(2), process.argv[1]));
  `;
  const run = (...args: string[]) => spawnSync(process.execPath,
    ['--input-type=module', '--eval', entry, '--', root, '--workspace', ws, ...args], { encoding: 'utf8' });

  const missing = run('--workspace', path.join(temp, 'absent'), '--json');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /init-workspace/);
  const keyMissing = run('--json');
  assert.equal(keyMissing.status, 2);
  assert.match(keyMissing.stderr, /run init-workspace/);
  assert.deepEqual(fs.readdirSync(layout.masked), []);

  fs.writeFileSync(path.join(root, '.env'), 'MASK_HMAC_KEY=fixture-key');
  await withWorkspaceLock(ws, 'test@example.com', () => {
    const busy = run('--json');
    assert.equal(busy.status, 2);
    assert.match(busy.stderr, /workspace is in use/);
    assert.doesNotMatch(busy.stderr, /@example\.com/);
    assert.deepEqual(fs.readdirSync(layout.masked), []);
  });

  // A stale artifact symlink is replaced, without modifying what it pointed at.
  const untouched = path.join(root, 'untouched');
  fs.writeFileSync(untouched, 'keep this');
  fs.symlinkSync(untouched, path.join(layout.masked, 'mail-list-masked.sqlite'));
  fs.symlinkSync(untouched, path.join(layout.masked, 'shape.json'));
  const kept = run('--shape', '--json');
  assert.equal(kept.status, 0, kept.stderr);
  const plan = JSON.parse(kept.stdout);
  assert.equal(plan.keep_domain, true);
  assert.equal(plan.rows.contacts, 1);
  assert.match(plan.note, /Only output\/masked\//);
  assert.doesNotMatch(kept.stdout + kept.stderr, /@example\.com|Test Person|fixture-key/);
  assert.deepEqual(fs.readdirSync(layout.masked).sort(), ['mail-list-masked.sqlite', 'shape.json']);
  assert.equal(fs.readFileSync(untouched, 'utf8'), 'keep this');
  assert.equal(fs.lstatSync(path.join(layout.masked, 'mail-list-masked.sqlite')).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(path.join(layout.masked, 'shape.json')).isSymbolicLink(), false);
  for (const args of [['--hash-domain'] as string[], []]) {
    if (args.length === 0) fs.writeFileSync(path.join(root, 'config.yaml'), 'masking: { keep_domain: false }\n');
    const hashed = run(...args, '--json');
    assert.equal(hashed.status, 0, hashed.stderr);
    assert.equal(JSON.parse(hashed.stdout).keep_domain, false);
    const copy = openDb(path.join(layout.masked, 'mail-list-masked.sqlite'), { readonly: true });
    try {
      assert.match(String(copy.prepare('SELECT email FROM contacts').get()?.email), /^u[a-f0-9]{16}@d[a-f0-9]{8}\.invalid$/);
    } finally {
      copy.close();
    }
  }
});
