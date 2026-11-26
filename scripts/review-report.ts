// review-report [--workspace <p>] [--json]
// List the decisions a human must make after clean-and-merge: typo suspects without a decision,
// detected encodings to confirm (D25), column mappings below 0.8, sources without meta.md, sources
// whose consent_basis is unknown, contacts orphaned by the latest run, and override warnings.
// Writes output/reports/pending-decisions.yaml with the FULL values and ready-to-edit entries; the
// human reviews them and moves them to workspace/overrides/. stdout is masked (D28).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';
import type { ResolvedEncoding } from './lib/types.ts';
import { EXIT } from './lib/types.ts';
import { parseCliArgs, printWarnings, runCli } from './lib/cli.ts';
import { PreconditionError } from './lib/errors.ts';
import { repoRoot, requireWorkspace } from './lib/paths.ts';
import { openDb } from './lib/db.ts';
import { loadOverrides } from './lib/overrides.ts';
import { normalizeOverrideEmail } from './lib/merge.ts';
import { lowConfidenceMappings } from './lib/report.ts';
import type { FullRunReport } from './lib/report.ts';
import { maskEmail } from './lib/mask.ts';
import { sanitizeText } from './lib/sanitize.ts';

export const PENDING_FILE = 'pending-decisions.yaml';
const SHOW = 20;
const OVERRIDE_FILE = /\b(typo-decisions|suppressions|consents|exclude)\.yaml\b/;

export interface PendingDecisions {
  run_id: string;
  generated_at: string;
  /** Paste into overrides/typo-decisions.yaml after filling `action` (accept | reject). */
  typo_decisions: Array<{ email: string; suggested: string | null; action: null; note: null; sources: string[] }>;
  /** Confirm and write `encoding:` for the file in resources/<source>/meta.md. */
  encodings: Array<{ source: string; file: string; detected: ResolvedEncoding | null; candidates: ResolvedEncoding[] }>;
  /** Confirm the column (or set `columns.<field>` in meta.md). */
  low_confidence_mappings: Array<{ source: string; file: string; field: string; column: string | null; how: string; confidence: number }>;
  /** Run add-source <name>. */
  sources_without_meta: string[];
  /** Set consent_basis in meta.md (opt_in / transactional) when it is known. */
  unknown_consent_basis: string[];
  /** Contacts the latest run marked orphaned (no source holds them any more). Information only. */
  orphaned: Array<{ email: string; orphaned_at: string }>;
  override_warnings: string[];
  other_warnings: string[];
}

export interface ReviewResult {
  pending: PendingDecisions;
  pending_path: string;
  report_status: string;
  workspace_warnings: string[];
}

export function reviewReport(opts: { workspace?: string | null; repoRoot?: string } = {}): ReviewResult {
  const root = opts.repoRoot ?? repoRoot();
  const info = requireWorkspace({ workspace: opts.workspace, repoRoot: root });
  const { layout } = info;
  const latest = path.join(layout.reports, 'latest.json');
  if (!fs.existsSync(latest)) {
    throw new PreconditionError(`No report yet (${latest} is missing).`, 'run clean-and-merge first.');
  }
  const report = JSON.parse(fs.readFileSync(latest, 'utf8')) as FullRunReport;
  const overrides = loadOverrides(layout.overrides);
  const decided = new Set(overrides.typo.map((t) => normalizeOverrideEmail(t.email)));

  const db = openDb(layout.dbPath, { readonly: true });
  let typo: PendingDecisions['typo_decisions'];
  let unknownBasis: string[];
  let orphaned: PendingDecisions['orphaned'];
  try {
    const sourcesOf = db.prepare('SELECT source FROM contact_sources WHERE contact_id = ? ORDER BY source');
    typo = (db.prepare("SELECT id, email, suggested_email FROM contacts WHERE email_status = 'typo_suspect' AND orphaned_at IS NULL ORDER BY email").all() as Array<{ id: number; email: string; suggested_email: string | null }>)
      .filter((c) => !decided.has(c.email))
      .map((c) => ({
        email: c.email, suggested: c.suggested_email, action: null, note: null,
        sources: (sourcesOf.all(c.id) as Array<{ source: string }>).map((r) => r.source),
      }));
    unknownBasis = (db.prepare("SELECT name FROM sources WHERE consent_basis = 'unknown' ORDER BY priority, name").all() as Array<{ name: string }>).map((r) => r.name);
    orphaned = report.merged_at === null || report.merged_at === undefined
      ? []
      : (db.prepare('SELECT email, orphaned_at FROM contacts WHERE orphaned_at = ? ORDER BY email').all(report.merged_at) as Array<{ email: string; orphaned_at: string }>)
        .map((r) => ({ email: r.email, orphaned_at: r.orphaned_at }));
  } finally {
    db.close();
  }

  // Sources without meta.md: what is in resources/ now (the report may be older).
  const withoutMeta = fs.readdirSync(layout.resources, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !fs.existsSync(path.join(layout.resources, e.name, 'meta.md')))
    .map((e) => e.name)
    .sort();

  const warnings = report.warnings ?? [];
  const pending: PendingDecisions = {
    run_id: report.run_id,
    generated_at: new Date().toISOString(),
    typo_decisions: typo,
    // D25: plain UTF-8 detected with a single candidate is reported but not asked about.
    encodings: (report.samples?.auto_encodings ?? [])
      .filter((e) => e.encoding !== 'utf-8' || e.candidates.length > 1)
      .map((e) => ({ source: e.source, file: e.file, detected: e.encoding, candidates: e.candidates })),
    low_confidence_mappings: lowConfidenceMappings(report.stage ?? []).map((x) => ({
      source: x.source, file: x.file, field: x.mapping.field, column: x.mapping.column, how: x.mapping.how, confidence: x.mapping.confidence,
    })),
    sources_without_meta: withoutMeta,
    unknown_consent_basis: unknownBasis,
    orphaned,
    override_warnings: warnings.filter((w) => OVERRIDE_FILE.test(w)),
    other_warnings: warnings.filter((w) => !OVERRIDE_FILE.test(w)),
  };

  const pendingPath = path.join(layout.reports, PENDING_FILE);
  fs.writeFileSync(pendingPath, renderPendingYaml(pending));
  return { pending, pending_path: pendingPath, report_status: report.status ?? 'unknown', workspace_warnings: info.warnings };
}

