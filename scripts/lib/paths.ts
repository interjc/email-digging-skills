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

// --- git worktree discovery and the guard ----------------------------------------------------------------

type Discovery = { kind: 'yes'; top: string } | { kind: 'none' } | { kind: 'error' };

function lstatExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** The nearest existing directory at or above `real`. */
function nearestExistingDir(real: string): string {
  let cur = real;
  for (;;) {
    try {
      if (fs.statSync(cur).isDirectory()) return cur;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
}

/**
 * Which git worktree contains `real` (a realpath, which may not exist yet)? Asked from the path itself
 * (nearest existing ancestor), not from this repository, so a workspace that sits in some other checkout,
 * for example a sibling of this package inside an ancestor checkout, is found.
 *  - 'yes': git names the worktree top-level.
 *  - 'none': no `.git` entry anywhere up the tree: not in a git checkout.
 *  - 'error': a `.git` entry exists (a broken repository, a dangling symlink, an unreadable or unsafe
 *    directory) that git did not or could not use, or git cannot be run: the path cannot be verified, so
 *    callers must refuse. `.git` entries are tested with lstat, which also sees a dangling symlink.
 */
function discoverWorktree(real: string): Discovery {
  const dir = nearestExistingDir(real);
  const r = git(dir, ['rev-parse', '--show-toplevel']);
  const out = r.status === 0 ? r.stdout.trim() : '';
  const top = out !== '' ? realpathLoose(out) : null;
  for (let d = dir; ; ) {
    if (top !== null && d === top) break; // the top-level's own `.git` is the one git used
    if (lstatExists(path.join(d, '.git'))) return { kind: 'error' };
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return top !== null ? { kind: 'yes', top } : { kind: 'none' };
}

const GIT_UNVERIFIABLE =
  'git could not be run or a .git entry is unreadable or dangling (rev-parse failed although a .git exists), so git-ignore protection cannot be verified';

export interface WorkspaceSafety {
  /** The workspace, or any of its layout directories / database file, resolves inside a git checkout or this repository. */
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

// New files of these kinds must be ignored in every layout directory inside a checkout. The probe name is
// random per run, so a narrow ignore rule that matches only a fixed probe name cannot pass the guard.
const PROBE_SUFFIXES = ['csv', 'sqlite', 'json', 'yaml', 'md'];

function nulList(text: string): string[] {
  return text.split('\0').filter((s) => s !== '');
}

interface Group {
  top: string;
  dirs: Set<string>;
  files: Set<string>;
}

/**
 * Guard for a workspace that could end up in a git repository (D27, D32). For whatever worktree contains
 * the workspace (found from the workspace path itself), and for every layout directory and the database
 * file that resolves (realpath, so symlinks count) into some worktree, the workspace is unsafe unless
 *  - git tracks nothing there (the empty placeholder `<workspace>/.gitkeep` is allowed),
 *  - `git status --untracked-files=all` shows nothing (every existing file is ignored), and
 *  - new files of the usual kinds (random probe names) would be ignored.
 * A `.git` that git cannot resolve refuses. A repository without any `.git` only produces a warning.
 * Cloud-synced folders produce a warning.
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

  // Where does every relevant path live? Layout directories are resolved one by one (a symlinked
  // `resources` of an external workspace points somewhere else entirely).
  const wsDisc = discoverWorktree(realWs);
  const groups = new Map<string, Group>();
  let unverifiable = wsDisc.kind === 'error';
  let noGitInsideRepo = false;
  const redirected: string[] = [];

  const place = (real: string, isFileTarget: boolean, label: string): void => {
    const disc = isInside(real, realWs) && !isFileTarget ? wsDisc : discoverWorktree(real);
    if (disc.kind === 'error') {
      unverifiable = true;
      return;
    }
    if (disc.kind === 'none') {
      if (isInside(real, realRoot)) noGitInsideRepo = true;
      return;
    }
    let g = groups.get(disc.top);
    if (!g) {
      g = { top: disc.top, dirs: new Set(), files: new Set() };
      groups.set(disc.top, g);
    }
    (isFileTarget ? g.files : g.dirs).add(real);
    if (!isInside(realWs, disc.top)) redirected.push(label);
  };

  if (wsDisc.kind === 'yes') place(realWs, false, '.');
  else if (wsDisc.kind === 'none' && isInside(realWs, realRoot)) noGitInsideRepo = true;
  for (const dir of layoutDirs(layout)) {
    if (dir === layout.workspace) continue;
    place(realpathLoose(dir), false, path.relative(workspace, dir));
  }
  const realDb = realpathLoose(layout.dbPath);
  const dbParent = path.dirname(realDb);
  const dbCovered = [...groups.values()].some((g) => g.dirs.has(dbParent));
  if (!dbCovered) place(realDb, true, path.relative(workspace, layout.dbPath));

  result.insideRepo = groups.size > 0 || noGitInsideRepo;
  result.gitRepo = groups.size > 0;

  if (unverifiable) {
    result.problems.push(`The workspace (${workspace}) cannot be verified: ${GIT_UNVERIFIABLE}`);
    return result;
  }
  if (groups.size === 0) {
    if (noGitInsideRepo) {
      result.warnings.push('The repository is not a git repository, so git-ignore protection cannot be verified.');
    }
    return result;
  }

  const parts: string[] = [];
  for (const group of groups.values()) {
    const wsInGroup = isInside(realWs, group.top);
    const found = checkGroup(group, realWs, wsInGroup, result);
    if (found.length > 0) parts.push(...found);
  }
  result.notIgnored = [...new Set(result.notIgnored)];
  if (result.tracked.length > 0) {
    parts.push(`${result.tracked.length} file(s) are tracked by git (${sampleNames(result.tracked)})`);
  }
  if (result.notIgnored.length > 0) parts.push(`not git-ignored: ${sampleNames(result.notIgnored)}`);
  if (parts.length > 0) {
    if (redirected.length > 0) {
      parts.unshift(`${redirected.join(', ')} resolve${redirected.length === 1 ? 's' : ''} into the repository or another git checkout`);
    }
    result.problems.unshift(`The workspace (${workspace}) is inside the repository or another git checkout and real data could be committed: ${parts.join('; ')}`);
  }
  return result;
}

/** Run the tracked / untracked / probe checks for one worktree. Fills result.tracked and result.notIgnored. */
function checkGroup(group: Group, realWs: string, wsInGroup: boolean, result: WorkspaceSafety): string[] {
  const problems: string[] = [];
  const top = group.top;
  const rel = (abs: string) => path.relative(top, abs) || '.';
  const show = (abs: string) => (wsInGroup ? path.relative(realWs, abs) || '.' : rel(abs));
  const pathspecs = [...group.dirs, ...group.files].map(rel);

  // 1. tracked files
  const ls = git(top, ['ls-files', '-z', '--', ...pathspecs]);
  if (ls.status !== 0) problems.push('git could not list the tracked files (git ls-files failed), so the workspace cannot be verified');
  // The empty `<workspace>/.gitkeep` placeholder is the one file a repository may track: the working
  // file must be empty and, when it is in the index, the staged blob must be the empty blob too.
  const placeholderAbs = path.join(realWs, '.gitkeep');
  const placeholder = wsInGroup && group.dirs.has(realWs) && isEmptyFile(placeholderAbs) && indexBlobIsEmptyOrAbsent(top, rel(placeholderAbs))
    ? rel(placeholderAbs)
    : null;
  result.tracked.push(...nulList(ls.stdout).filter((f) => f !== placeholder));

  // 2. existing files that are neither tracked nor ignored
  const st = git(top, ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...pathspecs]);
  if (st.status !== 0) problems.push('git could not read the status (git status failed), so the workspace cannot be verified');
  result.notIgnored.push(...nulList(st.stdout).map((e) => e.slice(3)).filter((f) => f !== placeholder));

  // 3. new files must be ignored
  const stem = `__probe_${crypto.randomBytes(4).toString('hex')}__`;
  const probes: Array<{ abs: string; label: string }> = [];
  for (const dir of group.dirs) {
    for (const ext of PROBE_SUFFIXES) {
      probes.push({ abs: path.join(dir, `${stem}.${ext}`), label: `${show(dir)}/__probe__.${ext}`.replace(/^\.\//, '') });
    }
  }
  if (wsInGroup && group.dirs.has(realWs)) probes.push({ abs: path.join(realWs, '.lock'), label: '.lock' });
  if (probes.length > 0) {
    const ci = git(top, ['check-ignore', '-z', '--stdin'], probes.map((p) => `${rel(p.abs)}\0`).join(''));
    if (ci.status > 1) problems.push('git could not check the ignore rules (git check-ignore failed), so the workspace cannot be verified');
    const ignored = new Set(nulList(ci.stdout));
    for (const p of probes) if (!ignored.has(rel(p.abs))) result.notIgnored.push(p.label);
  }
  for (const file of group.files) {
    if (git(top, ['check-ignore', '-q', '--', rel(file)]).status !== 0) result.notIgnored.push(show(file));
  }
  return problems;
}

/** True when the path is not in the index, or its staged entry is a regular file with the empty blob. */
function indexBlobIsEmptyOrAbsent(top: string, relPath: string): boolean {
  const staged = git(top, ['ls-files', '-s', '-z', '--', relPath]);
  if (staged.status !== 0) return false;
  const entries = nulList(staged.stdout);
  if (entries.length === 0) return true;
  const emptyBlob = git(top, ['hash-object', '--stdin'], '').stdout.trim();
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
  'git-ignore the workspace in .gitignore (`workspace/*`), untrack anything git tracks there, or choose a workspace outside any git checkout with --workspace; then run `pnpm init-workspace`.';

export interface AssertPathSafeOpts {
  /** Kept for callers that pass it; the git worktree is found from the path itself. */
  repoRoot?: string;
  /** Names the thing in the error message, e.g. "The source directory". */
  what?: string;
  /** 'file': only the path itself is checked. Default 'auto': anything that is not an existing file is
   *  treated as a directory, and new files of the usual kinds inside it must be ignored too. */
  kind?: 'auto' | 'file';
}

/**
 * Refuse a path (resolved with realpath, so symlinks count) that lies inside any git worktree (found
 * from the path itself, D32) unless git ignores it and tracks nothing under it. Paths outside every
 * worktree pass. A `.git` that git cannot resolve refuses. Throws PreconditionError. Callers use it
 * before writing under a directory they were handed (e.g. a source directory before meta.md).
 */
export function assertPathSafe(target: string, opts: AssertPathSafeOpts = {}): void {
  const real = realpathLoose(target);
  const what = opts.what ?? 'The path';
  const refuse = (detail: string): never => {
    throw new PreconditionError(`${what} (${target}) is inside the repository or another git checkout and real data could be committed: ${detail}`, SAFETY_FIX);
  };

  const disc = discoverWorktree(real);
  if (disc.kind === 'none') return;
  if (disc.kind === 'error') refuse(GIT_UNVERIFIABLE);
  const top = (disc as { kind: 'yes'; top: string }).top;

  const rel = path.relative(top, real) || '.';
  const isFileTarget = opts.kind === 'file' || isFile(real);

  const ls = git(top, ['ls-files', '-z', '--', rel]);
  if (ls.status !== 0) refuse('git ls-files failed, so the path cannot be verified');
  const tracked = nulList(ls.stdout);
  if (tracked.length > 0) refuse(`${tracked.length} file(s) are tracked by git (${sampleNames(tracked)})`);

  const st = git(top, ['status', '--porcelain', '-z', '--untracked-files=all', '--', rel]);
  if (st.status !== 0) refuse('git status failed, so the path cannot be verified');
  const unignored = nulList(st.stdout).map((e) => e.slice(3));
  if (unignored.length > 0) refuse(`not git-ignored: ${sampleNames(unignored)}`);

  const paths = [rel];
  if (!isFileTarget) {
    const stem = `__probe_${crypto.randomBytes(4).toString('hex')}__`;
    for (const ext of PROBE_SUFFIXES) paths.push(path.join(rel, `${stem}.${ext}`));
  }
  const ci = git(top, ['check-ignore', '-z', '--stdin'], paths.map((p) => `${p}\0`).join(''));
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
