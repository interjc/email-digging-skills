// init-workspace [--workspace <p>] [--demo] [--json]
// First command a new user runs (requirements §9.1). Idempotent, never overwrites anything:
// checks the toolchain, guards the workspace location, creates the layout, config.yaml and .env,
// migrates the database, wires the git hooks, and optionally builds a demo workspace from fixtures.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { EXIT } from './lib/types.ts';
import { PreconditionError } from './lib/errors.ts';
import { parseCliArgs, printWarnings, runCli } from './lib/cli.ts';
import { parseEnv, setEnvValue } from './lib/env.ts';
import { withWorkspaceLock } from './lib/lock.ts';
import { sanitizeDeep, sanitizeError } from './lib/sanitize.ts';
import { openDb, migrate } from './lib/db.ts';
import { cleanAndMerge } from './clean-and-merge.ts';
import {
  SAFETY_FIX, checkWorkspaceSafety, layoutDirs, repoRoot, resolveWorkspace, workspaceLayout,
} from './lib/paths.ts';
import type { ResolveOpts, WorkspaceLayout } from './lib/paths.ts';

export type CheckResult = 'ok' | 'warn' | 'fail' | 'skipped';

export interface CheckRow {
  check: string;
  result: CheckResult;
  detail: string;
  /** What to do when result is not ok. Empty when nothing is needed. */
  fix: string;
}

export interface InitOpts extends ResolveOpts {
  demo?: boolean;
  /** Skip the DuckDB load/extension check (unit tests that must not touch the network). */
  skipDuckdb?: boolean;
}

export interface InitResult {
  workspace: string;
  demo_workspace: string | null;
  ok: boolean;
  checks: CheckRow[];
  warnings: string[];
  next: string;
}

const MIN_NODE = [22, 18] as const;
const REQUIRED_EXTENSIONS = ['excel', 'sqlite'];
const OPTIONAL_EXTENSIONS = ['encodings'];

function row(check: string, result: CheckResult, detail: string, fix = ''): CheckRow {
  return { check, result, detail, fix };
}

const errText = sanitizeError;

// --- step 1: toolchain checks ------------------------------------------------------------------

function checkNode(): CheckRow {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return ok
    ? row('Node.js >= 22.18', 'ok', `v${process.versions.node}`)
    : row('Node.js >= 22.18', 'fail', `v${process.versions.node}`, 'install Node.js 22.18 or newer');
}

function checkDeps(root: string): CheckRow {
  const missing = ['@duckdb/node-api', 'yaml'].filter((m) => !fs.existsSync(path.join(root, 'node_modules', m)));
  return missing.length === 0
    ? row('pnpm dependencies', 'ok', 'installed')
    : row('pnpm dependencies', 'fail', `missing: ${missing.join(', ')}`, 'run `pnpm install`');
}

async function checkDuckdb(): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];
  let duck: typeof import('@duckdb/node-api');
  try {
    duck = await import('@duckdb/node-api');
  } catch (err) {
    return [row('DuckDB loads', 'fail', errText(err), 'run `pnpm install`')];
  }
  let instance: Awaited<ReturnType<typeof duck.DuckDBInstance.create>> | null = null;
  let conn: Awaited<ReturnType<typeof duck.DuckDBConnection.create>> | null = null;
  try {
    instance = await duck.DuckDBInstance.create(':memory:');
    conn = await instance.connect();
    const version = String((await conn.runAndReadAll('select version()')).getRows()[0]?.[0] ?? '?');
    rows.push(row('DuckDB loads', 'ok', version));

    const tryExtension = async (name: string, required: boolean): Promise<void> => {
      const label = `DuckDB extension ${name}${required ? '' : ' (optional)'}`;
      try {
        await conn!.run(`INSTALL ${name}; LOAD ${name};`);
        rows.push(row(label, 'ok', 'loaded'));
      } catch (err) {
        rows.push(row(
          label,
          required ? 'fail' : 'warn',
          errText(err),
          'INSTALL needs network access once: connect and re-run `pnpm init-workspace`' +
            (required ? '' : (name === 'encodings' ? ' (only needed for rare non-UTF-8 sources)' : '')),
        ));
      }
    };
    for (const e of REQUIRED_EXTENSIONS) await tryExtension(e, true);
    for (const e of OPTIONAL_EXTENSIONS) await tryExtension(e, false);
  } catch (err) {
    rows.push(row('DuckDB loads', 'fail', errText(err), 'run `pnpm install`; on an unsupported CPU/OS see the @duckdb/node-api docs'));
  } finally {
    conn?.closeSync();
    instance?.closeSync();
  }
  return rows;
}

