import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  checkWorkspaceSafety, cloudSyncWarning, layoutDirs, repoRoot, requireWorkspace, resolveWorkspace, workspaceLayout,
} from './paths.ts';
import { PreconditionError } from './errors.ts';

const REAL_ROOT = repoRoot();

/** Temp "repository": package.json + the real .gitignore, optionally a git repo. */
function makeRepo(opts: { git?: boolean; gitignore?: boolean } = {}): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paths-test-')));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"tmp"}\n');
  if (opts.gitignore !== false) fs.copyFileSync(path.join(REAL_ROOT, '.gitignore'), path.join(root, '.gitignore'));
  if (opts.git !== false) execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

/** Create the layout and an empty database file so requireWorkspace sees an initialized workspace. */
function initLayout(ws: string): void {
  for (const d of layoutDirs(workspaceLayout(ws))) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(workspaceLayout(ws).dbPath, '');
}

test('repoRoot finds the directory with package.json', () => {
  assert.ok(fs.existsSync(path.join(REAL_ROOT, 'package.json')));
  assert.equal(REAL_ROOT, path.resolve(import.meta.dirname, '..', '..'));
});

test('workspaceLayout has the documented directories and db path', () => {
  const l = workspaceLayout('/w');
  assert.equal(l.resources, path.join('/w', 'resources'));
  assert.equal(l.staging, path.join('/w', 'output', 'staging'));
  assert.equal(l.backups, path.join('/w', 'database', 'backups'));
  assert.equal(l.dbPath, path.join('/w', 'database', 'mail-list.sqlite'));
});

test('resolution order: flag > process env > .env > config.yaml > <repo>/workspace', () => {
  const root = makeRepo();
  assert.equal(resolveWorkspace({ repoRoot: root, env: {} }), path.join(root, 'workspace'));

  fs.writeFileSync(path.join(root, 'config.yaml'), 'workspace: ./from-config\n');
  assert.equal(resolveWorkspace({ repoRoot: root, env: {} }), path.join(root, 'from-config'));

  fs.writeFileSync(path.join(root, '.env'), 'MAIL_PIPELINE_WORKSPACE=./from-dotenv\n');
  assert.equal(resolveWorkspace({ repoRoot: root, env: {} }), path.join(root, 'from-dotenv'));

  assert.equal(
    resolveWorkspace({ repoRoot: root, env: { MAIL_PIPELINE_WORKSPACE: '/from/process' } }),
    path.resolve('/from/process'),
  );
  assert.equal(
    resolveWorkspace({ repoRoot: root, workspace: '/from/flag', env: { MAIL_PIPELINE_WORKSPACE: '/from/process' } }),
    path.resolve('/from/flag'),
  );
});

test('an empty MAIL_PIPELINE_WORKSPACE (as in .env.example) falls through', () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, '.env'), 'MAIL_PIPELINE_WORKSPACE=\n');
  fs.writeFileSync(path.join(root, 'config.yaml'), 'workspace: ./cfg\n');
  assert.equal(resolveWorkspace({ repoRoot: root, env: { MAIL_PIPELINE_WORKSPACE: '  ' } }), path.join(root, 'cfg'));
});

test('requireWorkspace: missing workspace -> PreconditionError naming init-workspace', () => {
  const root = makeRepo();
  assert.throws(
    () => requireWorkspace({ repoRoot: root, env: {} }),
    (err: unknown) => err instanceof PreconditionError && /does not exist/.test(err.message) && /init-workspace/.test(err.fix ?? ''),
  );
});

test('requireWorkspace: layout present but database missing -> not initialized', () => {
  const root = makeRepo();
  const ws = path.join(root, 'workspace');
  initLayout(ws);
  fs.rmSync(workspaceLayout(ws).dbPath);
  assert.throws(() => requireWorkspace({ repoRoot: root, env: {} }), /not initialized/);
});

test('requireWorkspace: ok when initialized and git-ignored inside the repo', () => {
  const root = makeRepo();
  initLayout(path.join(root, 'workspace'));
  const info = requireWorkspace({ repoRoot: root, env: {} });
  assert.equal(info.workspace, path.join(root, 'workspace'));
  assert.equal(info.layout.dbPath, path.join(root, 'workspace', 'database', 'mail-list.sqlite'));
  assert.deepEqual(info.warnings, []);
});

