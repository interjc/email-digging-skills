// Locate the repository and the workspace, describe the workspace layout, and guard it.
// The guard is a privacy control: no command may run against a workspace that git could commit.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { loadEnv } from './env.ts';
import { PreconditionError } from './errors.ts';

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
  try {
    const doc = parseYaml(text) as unknown;
    if (doc && typeof doc === 'object' && 'workspace' in doc) {
      const v = (doc as { workspace: unknown }).workspace;
      return typeof v === 'string' ? nonEmpty(v) : null;
    }
  } catch {
    // ignored on purpose
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

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function git(root: string, args: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
    return { status: 0, stdout };
  } catch (err) {
    const status = (err as { status?: number | null }).status;
    return { status: typeof status === 'number' ? status : 127, stdout: '' };
  }
}

export interface WorkspaceSafety {
  insideRepo: boolean;
  gitRepo: boolean;
  /** Paths (relative to the workspace) that git would NOT ignore. Empty when safe. */
  notIgnored: string[];
  /** Non-empty = the workspace must not be used. */
  problems: string[];
  warnings: string[];
}

// Probe files that must be git-ignored. The first two are the required ones; the rest close the gap
// where the repo-wide `*.csv` / `*.sqlite` safety-net patterns would hide an unignored workspace.
const PROBES = [
  'resources/__probe__.csv',
  'database/__probe__.sqlite',
  'overrides/__probe__.yaml',
  'output/reports/__probe__.md',
  'output/exports/__probe__.json',
];

/** Check that a workspace inside the repository is git-ignored, and warn about cloud folders. */
export function checkWorkspaceSafety(workspace: string, root: string = repoRoot()): WorkspaceSafety {
  const result: WorkspaceSafety = { insideRepo: false, gitRepo: false, notIgnored: [], problems: [], warnings: [] };

  const cloud = cloudSyncWarning(workspace);
  if (cloud) result.warnings.push(cloud);

  const realRoot = realpathLoose(root);
  const realWs = realpathLoose(workspace);
  result.insideRepo = isInside(realWs, realRoot);
  if (!result.insideRepo) return result;

  result.gitRepo = git(realRoot, ['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true';
  if (!result.gitRepo) {
    result.warnings.push('The repository is not a git repository, so git-ignore protection cannot be verified.');
    return result;
  }

  const relWs = path.relative(realRoot, realWs);
  for (const probe of PROBES) {
    const rel = path.join(relWs, probe);
    if (git(realRoot, ['check-ignore', '-q', '--', rel]).status !== 0) result.notIgnored.push(probe);
  }
  if (result.notIgnored.length > 0) {
    result.problems.push(
      `The workspace (${workspace}) is inside the repository but not git-ignored ` +
      `(not ignored: ${result.notIgnored.join(', ')}). Real data could be committed.`,
    );
  }
  return result;
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
      'add `workspace/*` to .gitignore (or choose a workspace outside the repository with --workspace), then run `pnpm init-workspace`.',
    );
  }

  const missing = layoutDirs(layout).filter((d) => !isDir(d));
  if (missing.length > 0 || !fs.existsSync(layout.dbPath)) {
    const what = !isDir(workspace) ? `The workspace does not exist: ${workspace}` : `The workspace is not initialized: ${workspace}`;
    throw new PreconditionError(what, 'run `pnpm init-workspace` (add `--workspace <path>` for a custom location).');
  }

  return { workspace, layout, warnings: safety.warnings };
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
