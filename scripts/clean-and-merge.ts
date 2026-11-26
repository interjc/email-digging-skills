// clean-and-merge [--source <name>]... [--dry-run] [--workspace <p>] [--json]
// Read every source with a meta.md, stage it (clean, normalize, apply overrides), merge it into the
// main SQLite database and write the masked run report. Runs under the workspace lock (D26).
// Order: load all metas (any error → exit 1, nothing staged) → stage → [--dry-run: report, stop]
// → backup → runs row → merge (one transaction, committed) → run marked ok → reports → report_path.
// D30: a merge always processes every source with a meta.md; --source is allowed only with --dry-run.
// stdout is masked: everything printed goes through sanitizeText (D28).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import type { MergeStats, SourceMeta, SourceStageResult } from './lib/types.ts';
import { EXIT } from './lib/types.ts';
import { parseCliArgs, printWarnings, runCli } from './lib/cli.ts';
import { PreconditionError } from './lib/errors.ts';
import { repoRoot, requireWorkspace } from './lib/paths.ts';
import type { WorkspaceInfo } from './lib/paths.ts';
import { loadConfig } from './lib/config.ts';
import { loadOverrides } from './lib/overrides.ts';
import { loadMeta } from './lib/meta.ts';
import { stageSource } from './lib/stage.ts';
import { backupDb, backupStamp, migrate, openDb } from './lib/db.ts';
import { finishRun, mergeStaged, setRunReportPath, startRun, uniqueRunId } from './lib/merge.ts';
import { resolvePriority } from './lib/priority.ts';
import { buildReport, sanitizeDeep, writeReport } from './lib/report.ts';
import type { FullRunReport, RunStatus } from './lib/report.ts';
import { withWorkspaceLock } from './lib/lock.ts';
import { sanitizeText } from './lib/sanitize.ts';

const MIGRATIONS = path.join(import.meta.dirname, '..', 'schema', 'migrations');

export interface CleanAndMergeOptions {
  workspace?: string | null;
  /** Only these sources (default: every directory with a meta.md). Requires dryRun (D30). */
  sources?: string[];
  dryRun?: boolean;
  /** Repository root for config.yaml and the workspace guard. Default: this repository. */
  repoRoot?: string;
  /** Run timestamp (tests). Default: now. */
  now?: Date;
}

export interface CleanAndMergeResult {
  status: RunStatus;
  run_id: string;
  report: FullRunReport;
  paths: { json: string; md: string };
  backup_path: string | null;
  workspace_warnings: string[];
}

function errMessage(err: unknown): string {
  return sanitizeText(err instanceof Error ? err.message : String(err));
}

/** `base`, or `base-1`, `base-2` ... when a report with that id already exists. */
function freeReportId(reportsDir: string, base: string): string {
  let id = base;
  for (let n = 1; fs.existsSync(path.join(reportsDir, `${id}.json`)); n++) id = `${base}-${n}`;
  return id;
}

/** D32: recovery after a report publication failure. */
export const RERUN_ADVICE = 'Fix the cause and run clean-and-merge again (merges are full and idempotent)';

export const SOURCE_NEEDS_DRY_RUN = '--source is only allowed together with --dry-run: a merge always processes every source with a meta.md (D30)';

export async function cleanAndMerge(opts: CleanAndMergeOptions = {}): Promise<CleanAndMergeResult> {
  if (opts.sources && opts.sources.length > 0 && !opts.dryRun) throw new Error(SOURCE_NEEDS_DRY_RUN);
  const root = opts.repoRoot ?? repoRoot();
  const info = requireWorkspace({ workspace: opts.workspace, repoRoot: root });
  return withWorkspaceLock(info.workspace, 'clean-and-merge', () => runLocked(info, root, opts));
}

