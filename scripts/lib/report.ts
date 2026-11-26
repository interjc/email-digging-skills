// Run report of clean-and-merge (requirements §6.4): JSON + Markdown under output/reports/.
// Masked only: samples go through maskEmail, and every string is passed through the address
// sanitizer before it is written (D28), so a header or an error message cannot leak an address.

import fs from 'node:fs';
import path from 'node:path';
import type { ColumnMapping, MergeStats, ResolvedEncoding, RunReport, SourceMeta, SourceStageResult } from './types.ts';
import { maskEmail } from './mask.ts';
import { sanitizeText } from './sanitize.ts';
import { writeFileInWorkspace } from './fsafe.ts';
import { readRejectedRows, readStagedRows } from './merge.ts';
import { REVIEW_THRESHOLD } from './read/synonyms.ts';
import { decodeBytes } from './read/decode.ts';

/** At most this many entries per sample list. */
export const SAMPLE_LIMIT = 20;

export type RunStatus = 'ok' | 'failed' | 'dry-run';

/** RunReport plus what the Markdown and review-report need (warnings, run status, errors). */
export interface FullRunReport extends RunReport {
  status: RunStatus;
  dry_run: boolean;
  /** The `now` the merge wrote as orphaned_at / updated_at; null when nothing was merged. */
  merged_at: string | null;
  /** Resolved priority order (also for a dry run, computed without writing). */
  priority_order: string[];
  /** Directories under resources/ without meta.md (skipped; run add-source). */
  sources_without_meta: string[];
  /** Totals over the staged rows only (meaningful for a dry run). */
  staged_totals: { unique_emails: number; cross_source_dups: number; rejected_rows: number };
  warnings: string[];
  errors: string[];
}

export interface BuildReportOptions {
  runId: string;
  generatedAt: string;
  status: RunStatus;
  mergedAt?: string | null;
  priorityOrder?: string[];
  sourcesWithoutMeta?: string[];
  warnings?: string[];
  errors?: string[];
  /** meta.md of the staged sources: used to list the encoding candidates of auto-detected files. */
  metas?: SourceMeta[];
}

/** Every string inside `value` passed through sanitizeText (objects and arrays are copied). */
export function sanitizeDeep<T>(value: T): T {
  if (typeof value === 'string') return sanitizeText(value) as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeDeep(v)])) as T;
  }
  return value;
}

export function lowConfidenceMappings(stage: SourceStageResult[]): RunReport['samples']['low_confidence_mappings'] {
  const out: RunReport['samples']['low_confidence_mappings'] = [];
  for (const s of stage) {
    for (const f of s.files) {
      for (const m of f.mappings) if (m.column !== null && m.confidence < REVIEW_THRESHOLD) out.push({ source: s.source, file: f.file, mapping: m });
    }
  }
  return out;
}

/**
 * Files whose encoding was detected (`encoding: auto`). FileStats does not carry the probe's candidate
 * list, so with `metas` the file is decoded again (Node only, no DuckDB) to list every candidate.
 */
export function autoEncodings(stage: SourceStageResult[], metas: SourceMeta[] = []): RunReport['samples']['auto_encodings'] {
  const metaBy = new Map(metas.map((m) => [m.source, m]));
  const out: RunReport['samples']['auto_encodings'] = [];
  for (const s of stage) {
    for (const f of s.files) {
      if (f.encodingHow !== 'detected') continue;
      let candidates: ResolvedEncoding[] = f.encoding === null ? [] : [f.encoding];
      const meta = metaBy.get(s.source);
      const mf = meta?.files.find((x) => x.name === f.file);
      if (meta && mf) {
        try {
          const bytes = fs.readFileSync(path.join(meta.dir, f.file));
          candidates = decodeBytes(bytes, 'auto', { headerRow: mf.header_row ?? 1 }).candidates;
        } catch {
          // keep the encoding actually used
        }
      }
      out.push({ source: s.source, file: f.file, encoding: f.encoding, candidates });
    }
  }
  return out;
}

