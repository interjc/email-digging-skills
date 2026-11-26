import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  assertPathSafe, checkWorkspaceSafety, cloudSyncWarning, layoutDirs, repoRoot, requireWorkspace, resolveWorkspace, workspaceLayout,
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
  assert.match(safety.problems.join(' '), /resources resolves into the repository or another git checkout/);
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

// --- round 2 (review R2) ---------------------------------------------------------------------------

test('guard 1a: a .git that git cannot read refuses instead of being treated as "not a git repo"', () => {
  const root = makeRepo({ git: false });
  fs.mkdirSync(path.join(root, '.git')); // looks like a repository, but git cannot use it
  initLayout(path.join(root, 'workspace'));
  const safety = checkWorkspaceSafety(path.join(root, 'workspace'), root);
  assert.equal(safety.warnings.length, 0);
  assert.match(safety.problems.join(' '), /cannot be verified/);
  assert.throws(() => requireWorkspace({ repoRoot: root, env: {} }), (err: unknown) => err instanceof PreconditionError && /cannot be verified/.test(err.message));
});

test('guard 1a: .git in an ancestor of the repo root counts; git missing from PATH refuses', () => {
  const outer = makeRepo(); // a real git repo
  const inner = path.join(outer, 'sub');
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, 'package.json'), '{}\n');
  // git works here (the outer repo contains the inner directory): not an error state
  assert.equal(checkWorkspaceSafety(path.join(inner, 'ws'), inner).problems.length > 0, true, 'ws is not ignored in the outer repo');

  const root = makeRepo();
  initLayout(path.join(root, 'workspace'));
  const savedPath = process.env.PATH;
  process.env.PATH = '';
  try {
    const safety = checkWorkspaceSafety(path.join(root, 'workspace'), root);
    assert.match(safety.problems.join(' '), /cannot be verified/);
    assert.equal(safety.warnings.length, 0);
  } finally {
    process.env.PATH = savedPath;
  }
});

test('guard 1a: no .git anywhere up the tree is still just a warning', () => {
  const root = makeRepo({ git: false });
  initLayout(path.join(root, 'workspace'));
  const info = requireWorkspace({ repoRoot: root, env: {} });
  assert.match(info.warnings.join(' '), /not a git repository/);
});

test('guard 1b: .gitkeep staged with content is refused even when the working file is empty', () => {
  const root = makeRepo();
  const ws = path.join(root, 'workspace');
  initLayout(ws);
  write(path.join(ws, '.gitkeep'), 'customer data\n');
  execFileSync('git', ['add', '-f', 'workspace/.gitkeep'], { cwd: root });
  fs.writeFileSync(path.join(ws, '.gitkeep'), ''); // working copy emptied, index still holds the data
  const safety = checkWorkspaceSafety(ws, root);
  assert.deepEqual(safety.tracked, ['workspace/.gitkeep']);
  assert.throws(() => requireWorkspace({ repoRoot: root, env: {} }), /tracked by git/);
});

test('guard 1b: .gitkeep with content in the working tree is refused; empty in both places is allowed', () => {
  const root = makeRepo();
  const ws = path.join(root, 'workspace');
  initLayout(ws);
  write(path.join(ws, '.gitkeep'), '');
  execFileSync('git', ['add', '-f', 'workspace/.gitkeep'], { cwd: root });
  assert.equal(checkWorkspaceSafety(ws, root).problems.length, 0);
  fs.writeFileSync(path.join(ws, '.gitkeep'), 'now has data\n');
  assert.throws(() => requireWorkspace({ repoRoot: root, env: {} }), /tracked by git/);
});