/** The pending file: full values (it stays in the workspace), with instructions as comments. */
export function renderPendingYaml(p: PendingDecisions): string {
  const head = [
    `# Decisions pending after run ${p.run_id} (generated ${p.generated_at}).`,
    '# This file holds FULL addresses: keep it in the workspace and do not paste it into a chat or issue.',
    '# It is regenerated by every review-report run. Move the entries you decide to workspace/overrides/:',
    '#   typo_decisions  → overrides/typo-decisions.yaml (fill `action: accept` or `action: reject`; `sources` is informational)',
    '#   encodings / low_confidence_mappings → confirm and write them in resources/<source>/meta.md',
    '#   sources_without_meta → run add-source <name>',
    '#   unknown_consent_basis → set consent_basis in meta.md when you know how the addresses were collected',
    '#   orphaned → information only: these addresses are in no source any more (never deleted automatically)',
    '',
  ];
  return head.join('\n') + stringifyYaml(p, { nullStr: '' });
}

export function renderReviewSummary(r: ReviewResult): string {
  const p = r.pending;
  const L: string[] = [`review-report for run ${p.run_id} (report status: ${r.report_status})`];
  const section = (title: string, items: string[], hint: string) => {
    L.push('', `${title}: ${items.length}${items.length > 0 ? `  → ${hint}` : ''}`);
    for (const i of items.slice(0, SHOW)) L.push(`  - ${i}`);
    if (items.length > SHOW) L.push(`  ... and ${items.length - SHOW} more (see the pending file)`);
  };
  section('Typo suspects without a decision', p.typo_decisions.map((t) => `${maskEmail(t.email)} → ${t.suggested ? maskEmail(t.suggested) : '?'} (${t.sources.join(', ')})`), 'accept or reject in overrides/typo-decisions.yaml');
  section('Encodings to confirm', p.encodings.map((e) => `${e.source}/${e.file}: ${e.detected ?? 'n/a'} (candidates: ${e.candidates.join(', ')})`), 'write `encoding:` in meta.md');
  section('Column mappings below 0.8', p.low_confidence_mappings.map((m) => `${m.source}/${m.file}: ${m.field} ← "${m.column}" (${m.how}, ${m.confidence})`), 'confirm or set `columns.<field>` in meta.md');
  section('Sources without meta.md', p.sources_without_meta, 'run add-source <name>');
  section('Sources with consent_basis unknown', p.unknown_consent_basis, 'set consent_basis in meta.md if known');
  section('Contacts orphaned by this run', p.orphaned.map((o) => maskEmail(o.email)), 'information only, nothing is deleted');
  section('Override warnings', p.override_warnings, 'fix the files in overrides/');
  if (p.other_warnings.length > 0) section('Other warnings', p.other_warnings, 'see the report');
  L.push('', `Full values and ready-to-edit entries: ${r.pending_path}`);
  return sanitizeText(L.join('\n'));
}

/** Masked copy of the pending decisions for --json. */
function maskedPending(p: PendingDecisions): PendingDecisions {
  return {
    ...p,
    typo_decisions: p.typo_decisions.map((t) => ({ ...t, email: maskEmail(t.email), suggested: t.suggested ? maskEmail(t.suggested) : null })),
    orphaned: p.orphaned.map((o) => ({ ...o, email: maskEmail(o.email) })),
  };
}

async function main(): Promise<number> {
  const { values } = parseCliArgs(process.argv.slice(2));
  let result: ReviewResult;
  try {
    result = reviewReport({ workspace: values.workspace as string | undefined });
  } catch (err) {
    if (err instanceof PreconditionError) throw new PreconditionError(sanitizeText(err.message), err.fix === null ? null : sanitizeText(err.fix));
    throw new Error(sanitizeText(err instanceof Error ? err.message : String(err)));
  }
  if (values.json === true) {
    process.stdout.write(`${sanitizeText(JSON.stringify({ pending_path: result.pending_path, ...maskedPending(result.pending) }, null, 2))}\n`);
  } else {
    printWarnings(result.workspace_warnings.map(sanitizeText));
    process.stdout.write(`${renderReviewSummary(result)}\n`);
  }
  return EXIT.OK;
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