async function runLocked(info: WorkspaceInfo, root: string, opts: CleanAndMergeOptions): Promise<CleanAndMergeResult> {
  const { layout } = info;
  const warnings: string[] = [];
  const onWarning = (m: string) => warnings.push(sanitizeText(m));
  const config = loadConfig({ workspace: info.workspace, repoRoot: root, onWarning });
  const overrides = loadOverrides(layout.overrides);

  // Source directories: those without meta.md are skipped and listed ("run add-source").
  const dirs = fs.readdirSync(layout.resources, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
  const withoutMeta = dirs.filter((d) => !fs.existsSync(path.join(layout.resources, d, 'meta.md')));
  let selected = dirs.filter((d) => !withoutMeta.includes(d));
  if (opts.sources && opts.sources.length > 0) {
    const problems: string[] = [];
    for (const s of opts.sources) {
      if (!dirs.includes(s)) problems.push(`unknown source "${s}" (no directory resources/${s}/)`);
      else if (withoutMeta.includes(s)) problems.push(`source "${s}" has no meta.md (run add-source ${s})`);
    }
    if (problems.length > 0) throw new Error(problems.join('; '));
    selected = [...new Set(opts.sources)].sort();
  }
  if (selected.length === 0) {
    throw new Error('no source with a meta.md under resources/; put the export files in resources/<name>/ and run add-source <name>');
  }

  // Load every meta first: any error stops the run before anything is staged or written.
  const metas: SourceMeta[] = [];
  const metaErrors: string[] = [];
  for (const name of selected) {
    try {
      metas.push(loadMeta(path.join(layout.resources, name), onWarning));
    } catch (err) {
      metaErrors.push(errMessage(err));
    }
  }
  if (metaErrors.length > 0) {
    throw new Error(`meta.md is invalid; nothing was staged and the database is untouched.\n${metaErrors.join('\n')}`);
  }

  // Stage every source; a failing source (e.g. no email column) fails the run without a db write.
  const results: SourceStageResult[] = [];
  const errors: string[] = [];
  for (const meta of metas) {
    try {
      // Reader findings (e.g. xlsx columns beyond ZZ) go into the run warnings, the report and --json.
      results.push(await stageSource(meta, { stagingDir: layout.staging, overrides, onWarning: (m) => onWarning(`${meta.source}/${m}`) }));
    } catch (err) {
      errors.push(`${meta.source}: ${errMessage(err)}`);
    }
  }

  const now = opts.now ?? new Date();
  const stamp = backupStamp(now);
  const common = { sourcesWithoutMeta: withoutMeta, warnings, metas };
  const report = (runId: string, generatedAt: string, status: RunStatus, merge: MergeStats | null, extra: { errors?: string[]; priorityOrder?: string[]; mergedAt?: string | null } = {}) =>
    buildReport(results, merge, { ...common, runId, generatedAt, status, errors: extra.errors ?? [], priorityOrder: extra.priorityOrder, mergedAt: extra.mergedAt ?? null });
  const result = (status: RunStatus, rep: FullRunReport, paths: { json: string; md: string }, backup: string | null): CleanAndMergeResult =>
    ({ status, run_id: rep.run_id, report: rep, paths, backup_path: backup, workspace_warnings: info.warnings });

  if (errors.length > 0) {
    errors.push('the database was not changed');
    const rep = await report(freeReportId(layout.reports, stamp), now.toISOString(), 'failed', null, { errors });
    return result('failed', rep, writeReport(rep, layout.reports, info.workspace), null);
  }

  if (opts.dryRun) {
    const rep = await report(freeReportId(layout.reports, `${stamp}-dry-run`), now.toISOString(), 'dry-run', null, {
      priorityOrder: dryRunPriority(layout.dbPath, metas, config.sources.priority),
    });
    return result('dry-run', rep, writeReport(rep, layout.reports, info.workspace), null);
  }

  const backup = backupDb(layout.dbPath, layout.backups, config.backups.keep, now);
  const db = openDb(layout.dbPath);
  try {
    migrate(db, MIGRATIONS);
    const runId = uniqueRunId(db, freeReportId(layout.reports, stamp));
    // The run's own timestamp is unique (strictly after every earlier run), so orphaned_at /
    // updated_at written by this merge identify this run exactly (review-report relies on it).
    const nowIso = uniqueRunTime(db, now);
    startRun(db, runId, 'clean-and-merge', nowIso);

    let stats: MergeStats;
    try {
      stats = await mergeStaged(results, {
        db, config, metas, overrides, runId, now: nowIso, backupPath: backup, resourceSources: dirs, onWarning,
      });
    } catch (err) {
      // Mark the run failed first: a failure while writing the report must not prevent that.
      finishRun(db, runId, 'failed', new Date().toISOString(), null);
      const reason = errMessage(err);
      const errs = [`merge failed and was rolled back: ${reason}`, backup ? `backup of the database before this run: ${backup}` : 'no backup (the database did not exist)'];
      let paths: { json: string; md: string };
      let rep: FullRunReport;
      try {
        rep = await report(runId, nowIso, 'failed', null, { errors: errs });
        paths = writeReport(rep, layout.reports, info.workspace);
        setRunReportPath(db, runId, paths.md);
      } catch (reportErr) {
        throw new Error(`merge failed and was rolled back (run ${runId}): ${reason}; the failure report could not be written either: ${errMessage(reportErr)}`);
      }
      return result('failed', rep, paths, backup);
    }

    // Committed: record that before anything else can fail.
    finishRun(db, runId, 'ok', new Date().toISOString(), null);
    try {
      const rep = await report(runId, nowIso, 'ok', stats, { mergedAt: nowIso });
      const paths = writeReport(rep, layout.reports, info.workspace);
      setRunReportPath(db, runId, paths.md);
      return result('ok', rep, paths, backup);
    } catch (err) {
      throw new Error(`merge committed (run ${runId}); the report could not be written: ${errMessage(err)}. ${RERUN_ADVICE}`);
    }
  } finally {
    db.close();
  }
}

/** `now` as ISO-8601, moved 1 ms past the latest earlier run's started_at when needed. */
function uniqueRunTime(db: DatabaseSync, now: Date): string {
  const row = db.prepare('SELECT MAX(started_at) AS m FROM runs').get() as { m: string | null } | undefined;
  const last = row?.m ? Date.parse(row.m) : Number.NaN;
  const t = Number.isNaN(last) || now.getTime() > last ? now.getTime() : last + 1;
  return new Date(t).toISOString();
}

/** Priority order a merge would use, read from the database without writing to it. */
function dryRunPriority(dbPath: string, metas: SourceMeta[], configured: string[]): string[] {
  const rows: Array<{ name: string; exported_at: string | null }> = [];
  try {
    const db = openDb(dbPath, { readonly: true });
    try {
      for (const r of db.prepare('SELECT name, exported_at FROM sources').all()) rows.push({ name: String(r.name), exported_at: r.exported_at === null ? null : String(r.exported_at) });
    } finally {
      db.close();
    }
  } catch {
    // no database or no sources table yet
  }
  const staged = new Set(metas.map((m) => m.source));
  return resolvePriority([...rows.filter((r) => !staged.has(r.name)), ...metas.map((m) => ({ name: m.source, exported_at: m.exported_at }))], configured);
}

/** Short masked summary for stdout. */
export function renderSummary(r: CleanAndMergeResult): string {
  const rep = r.report;
  const L: string[] = [];
  L.push(`clean-and-merge ${r.run_id}: ${r.status}${r.status === 'dry-run' ? ' (nothing written to the database)' : ''}`);
  L.push(`Sources processed (${rep.stage.length}): ${rep.stage.map((s) => s.source).join(', ') || '-'}`);
  if (rep.sources_without_meta.length > 0) L.push(`Skipped, no meta.md (run add-source <name>): ${rep.sources_without_meta.join(', ')}`);
  const files = rep.stage.flatMap((s) => s.files);
  const sum = (k: 'rows_read' | 'empty' | 'invalid' | 'typo_suspect' | 'role') => files.reduce((n, f) => n + f[k], 0);
  L.push(`Rows read: ${sum('rows_read')} (empty ${sum('empty')}, invalid ${sum('invalid')}, role ${sum('role')}, typo suspects ${sum('typo_suspect')})`);
  if (rep.merge) {
    const m = rep.merge;
    L.push(`Contacts: ${m.contacts_total} (new ${m.contacts_new}, newly orphaned ${m.contacts_orphaned}, in 2+ sources ${m.cross_source_dups})`);
    const o = m.overrides_applied;
    L.push(`Overrides applied: typo ${o.typo}, exclude ${o.exclude}, suppressions ${o.suppressions}, consents ${o.consents}`);
  } else if (r.status === 'dry-run') {
    L.push(`Staged addresses: ${rep.staged_totals.unique_emails} unique, ${rep.staged_totals.cross_source_dups} in 2+ sources`);
  }
  const review = rep.samples.low_confidence_mappings.length + rep.samples.auto_encodings.length + rep.samples.typo.length;
  if (review > 0) {
    L.push(`To review: ${rep.samples.typo.length} typo suspect(s), ${rep.samples.low_confidence_mappings.length} low-confidence mapping(s), ${rep.samples.auto_encodings.length} detected encoding(s)`);
  }
  if (rep.warnings.length > 0) L.push(`Warnings (${rep.warnings.length}):`, ...rep.warnings.slice(0, 20).map((w) => `  - ${w}`));
  if (rep.errors.length > 0) L.push('Errors:', ...rep.errors.map((e) => `  - ${e}`));
  if (r.backup_path) L.push(`Backup: ${r.backup_path}`);
  L.push(`Report: ${r.paths.md}`);
  if (r.status !== 'failed') L.push('Next: review-report');
  return sanitizeText(L.join('\n'));
}

async function main(): Promise<number> {
  const { values } = parseCliArgs(process.argv.slice(2), {
    source: { type: 'string', multiple: true },
    'dry-run': { type: 'boolean', default: false },
  });
  const sources = (values.source as unknown as string[] | undefined) ?? [];
  let result: CleanAndMergeResult;
  try {
    result = await cleanAndMerge({ workspace: values.workspace as string | undefined, sources, dryRun: values['dry-run'] === true });
  } catch (err) {
    // D28: nothing thrown reaches the terminal unsanitized.
    if (err instanceof PreconditionError) throw new PreconditionError(sanitizeText(err.message), err.fix === null ? null : sanitizeText(err.fix));
    throw new Error(errMessage(err));
  }
  if (values.json === true) {
    const out = {
      status: result.status, run_id: result.run_id, report: result.paths, backup_path: result.backup_path,
      merge: result.report.merge, warnings: result.report.warnings, errors: result.report.errors,
      sources_without_meta: result.report.sources_without_meta,
    };
    // D32: sanitize value by value, then serialize (sanitizing the JSON text could break its syntax).
    process.stdout.write(`${JSON.stringify(sanitizeDeep(out), null, 2)}\n`);
  } else {
    printWarnings(result.workspace_warnings.map(sanitizeText));
    process.stdout.write(`${renderSummary(result)}\n`);
  }
  return result.status === 'failed' ? EXIT.ERROR : EXIT.OK;
}

function isEntryPoint(): boolean {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  await runCli(main);
}