test('guard 1c: an external workspace whose database/ is a symlink into the checkout is refused', () => {
  const root = makeRepo();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paths-ext-')));
  initLayout(outside);
  fs.mkdirSync(path.join(root, 'dbdir'));
  fs.rmSync(path.join(outside, 'database'), { recursive: true });
  fs.symlinkSync(path.join(root, 'dbdir'), path.join(outside, 'database'));
  fs.mkdirSync(path.join(outside, 'database', 'backups'));
  fs.writeFileSync(path.join(outside, 'database', 'mail-list.sqlite'), '');
  assert.throws(
    () => requireWorkspace({ repoRoot: root, workspace: outside, env: {} }),
    (err: unknown) => err instanceof PreconditionError && /not git-ignored|tracked by git/.test(err.message),
  );
});

test('guard 1c: an external workspace whose database file is a symlink to a tracked file in the checkout is refused', () => {
  const root = makeRepo();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paths-ext-')));
  initLayout(outside);
  write(path.join(root, 'loose.sqlite'), '');
  execFileSync('git', ['add', '-f', 'loose.sqlite'], { cwd: root });
  fs.rmSync(workspaceLayout(outside).dbPath);
  fs.symlinkSync(path.join(root, 'loose.sqlite'), workspaceLayout(outside).dbPath);
  assert.throws(
    () => requireWorkspace({ repoRoot: root, workspace: outside, env: {} }),
    (err: unknown) => err instanceof PreconditionError && /tracked by git/.test(err.message),
  );
});

test('assertPathSafe: outside the repo passes; ignored directories (existing or not) pass', () => {
  const root = makeRepo();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paths-out-')));
  assertPathSafe(path.join(outside, 'resources', 'shop'), { repoRoot: root });
  fs.mkdirSync(path.join(root, 'workspace', 'resources', 'shop'), { recursive: true });
  assertPathSafe(path.join(root, 'workspace', 'resources', 'shop'), { repoRoot: root });
  assertPathSafe(path.join(root, 'workspace', 'resources', 'not-yet-created'), { repoRoot: root });
});

test('assertPathSafe: refuses a directory git does not ignore, new files included (meta.md would be committable)', () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, 'sources', 'shop'), { recursive: true });
  assert.throws(
    () => assertPathSafe(path.join(root, 'sources', 'shop'), { repoRoot: root, what: 'The source directory' }),
    (err: unknown) => err instanceof PreconditionError && /^The source directory/.test(err.message) && /not git-ignored/.test(err.message),
  );
  // Only *.csv and *.sqlite are ignored by the repo-wide safety nets: the directory itself is not ignored.
  fs.writeFileSync(path.join(root, '.gitignore'), 'sources/shop/*.csv\n');
  assert.throws(() => assertPathSafe(path.join(root, 'sources', 'shop'), { repoRoot: root }), /not git-ignored/);
});

test('assertPathSafe: refuses tracked and unignored existing files; follows symlinks into the checkout', () => {
  const root = makeRepo();
  write(path.join(root, 'workspace', 'resources', 'shop', 'a.csv'));
  execFileSync('git', ['add', '-f', 'workspace/resources/shop/a.csv'], { cwd: root });
  assert.throws(() => assertPathSafe(path.join(root, 'workspace', 'resources', 'shop'), { repoRoot: root }), /tracked by git/);

  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paths-out-')));
  fs.mkdirSync(path.join(root, 'plain'));
  fs.symlinkSync(path.join(root, 'plain'), path.join(outside, 'link'));
  assert.throws(() => assertPathSafe(path.join(outside, 'link'), { repoRoot: root }), /not git-ignored/);
});

test('assertPathSafe: git unusable although .git exists -> refuses; no .git anywhere -> passes', () => {
  const broken = makeRepo({ git: false });
  fs.mkdirSync(path.join(broken, '.git'));
  assert.throws(() => assertPathSafe(path.join(broken, 'workspace'), { repoRoot: broken }), /cannot be verified/);
  const plain = makeRepo({ git: false });
  assertPathSafe(path.join(plain, 'anything'), { repoRoot: plain });
});

// --- round 3 (review R4) ---------------------------------------------------------------------------