// --- steps 3-6: files ---------------------------------------------------------------------------

function ensureLayout(layout: WorkspaceLayout): CheckRow {
  const created: string[] = [];
  for (const dir of layoutDirs(layout)) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      created.push(path.relative(layout.workspace, dir) || '.');
    }
  }
  return row('Workspace layout', 'ok', created.length > 0 ? `created ${created.length} director${created.length === 1 ? 'y' : 'ies'}` : 'already present');
}

/** Copy `from` to `to` only when `to` does not exist. Returns true when a file was created. */
function copyIfMissing(from: string, to: string, mode?: number): boolean {
  if (fs.existsSync(to)) return false;
  fs.copyFileSync(from, to);
  if (mode !== undefined) fs.chmodSync(to, mode);
  return true;
}

function ensureConfigFiles(root: string): CheckRow[] {
  const rows: CheckRow[] = [];

  const cfgFrom = path.join(root, 'config.example.yaml');
  const cfgTo = path.join(root, 'config.yaml');
  if (!fs.existsSync(cfgFrom) && !fs.existsSync(cfgTo)) {
    rows.push(row('config.yaml', 'warn', 'config.example.yaml not found', 'restore config.example.yaml from the repository'));
  } else {
    rows.push(row('config.yaml', 'ok', copyIfMissing(cfgFrom, cfgTo) ? 'created from config.example.yaml' : 'already present'));
  }

  const envFrom = path.join(root, '.env.example');
  const envTo = path.join(root, '.env');
  if (!fs.existsSync(envFrom) && !fs.existsSync(envTo)) {
    rows.push(row('.env', 'warn', '.env.example not found', 'restore .env.example from the repository'));
    return rows;
  }
  const created = copyIfMissing(envFrom, envTo, 0o600);
  rows.push(row('.env', 'ok', created ? 'created from .env.example' : 'already present'));
  rows.push(ensureHmacKey(envTo));
  return rows;
}

/** Fill MASK_HMAC_KEY with 32 random bytes (hex) when empty. Edits only that line; never prints the key. */
function ensureHmacKey(envFile: string): CheckRow {
  const text = fs.readFileSync(envFile, 'utf8');
  const current = parseEnv(text).MASK_HMAC_KEY;
  if (current !== undefined && current !== '') return row('MASK_HMAC_KEY', 'ok', 'already set');

  const key = crypto.randomBytes(32).toString('hex');
  // Edit the assignment the parser reads (the last one), so a duplicate empty line cannot shadow the key.
  const next = setEnvValue(text, 'MASK_HMAC_KEY', key);
  fs.writeFileSync(envFile, next);
  return row('MASK_HMAC_KEY', 'ok', 'generated (stored in .env, not shown)');
}

function migrateWorkspaceDb(layout: WorkspaceLayout, migrationsDir: string, label: string): CheckRow {
  if (!fs.existsSync(migrationsDir)) {
    return row(label, 'fail', `${migrationsDir} not found`, 'restore schema/migrations from the repository');
  }
  const db = openDb(layout.dbPath);
  try {
    const applied = migrate(db, migrationsDir);
    return row(label, 'ok', applied.length > 0 ? `applied ${applied.join(', ')}` : 'up to date');
  } catch (err) {
    return row(label, 'fail', errText(err), 'fix the migration error; the database was left unchanged');
  } finally {
    db.close();
  }
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function ensureGitHooks(root: string): CheckRow | null {
  if (!fs.existsSync(path.join(root, '.githooks'))) return null;
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (top === null || realpath(top) !== realpath(root)) {
    return row('git hooks', 'skipped', 'not a git repository (this directory is not a git top level)');
  }
  const current = git(root, ['config', '--local', '--get', 'core.hooksPath']);
  if (current !== null && current !== '') {
    return current === '.githooks'
      ? row('git hooks', 'ok', 'core.hooksPath already .githooks')
      : row('git hooks', 'warn', `core.hooksPath is already "${current}"`, 'run `git config core.hooksPath .githooks` if you want the repository hooks (staged-email scan)');
  }
  git(root, ['config', 'core.hooksPath', '.githooks']);
  return row('git hooks', 'ok', 'core.hooksPath set to .githooks');
}

// --- step 7: demo workspace -----------------------------------------------------------------------

function copyDirContents(from: string, to: string): number {
  if (!fs.existsSync(from)) return 0;
  let n = 0;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      n += copyDirContents(path.join(from, entry.name), dest);
    } else if (!fs.existsSync(dest)) {
      fs.copyFileSync(path.join(from, entry.name), dest);
      n++;
    }
  }
  return n;
}