/** Build the report from the staging results and (unless dry run / failed) the merge stats. */
export async function buildReport(stage: SourceStageResult[], merge: MergeStats | null, opts: BuildReportOptions): Promise<FullRunReport> {
  const invalid: RunReport['samples']['invalid'] = [];
  const typo = new Map<string, { masked: string; masked_suggestion: string; sources: Set<string> }>();
  const emailSources = new Map<string, Set<string>>();
  let rejectedTotal = 0;

  for (const s of stage) {
    for (const r of await readRejectedRows(s.dir)) {
      rejectedTotal++;
      if (r.reason === 'empty' || invalid.length >= SAMPLE_LIMIT) continue;
      invalid.push({ source: s.source, file: r.file, row_number: r.row_number, masked: r.raw_value === null ? '' : maskEmail(r.raw_value), reason: r.reason });
    }
    for (const r of await readStagedRows(s.dir)) {
      const set = emailSources.get(r.email) ?? new Set<string>();
      set.add(s.source);
      emailSources.set(r.email, set);
      if (r.email_status !== 'typo_suspect') continue;
      const t = typo.get(r.email);
      if (t) t.sources.add(s.source);
      else if (typo.size < SAMPLE_LIMIT) {
        typo.set(r.email, { masked: maskEmail(r.email), masked_suggestion: r.suggested_email ? maskEmail(r.suggested_email) : '', sources: new Set([s.source]) });
      }
    }
  }

  const report: FullRunReport = {
    run_id: opts.runId,
    generated_at: opts.generatedAt,
    status: opts.status,
    dry_run: opts.status === 'dry-run',
    merged_at: opts.mergedAt ?? null,
    stage,
    merge,
    priority_order: merge?.priority_order ?? opts.priorityOrder ?? [],
    sources_without_meta: opts.sourcesWithoutMeta ?? [],
    staged_totals: {
      unique_emails: emailSources.size,
      cross_source_dups: [...emailSources.values()].filter((s) => s.size >= 2).length,
      rejected_rows: rejectedTotal,
    },
    samples: {
      invalid,
      typo: [...typo.values()].map((t) => ({ masked: t.masked, masked_suggestion: t.masked_suggestion, sources: [...t.sources].sort() })),
      low_confidence_mappings: lowConfidenceMappings(stage).slice(0, SAMPLE_LIMIT),
      auto_encodings: autoEncodings(stage, opts.metas).slice(0, SAMPLE_LIMIT),
    },
    warnings: opts.warnings ?? [],
    errors: opts.errors ?? [],
  };
  return sanitizeDeep(report);
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function cell(v: unknown): string {
  return String(v ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

/** Append every item (a loop: no argument spread, whatever the length). */
function pushAll(out: string[], items: string[], ...more: string[]): void {
  for (const i of items) out.push(i);
  for (const m of more) out.push(m);
}

function table(header: string[], rows: unknown[][]): string[] {
  return [`| ${header.map(cell).join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)];
}

function mappingText(m: ColumnMapping): string {
  return m.column === null ? `${m.field}: —` : `${m.field}←${m.column} (${m.how} ${m.confidence})`;
}

export function renderMarkdown(r: FullRunReport): string {
  const L: string[] = [];
  L.push(`# Clean-and-merge report ${r.run_id}`, '');
  L.push(`- Generated: ${r.generated_at}`);
  L.push(`- Status: ${r.status}${r.dry_run ? ' (dry run: nothing was written to the database)' : ''}`);
  if (r.merge?.backup_path) L.push(`- Backup: ${r.merge.backup_path}`);
  L.push(`- Sources processed: ${r.stage.map((s) => s.source).join(', ') || '—'}`);
  if (r.sources_without_meta.length > 0) L.push(`- Skipped (no meta.md, run add-source): ${r.sources_without_meta.join(', ')}`);
  L.push('');

  if (r.errors.length > 0) {
    L.push('## Errors', '');
    pushAll(L, r.errors.map((e) => `- ${cell(e)}`), '');
  }

  L.push('## Files', '');
  const fileRows: unknown[][] = [];
  for (const s of r.stage) {
    for (const f of s.files) {
      const enc = f.encoding === null ? `n/a (${f.encodingHow})` : `${f.encoding} (${f.encodingHow})`;
      fileRows.push([s.source, f.file, f.rows_read, f.empty, f.invalid, f.cells_split, f.dup_in_file, f.role, f.typo_suspect, enc, f.mappings.map(mappingText).join('; ')]);
    }
  }
  pushAll(L, table(['source', 'file', 'rows_read', 'empty', 'invalid', 'cells_split', 'dup_in_file', 'role', 'typo_suspect', 'encoding', 'mappings'], fileRows), '');

  L.push('## Totals', '');
  pushAll(L, table(['source', 'staged rows', 'rejected rows', 'unique addresses'], r.stage.map((s) => [s.source, s.staged_rows, s.rejected_rows, s.unique_emails])), '');
  if (r.merge) {
    const m = r.merge;
    L.push(`- Unique contacts (not orphaned): ${m.contacts_total}`);
    L.push(`- New contacts in this run: ${m.contacts_new}`);
    L.push(`- Newly orphaned (no source contains them any more): ${m.contacts_orphaned}`);
    L.push(`- Cross-source duplicates (addresses in 2+ sources): ${m.cross_source_dups}`);
    const d = m.same_address_rows;
    L.push(`- Same address on several rows of one source (D36, latest row wins, others stacked in raw_fields._merged_rows): ${d.groups} (stacked ${d.stacked}, capped at 20: ${d.capped}, largest group ${d.max_rows} rows)`);
    if (d.by_source.length > 0) pushAll(L, ['', ...table(['source', 'addresses with several rows', 'stacked'], d.by_source.map((b) => [b.source, b.groups, b.stacked]))]);
  } else {
    L.push(`- Unique addresses over the staged sources: ${r.staged_totals.unique_emails}`);
    L.push(`- Cross-source duplicates over the staged sources: ${r.staged_totals.cross_source_dups}`);
  }
  L.push('');

  // Overlap matrix: diagonal = addresses staged for that source, off-diagonal from the database.
  const names = r.priority_order.length > 0 ? r.priority_order : r.stage.map((s) => s.source);
  if (r.merge && names.length > 0) {
    const pair = new Map<string, number>();
    for (const o of r.merge.overlap) {
      pair.set(`${o.a}|${o.b}`, o.contacts);
      pair.set(`${o.b}|${o.a}`, o.contacts);
    }
    const own = new Map(r.stage.map((s) => [s.source, s.unique_emails]));
    L.push('## Source overlap', '', 'Contacts shared by each pair of sources (diagonal: addresses staged for the source in this run).', '');
    pushAll(L, table(['', ...names], names.map((a) => [a, ...names.map((b) => (a === b ? (own.get(a) ?? '—') : (pair.get(`${a}|${b}`) ?? 0)))])), '');
  }

  L.push('## Priority order used', '');
  pushAll(L, names.length > 0 ? names.map((n, i) => `${i + 1}. ${n}`) : ['—'], '');

  if (r.merge) {
    const o = r.merge.overrides_applied;
    L.push('## Overrides applied', '');
    L.push(`- Typo decisions in effect: ${o.typo}`);
    L.push(`- Excluded rows (exclude.yaml): ${o.exclude}`);
    L.push(`- Suppressions (suppressions.yaml): ${o.suppressions}`);
    L.push(`- Consent overrides (consents.yaml): ${o.consents}`, '');
  }

  L.push('## Warnings', '');
  pushAll(L, r.warnings.length > 0 ? r.warnings.map((w) => `- ${cell(w)}`) : ['None.'], '');

  L.push(`## Samples (masked, at most ${SAMPLE_LIMIT} each)`, '');
  L.push('### Rejected rows', '');
  if (r.samples.invalid.length > 0) pushAll(L, table(['source', 'file', 'row', 'value', 'reason'], r.samples.invalid.map((s) => [s.source, s.file, s.row_number, s.masked, s.reason])));
  else L.push('None.');
  L.push('', '### Typo suspects', '');
  if (r.samples.typo.length > 0) pushAll(L, table(['address', 'suggestion', 'sources'], r.samples.typo.map((t) => [t.masked, t.masked_suggestion, t.sources.join(', ')])));
  else L.push('None.');
  L.push('', `### Column mappings below ${REVIEW_THRESHOLD}`, '');
  if (r.samples.low_confidence_mappings.length > 0) {
    pushAll(L, table(['source', 'file', 'field', 'column', 'how', 'confidence'], r.samples.low_confidence_mappings.map((x) => [x.source, x.file, x.mapping.field, x.mapping.column, x.mapping.how, x.mapping.confidence])));
  } else L.push('None.');
  L.push('', '### Encodings detected automatically (`encoding: auto`)', '');
  if (r.samples.auto_encodings.length > 0) {
    pushAll(L, table(['source', 'file', 'encoding', 'candidates'], r.samples.auto_encodings.map((x) => [x.source, x.file, x.encoding ?? 'n/a', x.candidates.join(', ')])));
  } else L.push('None.');
  L.push('', 'Next: run `review-report` to list the decisions to make.', '');
  return sanitizeText(L.join('\n'));
}

/**
 * Write `<run_id>.json` and `<run_id>.md`, plus `latest.json` / `latest.md` with the same content, each
 * through writeFileInWorkspace (D32: temp file + rename, a symlink at the target is replaced). Pass
 * `workspace` to refuse a reports directory that resolves outside it; without it the directory itself
 * is the boundary.
 */
export function writeReport(report: FullRunReport, reportsDir: string, workspace?: string): { json: string; md: string } {
  if (workspace === undefined) fs.mkdirSync(reportsDir, { recursive: true });
  const write = (name: string, text: string) => writeFileInWorkspace(reportsDir, name, text, { workspace: workspace ?? reportsDir });
  const safe = sanitizeDeep(report);
  const jsonText = `${JSON.stringify(safe, null, 2)}\n`;
  const mdText = renderMarkdown(safe);
  const json = write(`${safe.run_id}.json`, jsonText);
  const md = write(`${safe.run_id}.md`, mdText);
  write('latest.json', jsonText);
  write('latest.md', mdText);
  return { json, md };
}
