import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { initWorkspace } from './init-workspace.ts';
import { PreconditionError } from './lib/errors.ts';
import { openDb } from './lib/db.ts';
import { repoRoot, workspaceLayout } from './lib/paths.ts';
import { parseEnv } from './lib/env.ts';
import { lockPath } from './lib/lock.ts';

const REAL = repoRoot();

interface RepoOpts { git?: boolean; gitignore?: boolean; githooks?: boolean; fixtures?: boolean }

/** Temp repository with the files init-workspace reads (never the real .env / workspace). */
function makeRepo(opts: RepoOpts = {}): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'init-test-')));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"tmp"}\n');
  fs.mkdirSync(path.join(root, 'node_modules', '@duckdb', 'node-api'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'yaml'), { recursive: true });
  fs.cpSync(path.join(REAL, 'schema', 'migrations'), path.join(root, 'schema', 'migrations'), { recursive: true });
  for (const f of ['config.example.yaml', '.env.example']) fs.copyFileSync(path.join(REAL, f), path.join(root, f));
  if (opts.gitignore !== false) fs.copyFileSync(path.join(REAL, '.gitignore'), path.join(root, '.gitignore'));
  if (opts.git !== false) execFileSync('git', ['init', '-q'], { cwd: root });
  if (opts.githooks) fs.mkdirSync(path.join(root, '.githooks'));
  if (opts.fixtures) {
    fs.mkdirSync(path.join(root, 'fixtures', 'sources', 'shop'), { recursive: true });
    fs.writeFileSync(path.join(root, 'fixtures', 'sources', 'shop', 'meta.md'), 'source: shop\n');
    fs.writeFileSync(path.join(root, 'fixtures', 'sources', 'shop', 'a.csv'), 'email\nx@example.com\n');
    fs.mkdirSync(path.join(root, 'fixtures', 'overrides'), { recursive: true });
    fs.writeFileSync(path.join(root, 'fixtures', 'overrides', 'exclude.yaml'), '- email: t@example.com\n');
  }
  return root;
}

const run = (root: string, extra: { workspace?: string; demo?: boolean } = {}) =>
  initWorkspace({ repoRoot: root, env: {}, skipDuckdb: true, ...extra });

const byName = (r: Awaited<ReturnType<typeof run>>, name: string) => r.checks.find((c) => c.check === name);

test('first run: layout, config.yaml, .env with a 64-hex key, migrated database', async () => {
  const root = makeRepo();
  const r = await run(root);
  assert.equal(r.ok, true);
  assert.equal(r.workspace, path.join(root, 'workspace'));
  assert.equal(r.next, 'add-source <name>');

  const layout = workspaceLayout(r.workspace);
  for (const d of [layout.resources, layout.overrides, layout.staging, layout.reports, layout.masked, layout.exports, layout.backups]) {
    assert.ok(fs.statSync(d).isDirectory(), d);
  }
  assert.ok(fs.existsSync(layout.dbPath));
  assert.ok(fs.existsSync(path.join(root, 'config.yaml')));

  const key = parseEnv(fs.readFileSync(path.join(root, '.env'), 'utf8')).MASK_HMAC_KEY ?? '';
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(path.join(root, '.env')).mode & 0o077, 0, '.env is not group/world readable');
  assert.ok(!JSON.stringify(r).includes(key), 'the key is never part of the result');

  const db = openDb(layout.dbPath, { readonly: true });
  assert.ok((db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n as number) >= 2);
  db.close();
});