async function setupDemo(root: string, ws: string, migrationsDir: string): Promise<{ rows: CheckRow[]; demoWorkspace: string }> {
  const demoWorkspace = path.join(ws, '.demo');
  const layout = workspaceLayout(demoWorkspace);
  const rows: CheckRow[] = [ensureLayout(layout)];
  rows[0] = { ...(rows[0] as CheckRow), check: 'Demo workspace layout' };

  const sourcesDir = path.join(root, 'fixtures', 'sources');
  const overridesDir = path.join(root, 'fixtures', 'overrides');
  if (!fs.existsSync(sourcesDir)) {
    rows.push(row('Demo fixtures', 'warn', 'fixtures/sources not found', 'restore fixtures/ from the repository (or run `node scripts/make-fixtures.ts`)'));
  } else {
    const copied = copyDirContents(sourcesDir, layout.resources) + copyDirContents(overridesDir, layout.overrides);
    rows.push(row('Demo fixtures', 'ok', copied > 0 ? `copied ${copied} file(s)` : 'already present'));
  }
  const dbRow = migrateWorkspaceDb(layout, migrationsDir, 'Demo database');
  rows.push(dbRow);
  const hasSources = fs.existsSync(layout.resources)
    && fs.readdirSync(layout.resources, { withFileTypes: true })
      .some((e) => e.isDirectory() && fs.existsSync(path.join(layout.resources, e.name, 'meta.md')));
  if (dbRow.result === 'fail' || !hasSources) {
    rows.push(row('Demo pipeline run', 'skipped', dbRow.result === 'fail' ? 'demo database not ready' : 'no fixture source with a meta.md'));
  } else {
    rows.push(await runDemoPipeline(root, demoWorkspace, layout));
  }
  return { rows, demoWorkspace };
}

/** Full clean-and-merge on the demo workspace (fixtures only), summarized in one row. */
async function runDemoPipeline(root: string, demoWorkspace: string, layout: WorkspaceLayout): Promise<CheckRow> {
  const fix = `run \`node scripts/clean-and-merge.ts --workspace ${demoWorkspace}\` to see the full output`;
  try {
    const r = await cleanAndMerge({ workspace: demoWorkspace, repoRoot: root });
    const m = r.report.merge;
    if (r.status === 'failed' || !m) return row('Demo pipeline run', 'warn', `clean-and-merge ${r.status}`, fix);
    const db = openDb(layout.dbPath, { readonly: true });
    let strict = 0;
    let notBlocked = 0;
    try {
      strict = Number((db.prepare('SELECT count(*) AS n FROM v_sendable_strict').get() as { n: number }).n);
      notBlocked = Number((db.prepare('SELECT count(*) AS n FROM v_not_blocked').get() as { n: number }).n);
    } finally {
      db.close();
    }
    const report = path.relative(demoWorkspace, r.paths.md);
    return row('Demo pipeline run', 'ok',
      `${m.contacts_total} contacts, ${m.cross_source_dups} in 2+ sources, strict list ${strict}, not blocked ${notBlocked}; report ${report}`);
  } catch (err) {
    return row('Demo pipeline run', 'warn', errText(err), fix);
  }
}

// --- orchestration ---------------------------------------------------------------------------------

