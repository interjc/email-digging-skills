// Locate the repository and the workspace, describe the workspace layout, and guard it.
// The guard is a privacy control: no command may run against a workspace that git could commit.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadEnv } from './env.ts';
import { PreconditionError } from './errors.ts';
import { parseYamlSafe, sanitizeText } from './sanitize.ts';

export interface WorkspaceLayout {
  workspace: string;
  resources: string;
  overrides: string;
  output: string;
  staging: string;
  reports: string;
  masked: string;
  exports: string;
  database: string;
  backups: string;
  /** database/mail-list.sqlite */
  dbPath: string;
}

export interface ResolveOpts {
  /** Value of --workspace (relative paths resolve against the current directory). */
  workspace?: string | null;
  /** Repository root. Default: the repository this file lives in. Tests pass a temp repo. */
  repoRoot?: string;
  /** Process environment. Default: process.env. */
  env?: Record<string, string | undefined>;
}

/** Directory containing this repository's package.json, found from this file's location. */
export function repoRoot(): string {
  let dir = import.meta.dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Cannot find the repository root (no package.json above scripts/lib).');
    dir = parent;
  }
}

function nonEmpty(v: string | undefined | null): string | null {
  return v !== undefined && v !== null && v.trim() !== '' ? v.trim() : null;
}

/** `workspace:` value of <repo>/config.yaml, or null. Invalid YAML is reported by loadConfig, not here. */
function configWorkspace(root: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, 'config.yaml'), 'utf8');
  } catch {
    return null;
  }
  const { value: doc, errors } = parseYamlSafe(text);
  if (errors.length === 0 && doc && typeof doc === 'object' && 'workspace' in doc) {
    const v = (doc as { workspace: unknown }).workspace;
    return typeof v === 'string' ? nonEmpty(v) : null;
  }
  return null;
}

/**
 * Resolution order: --workspace flag > MAIL_PIPELINE_WORKSPACE (process env, then .env) >
 * config.yaml `workspace` > <repo>/workspace. Flag and process env resolve against the current
 * directory; .env and config.yaml values against the repository root. Returns an absolute path.
 */
export function resolveWorkspace(opts: ResolveOpts = {}): string {
  const root = opts.repoRoot ?? repoRoot();
  const env = opts.env ?? process.env;

  const flag = nonEmpty(opts.workspace);
  if (flag) return path.resolve(flag);

  const fromProcess = nonEmpty(env.MAIL_PIPELINE_WORKSPACE);
  if (fromProcess) return path.resolve(fromProcess);

  const fromDotEnv = nonEmpty(loadEnv(root).MAIL_PIPELINE_WORKSPACE);
  if (fromDotEnv) return path.resolve(root, fromDotEnv);

  const fromConfig = configWorkspace(root);
  if (fromConfig) return path.resolve(root, fromConfig);

  return path.join(root, 'workspace');
}

export function workspaceLayout(workspace: string): WorkspaceLayout {
  const output = path.join(workspace, 'output');
  const database = path.join(workspace, 'database');
  return {
    workspace,
    resources: path.join(workspace, 'resources'),
    overrides: path.join(workspace, 'overrides'),
    output,
    staging: path.join(output, 'staging'),
    reports: path.join(output, 'reports'),
    masked: path.join(output, 'masked'),
    exports: path.join(output, 'exports'),
    database,
    backups: path.join(database, 'backups'),
    dbPath: path.join(database, 'mail-list.sqlite'),
  };
}

/** Directories init-workspace creates and the guard expects. */
export function layoutDirs(layout: WorkspaceLayout): string[] {
  return [
    layout.workspace, layout.resources, layout.overrides, layout.output,
    layout.staging, layout.reports, layout.masked, layout.exports, layout.database, layout.backups,
  ];
}

const CLOUD_MARKERS = ['Library/Mobile Documents', 'Dropbox', 'OneDrive', 'Google Drive', 'iCloud'];

/** Warning text when the path looks like a cloud-synced folder, else null. */
export function cloudSyncWarning(ws: string): string | null {
  const normalized = ws.replaceAll('\\', '/');
  const hit = CLOUD_MARKERS.find((m) => normalized.includes(m));
  return hit
    ? `The workspace is in a cloud-synced folder (matches "${hit}"). Customer data would be copied to that provider.`
    : null;
}

/** realpath of the deepest existing ancestor + the not-yet-existing rest. */
function realpathLoose(p: string): string {
  const rest: string[] = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** True when `child` is `parent` or below it. Uses path.relative: a directory named `..private` is inside. */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  return rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel);
}