test('second run is idempotent: nothing overwritten, key unchanged, migrations up to date', async () => {
  const root = makeRepo();
  await run(root);
  const envFile = path.join(root, '.env');
  const key = parseEnv(fs.readFileSync(envFile, 'utf8')).MASK_HMAC_KEY;
  fs.appendFileSync(path.join(root, 'config.yaml'), '# my edit\n');
  fs.writeFileSync(path.join(root, 'workspace', 'overrides', 'exclude.yaml'), '- email: a@example.com\n');
  const envBefore = fs.readFileSync(envFile, 'utf8');

  const r = await run(root);
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(envFile, 'utf8'), envBefore);
  assert.equal(parseEnv(fs.readFileSync(envFile, 'utf8')).MASK_HMAC_KEY, key);
  assert.match(fs.readFileSync(path.join(root, 'config.yaml'), 'utf8'), /# my edit/);
  assert.equal(fs.readFileSync(path.join(root, 'workspace', 'overrides', 'exclude.yaml'), 'utf8'), '- email: a@example.com\n');
  assert.equal(byName(r, 'Workspace layout')?.detail, 'already present');
  assert.equal(byName(r, 'Database')?.detail, 'up to date');
  assert.equal(byName(r, 'MASK_HMAC_KEY')?.detail, 'already set');
  assert.equal(byName(r, '.env')?.detail, 'already present');
});

test('an empty MASK_HMAC_KEY in an existing .env: only that line changes', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, '.env'), '# mine\nLISTMONK_URL=https://lists.example.com\nMASK_HMAC_KEY=\nOTHER="x y"\n');
  await run(root);
  const lines = fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n');
  assert.equal(lines[0], '# mine');
  assert.equal(lines[1], 'LISTMONK_URL=https://lists.example.com');
  assert.match(lines[2] as string, /^MASK_HMAC_KEY=[0-9a-f]{64}$/);
  assert.equal(lines[3], 'OTHER="x y"');
});

test('a missing MASK_HMAC_KEY line is appended; a user-set key is never replaced', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, '.env'), 'A=1');
  await run(root);
  assert.match(fs.readFileSync(path.join(root, '.env'), 'utf8'), /^A=1\nMASK_HMAC_KEY=[0-9a-f]{64}\n$/);

  const root2 = makeRepo();
  fs.writeFileSync(path.join(root2, '.env'), 'MASK_HMAC_KEY=my-own-key\n');
  await run(root2);
  assert.equal(fs.readFileSync(path.join(root2, '.env'), 'utf8'), 'MASK_HMAC_KEY=my-own-key\n');
});

test('refuses a workspace inside the repository that git does not ignore, and creates nothing', async () => {
  const root = makeRepo({ gitignore: false });
  await assert.rejects(
    () => run(root),
    (err: unknown) => err instanceof PreconditionError && /not git-ignored/.test(err.message),
  );
  assert.ok(!fs.existsSync(path.join(root, 'workspace')));
  assert.ok(!fs.existsSync(path.join(root, '.env')));
  assert.ok(!fs.existsSync(path.join(root, 'config.yaml')));
});

test('a workspace outside the repository works without any .gitignore', async () => {
  const root = makeRepo({ gitignore: false });
  const outside = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'init-ws-'))), 'ws');
  const r = await run(root, { workspace: outside });
  assert.equal(r.workspace, outside);
  assert.ok(fs.existsSync(workspaceLayout(outside).dbPath));
});

test('MAIL_PIPELINE_WORKSPACE from the environment is honoured', async () => {
  const root = makeRepo();
  const outside = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'init-ws-'))), 'envws');
  const r = await initWorkspace({ repoRoot: root, env: { MAIL_PIPELINE_WORKSPACE: outside }, skipDuckdb: true });
  assert.equal(r.workspace, outside);
});