test('requireWorkspace refuses a workspace inside the repo that git does not ignore', () => {
  const root = makeRepo({ gitignore: false });
  initLayout(path.join(root, 'workspace'));
  assert.throws(
    () => requireWorkspace({ repoRoot: root, env: {} }),
    (err: unknown) => err instanceof PreconditionError && /not git-ignored/.test(err.message),
  );
});

test('requireWorkspace refuses a custom in-repo folder that only the *.csv/*.sqlite safety nets cover', () => {
  const root = makeRepo();
  const ws = path.join(root, 'my-data');
  initLayout(ws);
  // The two required probes (resources/*.csv, database/*.sqlite) are ignored by the safety-net patterns...
  const safety = checkWorkspaceSafety(ws, root);
  assert.ok(!safety.notIgnored.includes('resources/__probe__.csv'));
  assert.ok(!safety.notIgnored.includes('database/__probe__.sqlite'));
  // ...but overrides/reports/exports would be committable, so the guard still refuses.
  assert.ok(safety.notIgnored.includes('overrides/__probe__.yaml'));
  assert.throws(() => requireWorkspace({ repoRoot: root, workspace: ws, env: {} }), /not git-ignored/);
});

test('a workspace outside the repository needs no git-ignore', () => {
  const root = makeRepo({ gitignore: false });
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paths-ws-')));
  initLayout(outside);
  const info = requireWorkspace({ repoRoot: root, workspace: outside, env: {} });
  assert.equal(info.workspace, outside);
  assert.equal(checkWorkspaceSafety(outside, root).insideRepo, false);
});

test('inside a non-git directory: warn only', () => {
  const root = makeRepo({ git: false });
  initLayout(path.join(root, 'workspace'));
  const info = requireWorkspace({ repoRoot: root, env: {} });
  assert.equal(info.warnings.length, 1);
  assert.match(info.warnings[0] as string, /not a git repository/);
});

test('the guard works for paths that do not exist yet (init-workspace calls it first)', () => {
  const root = makeRepo();
  const ok = checkWorkspaceSafety(path.join(root, 'workspace'), root);
  assert.deepEqual(ok.problems, []);
  const bad = checkWorkspaceSafety(path.join(root, 'elsewhere'), root);
  assert.equal(bad.problems.length, 1);
});

test('cloud-synced folder names produce a warning', () => {
  for (const p of [
    '/Users/x/Library/Mobile Documents/com~apple~CloudDocs/ws',
    '/Users/x/Dropbox/ws',
    'C:\\Users\\x\\OneDrive\\ws',
    '/Users/x/Google Drive/ws',
    '/Users/x/iCloud Drive/ws',
  ]) {
    assert.match(cloudSyncWarning(p) ?? '', /cloud-synced folder/, p);
  }
  assert.equal(cloudSyncWarning('/Users/x/data/ws'), null);
});

test('cloud warning is returned by requireWorkspace, not thrown', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paths-cloud-')));
  const ws = path.join(base, 'Dropbox', 'ws');
  initLayout(ws);
  const root = makeRepo();
  const info = requireWorkspace({ repoRoot: root, workspace: ws, env: {} });
  assert.match(info.warnings.join('\n'), /cloud-synced folder/);
});

// --- D27 guard (review R1 finding 1) -------------------------------------------------------------