export async function initWorkspace(opts: InitOpts = {}): Promise<InitResult> {
  const root = opts.repoRoot ?? repoRoot();
  const checks: CheckRow[] = [];

  // 2. workspace location and git-ignore guard. Runs before the slower toolchain checks (which may
  // download DuckDB extensions) and before anything is created, so a refusal changes nothing.
  const workspace = resolveWorkspace({ ...opts, repoRoot: root });
  const safety = checkWorkspaceSafety(workspace, root);
  if (safety.problems.length > 0) {
    throw new PreconditionError(
      safety.problems.join(' '),
      SAFETY_FIX,
    );
  }

  // D26: hold the exclusive workspace lock for everything that writes.
  return withWorkspaceLock(workspace, 'init-workspace', async (): Promise<InitResult> => {
    // 1. toolchain
    checks.push(checkNode(), checkDeps(root));
    if (opts.skipDuckdb) checks.push(row('DuckDB + extensions', 'skipped', 'skipped by caller'));
    else checks.push(...(await checkDuckdb()));
    checks.push(row(
      'Workspace location',
      safety.warnings.length > 0 ? 'warn' : 'ok',
      safety.insideRepo ? (safety.gitRepo ? 'inside the repository, git-ignored' : 'inside the repository (not a git repo)') : 'outside the repository',
      safety.warnings.length > 0 ? 'see warnings; prefer a folder that is not synced to a cloud provider' : '',
    ));

    // 3-5. layout, config.yaml, .env, database
    const layout = workspaceLayout(workspace);
    const migrationsDir = path.join(root, 'schema', 'migrations');
    checks.push(ensureLayout(layout));
    checks.push(...ensureConfigFiles(root));
    checks.push(migrateWorkspaceDb(layout, migrationsDir, 'Database'));

    // 6. git hooks
    const hooks = ensureGitHooks(root);
    if (hooks) checks.push(hooks);

    // 7. demo
    let demoWorkspace: string | null = null;
    if (opts.demo) {
      const demo = await setupDemo(root, workspace, migrationsDir);
      checks.push(...demo.rows);
      demoWorkspace = demo.demoWorkspace;
    }

    return {
      workspace,
      demo_workspace: demoWorkspace,
      ok: !checks.some((c) => c.result === 'fail'),
      checks,
      warnings: safety.warnings,
      next: 'add-source <name>',
    };
  });
}

function renderTable(result: InitResult): string {
  const header: [string, string, string] = ['Check', 'Result', 'Fix'];
  const rows = result.checks.map((c): [string, string, string] => [c.check, c.detail ? `${c.result} (${c.detail})` : c.result, c.fix]);
  const widths = [0, 1, 2].map((i) => Math.max(...[header, ...rows].map((r) => r[i as 0 | 1 | 2].length)));
  const fmt = (r: [string, string, string]) =>
    r.map((cell, i) => (i === 2 ? cell : cell.padEnd(widths[i] as number))).join('  ').trimEnd();
  return [fmt(header), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(fmt)].join('\n');
}

/**
 * What the CLI prints on stdout. Every value goes through sanitizeText (D28, D32): a workspace path can
 * hold anything, including something that looks like an address. JSON is sanitized value by value and
 * then serialized, so it always parses.
 */
export function renderInitOutput(result: InitResult, json: boolean): string {
  const safe = sanitizeDeep(result);
  if (json) return `${JSON.stringify(safe, null, 2)}\n`;
  return `Workspace: ${safe.workspace}\n\n${renderTable(safe)}\n\nNext: ${safe.next}\n`;
}

async function main(): Promise<number> {
  const { values } = parseCliArgs(process.argv.slice(2), { demo: { type: 'boolean', default: false } });
  const result = await initWorkspace({
    workspace: values.workspace as string | undefined,
    demo: values.demo === true,
  });

  if (values.json !== true) printWarnings(result.warnings);
  process.stdout.write(renderInitOutput(result, values.json === true));
  return result.ok ? EXIT.OK : EXIT.ERROR;
}

if (process.argv[1] && realpath(process.argv[1]) === realpath(import.meta.filename)) {
  await runCli(main);
}
