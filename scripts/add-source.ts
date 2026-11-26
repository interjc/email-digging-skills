// add-source <name> [--workspace <path>] [--json]
// Probe the files of a new source and draft its meta.md (or meta.draft.md when meta.md exists).
// stdout is masked: sample values go through maskValue, full addresses never appear.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ColumnMapping, FileProbe, MetaFile, SourceMeta } from './lib/types.ts';
import { EXIT } from './lib/types.ts';
import { parseCliArgs, printWarnings, runCli } from './lib/cli.ts';
import { requireWorkspace, workspaceLayout } from './lib/paths.ts';
import { loadMeta, listSourceDir, renderMetaDraft, SOURCE_NAME_RE } from './lib/meta.ts';
import type { DraftFile } from './lib/meta.ts';
import { probeFile, readRows } from './lib/read/index.ts';
import { findDuplicates } from './lib/read/duplicates.ts';
import { REVIEW_THRESHOLD } from './lib/read/synonyms.ts';
import { maskValue } from './lib/mask.ts';

export interface AddSourceFileReport {
  file: string;
  probe: FileProbe | null;
  error: string | null;
  duplicate_of: string | null;
  /** Up to 3 masked sample values per mapped standard field. */
  samples: Record<string, string[]>;
}

export interface AddSourceReport {
  source: string;
  dir: string;
  /** True when the directory was just created and holds no files yet. */
  created_dir: boolean;
  meta_file: string | null;
  meta_is_draft: boolean;
  files: AddSourceFileReport[];
  subdirs_ignored: string[];
  confirm: string[];
  warnings: string[];
}

/** `YYYY-MM-DD` in a file name, if it is a real date. */
export function guessExportDate(fileName: string): string | null {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(fileName);
  if (!m) return null;
  const s = m[0];
  return new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s ? s : null;
}

async function maskedSamples(file: string, meta: MetaFile, probe: FileProbe): Promise<Record<string, string[]>> {
  const mapped = probe.mappings.filter((m): m is ColumnMapping & { column: string } => m.column !== null);
  const out: Record<string, string[]> = Object.fromEntries(mapped.map((m) => [m.field, []]));
  if (mapped.length === 0) return out;
  for await (const { cells } of readRows(file, meta, probe)) {
    for (const m of mapped) {
      const bucket = out[m.field] as string[];
      const v = cells[m.column];
      if (bucket.length < 3 && v !== null && v !== undefined && v.trim() !== '') bucket.push(maskValue(m.field, v));
    }
    if (mapped.every((m) => (out[m.field] as string[]).length >= 3)) break;
  }
  return out;
}