function write(file: string, text = 'x\n'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test('guard: narrow ignore rules that match only fixed probe names do not pass', () => {
  const root = makeRepo({ gitignore: false });
  fs.writeFileSync(path.join(root, '.gitignore'), [
    'workspace/resources/__probe__.csv',
    'workspace/database/__probe__.sqlite',
    'workspace/overrides/__probe__.yaml',
    'workspace/output/reports/__probe__.md',
    'workspace/output/exports/__probe__.json',
  ].join('\n'));
  initLayout(path.join(root, 'workspace'));
  // No data file yet: new files would not be ignored (the probe name is random per run).
  assert.throws(() => requireWorkspace({ repoRoot: root, env: {} }), /not git-ignored/);
});

test('guard: an existing unignored JSON input is caught even when every probe path is ignored', () => {
  const root = makeRepo({ gitignore: false });
  // Ignores everything except *.json: a fixed-probe check would pass.
  fs.writeFileSync(path.join(root, '.gitignore'), 'workspace/*\n!workspace/resources\nworkspace/resources/*\n!workspace/resources/*.json\n');
  initLayout(path.join(root, 'workspace'));
  write(path.join(root, 'workspace', 'resources', 'customers.json'));
  const safety = checkWorkspaceSafety(path.join(root, 'workspace'), root);
  assert.ok(safety.notIgnored.some((n) => n.endsWith('customers.json')), safety.notIgnored.join(','));
  assert.throws(() => requireWorkspace({ repoRoot: root, env: {} }), /not git-ignored/);
});

test('guard: a file tracked by git under the workspace is refused; the .gitkeep placeholder is allowed', () => {
  const root = makeRepo();
  const ws = path.join(root, 'workspace');
  initLayout(ws);
  write(path.join(ws, '.gitkeep'), '');
  execFileSync('git', ['add', '-f', 'workspace/.gitkeep'], { cwd: root });
  assert.deepEqual(requireWorkspace({ repoRoot: root, env: {} }).warnings, []);

  write(path.join(ws, 'resources', 'tracked.csv'));
  execFileSync('git', ['add', '-f', 'workspace/resources/tracked.csv'], { cwd: root });
  assert.throws(
    () => requireWorkspace({ repoRoot: root, env: {} }),
    (err: unknown) => err instanceof PreconditionError && /tracked by git/.test(err.message),
  );
  assert.deepEqual(checkWorkspaceSafety(ws, root).tracked, ['workspace/resources/tracked.csv']);
});

test('guard: an in-repo directory named "..private" is inside the repo, not external', () => {
  const root = makeRepo({ gitignore: false });
  const ws = path.join(root, '..private');
  initLayout(ws);
  const safety = checkWorkspaceSafety(ws, root);
  assert.equal(safety.insideRepo, true);
  assert.throws(() => requireWorkspace({ repoRoot: root, workspace: ws, env: {} }), /not git-ignored/);
});

test('guard: an external workspace whose resources is a symlink into the checkout is refused', () => {
  const root = makeRepo();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paths-ext-')));
  initLayout(outside);
  fs.mkdirSync(path.join(root, 'data'));
  fs.rmSync(path.join(outside, 'resources'), { recursive: true });
  fs.symlinkSync(path.join(root, 'data'), path.join(outside, 'resources'));
  const safety = checkWorkspaceSafety(outside, root);
  assert.equal(safety.insideRepo, true);
  assert.match(safety.problems.join(' '), /resources resolves into the repository/);
  assert.throws(
    () => requireWorkspace({ repoRoot: root, workspace: outside, env: {} }),
    (err: unknown) => err instanceof PreconditionError && /not git-ignored/.test(err.message),
  );
});

test('guard: a symlink into an ignored place inside the checkout is fine', () => {
  const root = makeRepo();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paths-ext-')));
  initLayout(outside);
  fs.mkdirSync(path.join(root, 'workspace', 'inputs'), { recursive: true });
  fs.rmSync(path.join(outside, 'resources'), { recursive: true });
  fs.symlinkSync(path.join(root, 'workspace', 'inputs'), path.join(outside, 'resources'));
  const info = requireWorkspace({ repoRoot: root, workspace: outside, env: {} });
  assert.equal(info.workspace, outside);
});

test('guard: the workspace being the repository root is refused', () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'x.txt'), 'tracked');
  execFileSync('git', ['add', 'x.txt'], { cwd: root });
  assert.ok(checkWorkspaceSafety(root, root).problems.length > 0);
});

test('guard: file names in the refusal are masked when they look like addresses', () => {
  const root = makeRepo({ gitignore: false });
  const ws = path.join(root, 'workspace');
  initLayout(ws);
  write(path.join(ws, 'resources', 'taro@example.com.txt')); // email-scan:allow
  let message = '';
  try {
    requireWorkspace({ repoRoot: root, env: {} });
  } catch (err) {
    message = (err as Error).message;
  }
  assert.match(message, /not git-ignored/);
  assert.ok(!message.includes('taro@'), message);
});

test('requireWorkspace: database/mail-list.sqlite must be a regular file, not a directory', () => {
  const root = makeRepo();
  const ws = path.join(root, 'workspace');
  initLayout(ws);
  fs.rmSync(workspaceLayout(ws).dbPath);
  fs.mkdirSync(workspaceLayout(ws).dbPath);
  assert.throws(() => requireWorkspace({ repoRoot: root, env: {} }), /not initialized/);
});