function git(root: string, args: string[], input?: string): { status: number; stdout: string } {
  // check-ignore rejects --literal-pathspecs; every other call here passes paths as pathspecs.
  const literal = args[0] === 'check-ignore' ? [] : ['--literal-pathspecs'];
  const r = spawnSync('git', [...literal, ...args], {
    cwd: root, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'], encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  return { status: typeof r.status === 'number' ? r.status : 127, stdout: r.stdout ?? '' };
}

/**
 * Is `realRoot` inside a git work tree?
 *  - 'yes': git confirms it.
 *  - 'none': no `.git` anywhere up the tree: a genuine non-git checkout (warn only).
 *  - 'error': a `.git` exists up the tree but git cannot confirm (git missing, broken repository, exit 128):
 *    the workspace cannot be verified, so callers must refuse.
 */
function gitState(realRoot: string): 'yes' | 'none' | 'error' {
  if (git(realRoot, ['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true') return 'yes';
  for (let dir = realRoot; ; ) {
    if (fs.existsSync(path.join(dir, '.git'))) return 'error';
    const parent = path.dirname(dir);
    if (parent === dir) return 'none';
    dir = parent;
  }
}

const GIT_UNVERIFIABLE =
  'git could not be run or the repository is unreadable (rev-parse failed although a .git exists), so git-ignore protection cannot be verified';

export interface WorkspaceSafety {
  /** The workspace, or any of its layout directories / database file, resolves inside the repository. */
  insideRepo: boolean;
  gitRepo: boolean;
  /** Files tracked by git under the workspace (relative paths). */
  tracked: string[];
  /** Existing files git would not ignore, and probe paths that would not be ignored. Empty when safe. */
  notIgnored: string[];
  /** Non-empty = the workspace must not be used. */
  problems: string[];
  warnings: string[];
}

// New files of these kinds must be ignored in every in-repo layout directory. The probe name is random
// per run, so a narrow ignore rule that matches only a fixed probe name cannot pass the guard.
const PROBE_SUFFIXES = ['csv', 'sqlite', 'json', 'yaml', 'md'];

function nulList(text: string): string[] {
  return text.split('\0').filter((s) => s !== '');
}

/**
 * Guard for a workspace that could end up in the repository (D27). The workspace is unsafe unless, for
 * every layout directory and the database file that resolves (realpath, so symlinks count) inside the repo:
 *  - git tracks nothing there (the placeholder `<workspace>/.gitkeep` is allowed),
 *  - `git status --untracked-files=all` shows nothing (every existing file is ignored), and
 *  - new files of the usual kinds (random probe names) would be ignored.
 * A repository that is not a git repo only produces a warning. Cloud-synced folders produce a warning.
 */
export function checkWorkspaceSafety(workspace: string, root: string = repoRoot()): WorkspaceSafety {
  const result: WorkspaceSafety = {
    insideRepo: false, gitRepo: false, tracked: [], notIgnored: [], problems: [], warnings: [],
  };

  const cloud = cloudSyncWarning(workspace);
  if (cloud) result.warnings.push(cloud);

  const realRoot = realpathLoose(root);
  const layout = workspaceLayout(workspace);
  const realWs = realpathLoose(workspace);
  const wsInside = isInside(realWs, realRoot);

  // Layout directories that land inside the checkout, by real path (this catches a symlinked
  // `resources` of an external workspace as well as every directory of an in-repo workspace).
  const dirs = new Set<string>();
  if (wsInside) dirs.add(realWs);
  const redirected: string[] = [];
  for (const dir of layoutDirs(layout)) {
    const real = realpathLoose(dir);
    if (!isInside(real, realRoot)) continue;
    dirs.add(real);
    if (!wsInside) redirected.push(path.relative(workspace, dir) || '.');
  }
  const realDb = realpathLoose(layout.dbPath);
  const dbFile = isInside(realDb, realRoot) && (wsInside ? true : !dirs.has(path.dirname(realDb))) ? realDb : null;
  if (dbFile && !wsInside) redirected.push(path.relative(workspace, layout.dbPath));

  result.insideRepo = dirs.size > 0 || dbFile !== null;
  if (!result.insideRepo) return result;

  const state = gitState(realRoot);
  result.gitRepo = state === 'yes';
  if (state === 'error') {
    result.problems.push(`The workspace (${workspace}) is inside the repository but ${GIT_UNVERIFIABLE}`);
    return result;
  }
  if (state === 'none') {
    result.warnings.push('The repository is not a git repository, so git-ignore protection cannot be verified.');
    return result;
  }

  const rel = (abs: string) => path.relative(realRoot, abs) || '.';
  const show = (abs: string) => (wsInside ? path.relative(realWs, abs) || '.' : rel(abs));
  const pathspecs = [...dirs, ...(dbFile ? [dbFile] : [])].map(rel);

  // 1. tracked files
  const ls = git(realRoot, ['ls-files', '-z', '--', ...pathspecs]);
  if (ls.status !== 0) {
    result.problems.push('git could not list the tracked files (git ls-files failed), so the workspace cannot be verified');
  }
  // The empty `<workspace>/.gitkeep` placeholder is the one file the repository may track: the working
  // file must be empty and, when it is in the index, the staged blob must be the empty blob too.
  const placeholderAbs = path.join(realWs, '.gitkeep');
  const placeholder = wsInside && isEmptyFile(placeholderAbs) && indexBlobIsEmptyOrAbsent(realRoot, rel(placeholderAbs))
    ? rel(placeholderAbs)
    : null;
  result.tracked = nulList(ls.stdout).filter((f) => f !== placeholder);

  // 2. existing files that are neither tracked nor ignored
  const st = git(realRoot, ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...pathspecs]);
  if (st.status !== 0) {
    result.problems.push('git could not read the status (git status failed), so the workspace cannot be verified');
  }
  const unignored = nulList(st.stdout).map((e) => e.slice(3)).filter((f) => f !== placeholder);
  result.notIgnored.push(...unignored);

  // 3. new files must be ignored
  const stem = `__probe_${crypto.randomBytes(4).toString('hex')}__`;
  const probes: Array<{ abs: string; label: string }> = [];
  for (const dir of dirs) {
    for (const ext of PROBE_SUFFIXES) {
      probes.push({ abs: path.join(dir, `${stem}.${ext}`), label: `${show(dir)}/__probe__.${ext}`.replace(/^\.\//, '') });
    }
  }
  if (wsInside) probes.push({ abs: path.join(realWs, '.lock'), label: '.lock' });
  if (probes.length > 0) {
    const ci = git(realRoot, ['check-ignore', '-z', '--stdin'], probes.map((p) => `${rel(p.abs)}\0`).join(''));
    if (ci.status > 1) {
      result.problems.push('git could not check the ignore rules (git check-ignore failed), so the workspace cannot be verified');
    }
    const ignored = new Set(nulList(ci.stdout));
    for (const p of probes) if (!ignored.has(rel(p.abs))) result.notIgnored.push(p.label);
  }
  if (dbFile) {
    const ci = git(realRoot, ['check-ignore', '-q', '--', rel(dbFile)]);
    if (ci.status !== 0) result.notIgnored.push(show(dbFile));
  }

  result.notIgnored = [...new Set(result.notIgnored)];
  const parts: string[] = [];
  if (result.tracked.length > 0) {
    parts.push(`${result.tracked.length} file(s) are tracked by git (${sampleNames(result.tracked)})`);
  }
  if (result.notIgnored.length > 0) parts.push(`not git-ignored: ${sampleNames(result.notIgnored)}`);
  if (parts.length > 0) {
    if (redirected.length > 0) parts.unshift(`${redirected.join(', ')} resolve${redirected.length === 1 ? 's' : ''} into the repository`);
    result.problems.unshift(`The workspace (${workspace}) is inside the repository and real data could be committed: ${parts.join('; ')}`);
  }
  return result;
}

/** True when the path is not in the index, or its staged entry is a regular file with the empty blob. */
function indexBlobIsEmptyOrAbsent(realRoot: string, relPath: string): boolean {
  const staged = git(realRoot, ['ls-files', '-s', '-z', '--', relPath]);
  if (staged.status !== 0) return false;
  const entries = nulList(staged.stdout);
  if (entries.length === 0) return true;
  const emptyBlob = git(realRoot, ['hash-object', '--stdin'], '').stdout.trim();
  return emptyBlob !== '' && entries.every((e) => {
    const m = /^(\d+) ([0-9a-f]+) (\d)\t/.exec(e);
    return m !== null && m[1] === '100644' && m[2] === emptyBlob;
  });
}

function isEmptyFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size === 0;
  } catch {
    return false;
  }
}

function sampleNames(names: string[]): string {
  const shown = names.slice(0, 3).map(sanitizeText).join(', ');
  return names.length > 3 ? `${shown}, and ${names.length - 3} more` : shown;
}

/** Fix text shared by every refusal of an unsafe workspace. */
export const SAFETY_FIX =
  'git-ignore the workspace in .gitignore (`workspace/*`), untrack anything git tracks there, or choose a workspace outside the repository with --workspace; then run `pnpm init-workspace`.';

export interface AssertPathSafeOpts {
  repoRoot?: string;
  /** Names the thing in the error message, e.g. "The source directory". */
  what?: string;
  /** 'file': only the path itself is checked. Default 'auto': anything that is not an existing file is
   *  treated as a directory, and new files of the usual kinds inside it must be ignored too. */
  kind?: 'auto' | 'file';
}

/**
 * Refuse a path (resolved with realpath, so symlinks count) that lies inside the repository unless git
 * ignores it and tracks nothing under it. Paths outside the repository pass. Throws PreconditionError.
 * Callers use it before writing under a directory they were handed (e.g. a source directory before meta.md).
 */
export function assertPathSafe(target: string, opts: AssertPathSafeOpts = {}): void {
  const root = realpathLoose(opts.repoRoot ?? repoRoot());
  const real = realpathLoose(target);
  if (!isInside(real, root)) return;

  const what = opts.what ?? 'The path';
  const refuse = (detail: string): never => {
    throw new PreconditionError(`${what} (${target}) is inside the repository and real data could be committed: ${detail}`, SAFETY_FIX);
  };

  const state = gitState(root);
  if (state === 'none') return;
  if (state === 'error') refuse(GIT_UNVERIFIABLE);

  const rel = path.relative(root, real) || '.';
  const isFileTarget = opts.kind === 'file' || isFile(real);

  const ls = git(root, ['ls-files', '-z', '--', rel]);
  if (ls.status !== 0) refuse('git ls-files failed, so the path cannot be verified');
  const tracked = nulList(ls.stdout);
  if (tracked.length > 0) refuse(`${tracked.length} file(s) are tracked by git (${sampleNames(tracked)})`);

  const st = git(root, ['status', '--porcelain', '-z', '--untracked-files=all', '--', rel]);
  if (st.status !== 0) refuse('git status failed, so the path cannot be verified');
  const unignored = nulList(st.stdout).map((e) => e.slice(3));
  if (unignored.length > 0) refuse(`not git-ignored: ${sampleNames(unignored)}`);

  const paths = [rel];
  if (!isFileTarget) {
    const stem = `__probe_${crypto.randomBytes(4).toString('hex')}__`;
    for (const ext of PROBE_SUFFIXES) paths.push(path.join(rel, `${stem}.${ext}`));
  }
  const ci = git(root, ['check-ignore', '-z', '--stdin'], paths.map((p) => `${p}\0`).join(''));
  if (ci.status > 1) refuse('git check-ignore failed, so the path cannot be verified');
  const ignored = new Set(nulList(ci.stdout));
  const missing = paths.filter((p) => !ignored.has(p));
  if (missing.length > 0) {
    refuse(`not git-ignored: ${missing.map((p) => (p === rel ? rel : `<new .${path.extname(p).slice(1)} file>`)).map(sanitizeText).join(', ')}`);
  }
}

export interface WorkspaceInfo {
  workspace: string;
  layout: WorkspaceLayout;
  warnings: string[];
}

/**
 * Guard every CLI except init-workspace calls first. Throws PreconditionError (exit 2) when the
 * workspace is not initialized or could be committed to git. Cloud-folder and non-git findings are
 * returned as warnings.
 */
export function requireWorkspace(opts: ResolveOpts = {}): WorkspaceInfo {
  const root = opts.repoRoot ?? repoRoot();
  const workspace = resolveWorkspace({ ...opts, repoRoot: root });
  const layout = workspaceLayout(workspace);

  const safety = checkWorkspaceSafety(workspace, root);
  if (safety.problems.length > 0) {
    throw new PreconditionError(
      safety.problems.join(' '),
      SAFETY_FIX,
    );
  }

  // The database file's real location must be safe too (an external workspace whose database/ or
  // mail-list.sqlite is a symlink into the checkout).
  assertPathSafe(layout.dbPath, { repoRoot: root, what: 'The database file', kind: 'file' });

  const missing = layoutDirs(layout).filter((d) => !isDir(d));
  if (missing.length > 0 || !isFile(layout.dbPath)) {
    const what = !isDir(workspace) ? `The workspace does not exist: ${workspace}` : `The workspace is not initialized: ${workspace}`;
    throw new PreconditionError(what, 'run `pnpm init-workspace` (add `--workspace <path>` for a custom location).');
  }

  return { workspace, layout, warnings: safety.warnings };
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