test('git hooks: core.hooksPath is set only when .githooks exists and it is unset', async () => {
  const gitCfg = (root: string) => {
    const r = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8' });
    return r.stdout.trim();
  };
  const withHooks = makeRepo({ githooks: true });
  const r1 = await run(withHooks);
  assert.equal(gitCfg(withHooks), '.githooks');
  assert.equal(byName(r1, 'git hooks')?.result, 'ok');
  await run(withHooks); // idempotent
  assert.equal(gitCfg(withHooks), '.githooks');

  const custom = makeRepo({ githooks: true });
  execFileSync('git', ['config', 'core.hooksPath', 'my-hooks'], { cwd: custom });
  const r2 = await run(custom);
  assert.equal(gitCfg(custom), 'my-hooks', 'an existing setting is left alone');
  assert.equal(byName(r2, 'git hooks')?.result, 'warn');

  const noHooks = makeRepo();
  const r3 = await run(noHooks);
  assert.equal(gitCfg(noHooks), '');
  assert.equal(byName(r3, 'git hooks'), undefined);

  const noGit = makeRepo({ git: false, githooks: true });
  const r4 = await run(noGit);
  assert.equal(byName(r4, 'git hooks')?.result, 'skipped');
});

test('--demo: separate .demo workspace with its own database and copied fixtures, never overwriting', async () => {
  const root = makeRepo({ fixtures: true });
  const r = await run(root, { demo: true });
  const demo = path.join(r.workspace, '.demo');
  assert.equal(r.demo_workspace, demo);
  assert.ok(fs.existsSync(path.join(demo, 'resources', 'shop', 'meta.md')));
  assert.ok(fs.existsSync(path.join(demo, 'resources', 'shop', 'a.csv')));
  assert.ok(fs.existsSync(path.join(demo, 'overrides', 'exclude.yaml')));
  assert.ok(fs.existsSync(workspaceLayout(demo).dbPath));
  assert.notEqual(workspaceLayout(demo).dbPath, workspaceLayout(r.workspace).dbPath);
  assert.equal(byName(r, 'Demo pipeline run')?.detail, 'not wired yet');

  fs.writeFileSync(path.join(demo, 'resources', 'shop', 'meta.md'), 'edited\n');
  await run(root, { demo: true });
  assert.equal(fs.readFileSync(path.join(demo, 'resources', 'shop', 'meta.md'), 'utf8'), 'edited\n');

  const without = await run(makeRepo());
  assert.equal(without.demo_workspace, null);
});

test('--demo without fixtures warns but still creates the demo workspace', async () => {
  const root = makeRepo();
  const r = await run(root, { demo: true });
  assert.equal(r.ok, true);
  assert.equal(byName(r, 'Demo fixtures')?.result, 'warn');
  assert.ok(fs.existsSync(workspaceLayout(path.join(r.workspace, '.demo')).dbPath));
});

test('a failing migration is reported as a failed check (ok=false), not thrown', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'schema', 'migrations', '0099_bad.sql'), 'NOT SQL;\n');
  const r = await run(root);
  assert.equal(r.ok, false);
  assert.equal(byName(r, 'Database')?.result, 'fail');
});

test('CLI: exit code 2 and a fix on stderr when the workspace is inside the repo but not ignored', () => {
  const root = makeRepo({ gitignore: false });
  fs.cpSync(path.join(REAL, 'scripts'), path.join(root, 'scripts'), { recursive: true });
  fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
  fs.symlinkSync(path.join(REAL, 'node_modules'), path.join(root, 'node_modules'));
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'init-workspace.ts'), '--json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, MAIL_PIPELINE_WORKSPACE: '' },
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /not git-ignored/);
  assert.match(r.stderr, /Fix:/);
  assert.equal(r.stdout, '');
  assert.ok(!fs.existsSync(path.join(root, 'workspace')));
});

test('a duplicate empty MASK_HMAC_KEY after a non-empty one: the effective (last) assignment is filled', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, '.env'), 'MASK_HMAC_KEY=old\nLISTMONK_URL=x\nMASK_HMAC_KEY=\n');
  await run(root);
  const text = fs.readFileSync(path.join(root, '.env'), 'utf8');
  const lines = text.split('\n');
  assert.equal(lines[0], 'MASK_HMAC_KEY=old', 'the shadowed first line is untouched');
  assert.match(lines[2] as string, /^MASK_HMAC_KEY=[0-9a-f]{64}$/);
  assert.match(parseEnv(text).MASK_HMAC_KEY ?? '', /^[0-9a-f]{64}$/, 'what the parser reads is the generated key');
});