test('R4-1a: a dangling .git symlink (git rev-parse exits 128) refuses; it is not "no git"', () => {
  const root = makeRepo({ git: false });
  fs.symlinkSync(path.join(root, 'no-such-git-dir'), path.join(root, '.git')); // dangling
  assert.equal(fs.existsSync(path.join(root, '.git')), false, 'existsSync cannot see a dangling symlink');
  initLayout(path.join(root, 'workspace'));
  const safety = checkWorkspaceSafety(path.join(root, 'workspace'), root);
  assert.equal(safety.warnings.filter((w) => /not a git repository/.test(w)).length, 0);
  assert.match(safety.problems.join(' '), /cannot be verified/);
  assert.throws(() => requireWorkspace({ repoRoot: root, env: {} }), (err: unknown) => err instanceof PreconditionError && /cannot be verified/.test(err.message));
  assert.throws(() => assertPathSafe(path.join(root, 'workspace', 'resources', 'shop'), { repoRoot: root }), /cannot be verified/);
});

test('R4-1a: a dangling .git deeper than a valid checkout (git skips it) still refuses', () => {
  const outer = makeRepo(); // valid checkout, workspace/* ignored
  const inner = path.join(outer, 'pkg');
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, 'package.json'), '{}\n');
  fs.symlinkSync(path.join(inner, 'missing'), path.join(inner, '.git'));
  initLayout(path.join(inner, 'workspace'));
  assert.match(checkWorkspaceSafety(path.join(inner, 'workspace'), inner).problems.join(' '), /cannot be verified/);
});

test('R4-1b: a workspace that is a sibling of the package inside an ancestor git checkout is checked there', () => {
  const outer = makeRepo({ gitignore: false });
  const pkg = path.join(outer, 'pkg'); // "this repository": a package directory without its own .git
  fs.mkdirSync(pkg);
  fs.writeFileSync(path.join(pkg, 'package.json'), '{}\n');
  const ws = path.join(outer, 'ws-sibling'); // outside pkg, inside the ancestor checkout
  initLayout(ws);

  // not ignored in the ancestor checkout: refused
  assert.equal(checkWorkspaceSafety(ws, pkg).insideRepo, true);
  assert.throws(
    () => requireWorkspace({ repoRoot: pkg, workspace: ws, env: {} }),
    (err: unknown) => err instanceof PreconditionError && /not git-ignored/.test(err.message),
  );

  // ignored in the ancestor checkout: fine
  fs.writeFileSync(path.join(outer, '.gitignore'), 'ws-sibling/\n');
  const info = requireWorkspace({ repoRoot: pkg, workspace: ws, env: {} });
  assert.equal(info.workspace, ws);

  // a tracked file there: refused again
  execFileSync('git', ['add', '-f', 'ws-sibling/resources'], { cwd: outer, stdio: 'ignore' });
  write(path.join(ws, 'resources', 'tracked.txt'));
  execFileSync('git', ['add', '-f', 'ws-sibling/resources/tracked.txt'], { cwd: outer });
  assert.throws(() => requireWorkspace({ repoRoot: pkg, workspace: ws, env: {} }), /tracked by git/);
});

test('R4-1b: assertPathSafe applies to whatever checkout contains the path, not only this repository', () => {
  const outer = makeRepo({ gitignore: false });
  const pkg = path.join(outer, 'pkg');
  fs.mkdirSync(pkg);
  fs.writeFileSync(path.join(pkg, 'package.json'), '{}\n');
  const dir = path.join(outer, 'elsewhere', 'src');
  fs.mkdirSync(dir, { recursive: true });
  assert.throws(
    () => assertPathSafe(dir, { repoRoot: pkg, what: 'The source directory' }),
    (err: unknown) => err instanceof PreconditionError && /^The source directory/.test(err.message) && /not git-ignored/.test(err.message),
  );
  fs.writeFileSync(path.join(outer, '.gitignore'), 'elsewhere/\n');
  assertPathSafe(dir, { repoRoot: pkg });
  // outside every checkout: passes
  assertPathSafe(path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paths-free-'))), 'x'), { repoRoot: pkg });
});