export async function addSource(name: string, opts: { workspace?: string | null } = {}): Promise<{ report: AddSourceReport; workspaceWarnings: string[] }> {
  if (!SOURCE_NAME_RE.test(name)) {
    throw new Error(`invalid source name "${name}": use lowercase letters, digits and single hyphens (e.g. product-a, event-2023-tokyo)`);
  }
  const info = requireWorkspace({ workspace: opts.workspace });
  const layout = workspaceLayout(info.workspace);
  const dir = path.join(layout.resources, name);
  const report: AddSourceReport = {
    source: name, dir, created_dir: false, meta_file: null, meta_is_draft: false,
    files: [], subdirs_ignored: [], confirm: [], warnings: [],
  };

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    report.created_dir = true;
    return { report, workspaceWarnings: info.warnings };
  }

  const listing = listSourceDir(dir);
  report.subdirs_ignored = listing.subdirs;
  for (const d of listing.subdirs) report.warnings.push(`subdirectory ignored: ${d}/`);

  // Existing meta.md (if valid) supplies per-file settings and column names for the probe.
  const metaPath = path.join(dir, 'meta.md');
  const hasMeta = fs.existsSync(metaPath);
  let existing: SourceMeta | null = null;
  if (hasMeta) {
    try {
      existing = loadMeta(dir);
    } catch (err) {
      report.warnings.push(`existing meta.md is not usable, probing with defaults: ${(err as Error).message.split('\n').slice(0, 3).join(' ')}`);
    }
  }

  const probed: Array<{ name: string; path: string; meta: MetaFile; probe: FileProbe }> = [];
  for (const fileName of listing.files) {
    const filePath = path.join(dir, fileName);
    const mf: MetaFile = existing?.files.find((f) => f.name === fileName) ?? { name: fileName, encoding: 'auto' };
    const entry: AddSourceFileReport = { file: fileName, probe: null, error: null, duplicate_of: null, samples: {} };
    try {
      entry.probe = await probeFile(filePath, mf, { columns: existing?.columns });
      probed.push({ name: fileName, path: filePath, meta: mf, probe: entry.probe });
    } catch (err) {
      entry.error = (err as Error).message;
    }
    report.files.push(entry);
  }

  // R9: suspected duplicates.
  let duplicates = new Map<string, string>();
  try {
    duplicates = await findDuplicates(probed);
  } catch (err) {
    report.warnings.push(`duplicate check failed: ${(err as Error).message}`);
  }
  for (const f of report.files) f.duplicate_of = duplicates.get(f.file) ?? null;

  // Masked samples for the files that stay listed.
  for (const f of report.files) {
    if (f.probe && f.duplicate_of === null) {
      const p = probed.find((x) => x.name === f.file) as (typeof probed)[number];
      try {
        f.samples = await maskedSamples(p.path, p.meta, f.probe);
      } catch (err) {
        report.warnings.push(`${f.file}: could not read samples: ${(err as Error).message}`);
      }
    }
  }

  // Draft.
  const listed = report.files.filter((f) => f.duplicate_of === null);
  const firstProbed = listed.find((f) => f.probe !== null);
  const dates = listed.map((f) => guessExportDate(f.file)).filter((d): d is string => d !== null).sort();
  const exportedAt = dates.length > 0 ? (dates[dates.length - 1] as string) : null;
  const draftFiles: DraftFile[] = report.files.map((f) => ({
    name: f.file, probe: f.probe, error: f.error ?? undefined, duplicateOf: f.duplicate_of ?? undefined,
  }));
  const text = renderMetaDraft({
    source: name, kind: existing?.kind, files: draftFiles, exportedAt,
    mappings: firstProbed?.probe?.mappings ?? [],
  });
  const out = hasMeta ? path.join(dir, 'meta.draft.md') : metaPath;
  if (listing.files.length > 0) {
    fs.writeFileSync(out, text);
    report.meta_file = out;
    report.meta_is_draft = hasMeta;
  }

  // What the human must confirm.
  for (const f of report.files) {
    const p = f.probe;
    if (f.error) report.confirm.push(`${f.file}: could not be read (${f.error.split('\n')[0]}); fix it or leave it out`);
    if (!p) continue;
    if (f.duplicate_of !== null) {
      report.confirm.push(`${f.file}: suspected duplicate of ${f.duplicate_of} (same headers and rows); commented out in the draft, confirm`);
      continue;
    }
    if (p.encodingHow === 'detected' && (p.encoding !== 'utf-8' || p.encodingCandidates.length > 1)) {
      report.confirm.push(`${f.file}: encoding detected as ${p.encoding} (candidates: ${p.encodingCandidates.join(', ')}); confirm and set it in meta.md`);
    }
    for (const m of p.mappings) {
      if (m.column === null && m.field === 'email') report.confirm.push(`${f.file}: no email column found; set \`columns.email\` in meta.md`);
      else if (m.column !== null && m.confidence < REVIEW_THRESHOLD) {
        report.confirm.push(`${f.file}: ${m.field} → "${m.column}" is a guess (${m.how}, ${m.confidence}); confirm`);
      }
    }
  }
  if (listing.files.length === 0) report.warnings.push('no data files found in the directory');
  else {
    report.confirm.push('consent_basis (opt_in / transactional / unknown): written as unknown; set it from how the data was collected');
    if (exportedAt) report.confirm.push(`exported_at: guessed ${exportedAt} from a file name; confirm`);
  }
  return { report, workspaceWarnings: info.warnings };
}

function render(r: AddSourceReport): string {
  const L: string[] = [];
  if (r.created_dir) {
    L.push(`Created ${r.dir}`, 'Put the export files here (originals, unmodified), then run add-source again.');
    return L.join('\n');
  }
  L.push(`Source: ${r.source}  (${r.dir})`);
  for (const f of r.files) {
    L.push('', `File: ${f.file}`);
    if (f.error) { L.push(`  error: ${f.error}`); continue; }
    const p = f.probe as FileProbe;
    const enc = p.encoding === null ? 'n/a' : `${p.encoding} (${p.encodingHow}${p.encodingCandidates.length > 1 ? `; candidates: ${p.encodingCandidates.join(', ')}` : ''})`;
    L.push(`  format: ${p.format}   encoding: ${enc}   rows: ${p.rowCount}`);
    if (f.duplicate_of) L.push(`  suspected duplicate of ${f.duplicate_of}`);
    L.push(`  headers: ${p.headers.join(' | ')}`);
    for (const m of p.mappings) {
      if (m.column === null) { L.push(`  ${m.field.padEnd(13)} (not found)`); continue; }
      const s = f.samples[m.field] ?? [];
      L.push(`  ${m.field.padEnd(13)} ← ${m.column}  [${m.how}, ${m.confidence}]${s.length > 0 ? `  e.g. ${s.join('  ')}` : ''}`);
    }
  }
  if (r.meta_file) L.push('', `${r.meta_is_draft ? 'Wrote draft (meta.md left untouched)' : 'Wrote'}: ${r.meta_file}`);
  if (r.warnings.length > 0) L.push('', 'Warnings:', ...r.warnings.map((w) => `  - ${w}`));
  if (r.confirm.length > 0) L.push('', 'Please confirm:', ...r.confirm.map((c) => `  - ${c}`));
  return L.join('\n');
}

async function main(): Promise<number> {
  const { values, positionals } = parseCliArgs(process.argv.slice(2));
  const name = positionals[0];
  if (!name || positionals.length > 1) {
    process.stderr.write('Usage: node scripts/add-source.ts <name> [--workspace <path>] [--json]\n');
    return EXIT.ERROR;
  }
  const { report, workspaceWarnings } = await addSource(name, { workspace: values.workspace as string | undefined });
  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printWarnings(workspaceWarnings);
    process.stdout.write(`${render(report)}\n`);
  }
  return EXIT.OK;
}

/** True when this file is the entry point (argv[1] may be a test glob when tests import this module). */
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