test('D26: init holds the workspace lock while it runs and releases it afterwards', async () => {
  const root = makeRepo();
  const r = await run(root);
  assert.ok(!fs.existsSync(lockPath(r.workspace)), 'lock released after a normal run');

  // A second command (or init) cannot run while another holds the lock.
  const { withWorkspaceLock } = await import('./lib/lock.ts');
  await withWorkspaceLock(r.workspace, 'clean-and-merge', async () => {
    await assert.rejects(
      () => run(root),
      (err: unknown) => err instanceof PreconditionError && /in use by "clean-and-merge"/.test(err.message),
    );
  });
  await run(root); // free again
});

test('D26: init releases the lock when a check fails, and refuses on a stale lock without removing it', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'schema', 'migrations', '0099_bad.sql'), 'NOT SQL;\n');
  const r = await run(root);
  assert.equal(r.ok, false);
  assert.ok(!fs.existsSync(lockPath(r.workspace)));

  const dead = spawnSync(process.execPath, ['-e', '0']).pid as number;
  fs.writeFileSync(lockPath(r.workspace), JSON.stringify({ pid: dead, command: 'add-source', started_at: '2026-01-01T00:00:00.000Z' }));
  await assert.rejects(() => run(root), /stale/);
  assert.ok(fs.existsSync(lockPath(r.workspace)));
});

test('init refuses a workspace in the repo that has a tracked file, and creates nothing new', async () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, 'workspace', 'resources'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspace', 'resources', 'tracked.csv'), 'x\n');
  execFileSync('git', ['add', '-f', 'workspace/resources/tracked.csv'], { cwd: root });
  await assert.rejects(() => run(root), /tracked by git/);
  assert.ok(!fs.existsSync(path.join(root, '.env')));
  assert.ok(!fs.existsSync(path.join(root, 'workspace', '.lock')));
});

// --- round 3 (review R4) ---------------------------------------------------------------------------

import { renderInitOutput } from './init-workspace.ts';

test('R4-2: every path printed (text and JSON) is sanitized; JSON still parses', async () => {
  const root = makeRepo();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'init-addr-')));
  // A workspace path that looks like an address (and one that is only a "@pending"-style fragment)
  for (const dirName of ['leak@example.com', 'leak﹫example.org', '@pending']) {
    const ws = path.join(base, dirName, 'ws');
    const r = await run(root, { workspace: ws });
    assert.equal(r.workspace, ws, 'the in-process result keeps the real path');

    const text = renderInitOutput(r, false);
    assert.ok(!text.includes('leak'), `${dirName}: ${text.split('\n')[0]}`);
    assert.ok(!text.includes('@pending'), dirName);

    const json = renderInitOutput(r, true);
    assert.ok(!json.includes('leak') && !json.includes('@pending'), dirName);
    const parsed = JSON.parse(json);
    assert.equal(parsed.ok, true);
    assert.ok(Array.isArray(parsed.checks) && parsed.checks.length > 0);
  }
});

test('R4-2: the CLI refusal (exit 2) and warnings do not print an address-like workspace path', () => {
  const root = makeRepo({ gitignore: false });
  fs.cpSync(path.join(REAL, 'scripts'), path.join(root, 'scripts'), { recursive: true });
  fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
  fs.symlinkSync(path.join(REAL, 'node_modules'), path.join(root, 'node_modules'));
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'init-workspace.ts'), '--workspace', path.join(root, 'leak@example.com')], {
    cwd: root, encoding: 'utf8', env: { ...process.env, MAIL_PIPELINE_WORKSPACE: '' },
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /not git-ignored/);
  assert.ok(!r.stderr.includes('leak@') && !r.stdout.includes('leak@'), r.stderr);
});
