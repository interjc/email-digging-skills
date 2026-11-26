// add-source <name> [--workspace <path>] [--json]
// Probe the files of a new source and draft its meta.md (or meta.draft.md when meta.md exists).
// stdout is masked: sample values go through maskValue, full addresses never appear.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ColumnMapping, FileProbe, MetaFile, SourceMeta, StandardField } from './lib/types.ts';
import { EXIT } from './lib/types.ts';
import { PreconditionError } from './lib/errors.ts';
import { parseCliArgs, printWarnings, runCli } from './lib/cli.ts';
import { assertPathSafe, requireWorkspace, workspaceLayout } from './lib/paths.ts';
import { loadMeta, listSourceDir, renderMetaDraft, SOURCE_NAME_RE } from './lib/meta.ts';
import type { DraftFile } from './lib/meta.ts';
import { probeFile, readRows } from './lib/read/index.ts';
import { findDuplicates } from './lib/read/duplicates.ts';
import { REVIEW_THRESHOLD } from './lib/read/synonyms.ts';
import { maskValue } from './lib/mask.ts';
import { sanitizeError, sanitizeText } from './lib/sanitize.ts';
import { writeFileInWorkspace } from './lib/fsafe.ts';
import { headerHasAddress, printableHeaders } from './lib/read/headers.ts';
import { withWorkspaceLock } from './lib/lock.ts';
import { makeConsentMatcher } from './lib/read/consent.ts';
import type { ConsentMatcher } from './lib/read/consent.ts';
import { parseDate } from './lib/read/dates.ts';

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

/** `YYYY-MM-DD` in a file name; null when there is none or it is not a real date (never throws). */
export function guessExportDate(fileName: string): string | null {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(fileName);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
  return m[0];
}

const LOCALE_SHAPE = /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/;

/**
 * One sample value as it may be printed (D28): masked by field, shape-limited for fields that should
 * hold dates, locales or consent words (an address in the wrong column never shows), then sanitized.
 */
function displaySample(field: StandardField, value: string, consent: ConsentMatcher): string {
  let shown: string;
  switch (field) {
    case 'email':
    case 'name':
      shown = maskValue(field, value);
      break;
    case 'created_at':
    case 'last_seen_at':
      shown = parseDate(value) !== null ? value : '(unparsed)';
      break;
    case 'locale':
      shown = LOCALE_SHAPE.test(value.trim()) ? value.trim() : '(other)';
      break;
    default:
      shown = consent(value) !== 'unknown' ? value.trim() : '(other)';
  }
  return sanitizeText(shown);
}

async function maskedSamples(file: string, meta: MetaFile, probe: FileProbe, consent: ConsentMatcher, decodedDir: string): Promise<Record<string, string[]>> {
  const mapped = probe.mappings.filter((m): m is ColumnMapping & { column: string } => m.column !== null);
  const out: Record<string, string[]> = Object.fromEntries(mapped.map((m) => [m.field, []]));
  if (mapped.length === 0) return out;
  for await (const { cells } of readRows(file, meta, probe, { decodedDir })) {
    for (const m of mapped) {
      const bucket = out[m.field] as string[];
      const v = cells[m.column];
      if (bucket.length < 3 && v !== null && v !== undefined && v.trim() !== '') bucket.push(displaySample(m.field, v, consent));
    }
    if (mapped.every((m) => (out[m.field] as string[]).length >= 3)) break;
  }
  return out;
}

/** Copy of a probe that is safe to print: headers and mapped column names sanitized (or `<col N>`, see printableHeaders). */
function printableProbe(p: FileProbe): FileProbe {
  const headers = printableHeaders(p.headers);
  return {
    ...p,
    file: sanitizeText(p.file), // R4-5: the file name can hold an address too
    headers,
    mappings: p.mappings.map((m) => ({ ...m, column: m.column === null ? null : (headers[p.headers.indexOf(m.column)] ?? '<col ?>') })),
  };
}

export async function addSource(name: string, opts: { workspace?: string | null } = {}): Promise<{ report: AddSourceReport; workspaceWarnings: string[] }> {
  if (!SOURCE_NAME_RE.test(name)) {
    throw new Error(`invalid source name "${sanitizeText(name)}": use lowercase letters, digits and single hyphens (e.g. product-a, event-2023-tokyo)`);
  }
  const info = requireWorkspace({ workspace: opts.workspace });
  const layout = workspaceLayout(info.workspace);
  // D26: one mutating command at a time per workspace.
  const report = await withWorkspaceLock(info.workspace, 'add-source', () => addSourceLocked(name, layout));
  return { report, workspaceWarnings: info.warnings };
}

async function addSourceLocked(name: string, layout: ReturnType<typeof workspaceLayout>): Promise<AddSourceReport> {
  const dir = path.join(layout.resources, name);
  const report: AddSourceReport = {
    source: name, dir, created_dir: false, meta_file: null, meta_is_draft: false,
    files: [], subdirs_ignored: [], confirm: [], warnings: [],
  };

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    report.created_dir = true;
    return report;
  }

  // R2-2: a source directory that is really a symlink into the checkout would get meta.md written
  // inside the repository. assertPathSafe resolves the real path and refuses anything git could commit.
  assertPathSafe(dir, { what: 'The source directory' });
  const listing = listSourceDir(dir);
  report.subdirs_ignored = listing.subdirs.map(sanitizeText);
  for (const d of listing.subdirs) report.warnings.push(sanitizeText(`subdirectory ignored: ${d}/`));

  // Existing meta.md (if valid) supplies per-file settings and column names for the probe and the draft.
  const metaPath = path.join(dir, 'meta.md');
  let existing: SourceMeta | null = null;
  if (fs.existsSync(metaPath)) {
    try {
      existing = loadMeta(dir);
    } catch (err) {
      report.warnings.push(`existing meta.md is not usable, probing with defaults: ${sanitizeText((err as Error).message.split('\n').slice(0, 3).join(' '))}`);
    }
  }

  // R2-5: files of an existing meta.md keep their order (and stay, even as accepted in-directory
  // symlinks); files that are new follow, in name order.
  const existingNames = existing ? existing.files.map((f) => f.name) : [];
  const existingSet = new Set(existingNames);
  const candidates = [...existingNames, ...listing.files.filter((n) => !existingSet.has(n))];

  // R1-7: decode into the workspace, never the OS temp dir; removed afterwards.
  const decodedDir = path.join(layout.staging, `_probe-${process.pid}`);
  fs.mkdirSync(decodedDir, { recursive: true });
  try {
    const consent = makeConsentMatcher(existing?.consent_values);
    const probed: Array<{ name: string; path: string; meta: MetaFile; probe: FileProbe }> = [];
    const entries: AddSourceFileReport[] = []; // printable
    for (const fileName of candidates) {
      const filePath = path.join(dir, fileName);
      const mf: MetaFile = existing?.files.find((f) => f.name === fileName) ?? { name: fileName, encoding: 'auto' };
      const entry: AddSourceFileReport = { file: sanitizeText(fileName), probe: null, error: null, duplicate_of: null, samples: {} };
      try {
        const probe = await probeFile(filePath, mf, { columns: existing?.columns, decodedDir, onWarning: (m) => report.warnings.push(m) });
        probed.push({ name: fileName, path: filePath, meta: mf, probe });
        entry.probe = printableProbe(probe);
        if (headerHasAddress(probe.headers)) {
          report.confirm.push(sanitizeText(`${fileName}: a header cell contains an address; the header row may be wrong (check header_row)`));
        }
      } catch (err) {
        entry.error = sanitizeText((err as Error).message);
      }
      entries.push(entry);
    }
    report.files = entries;
    const rawByName = new Map(probed.map((p) => [p.name, p]));
    const nameOf = (i: number) => candidates[i] as string;

    // R9: suspected duplicates.
    let duplicates = new Map<string, string>();
    try {
      duplicates = await findDuplicates(probed, decodedDir);
    } catch (err) {
      report.warnings.push(`duplicate check failed: ${sanitizeText((err as Error).message)}`);
    }
    // A file listed in an existing meta.md is never a duplicate; a new copy of it is.
    const groups = new Map<string, string[]>();
    for (const n of candidates) {
      const canon = duplicates.get(n) ?? (candidates.some((m) => duplicates.get(m) === n) ? n : null);
      if (canon !== null) groups.set(canon, [...(groups.get(canon) ?? []), n]);
    }
    duplicates = new Map();
    for (const members of groups.values()) {
      const canonical = members.find((n) => existingSet.has(n)) ?? members[0] as string;
      for (const n of members) if (n !== canonical && !existingSet.has(n)) duplicates.set(n, canonical);
    }
    entries.forEach((e, i) => { e.duplicate_of = duplicates.has(nameOf(i)) ? sanitizeText(duplicates.get(nameOf(i)) as string) : null; });

    // Masked samples for the files that stay listed.
    for (const [i, e] of entries.entries()) {
      const p = rawByName.get(nameOf(i));
      if (p && e.duplicate_of === null) {
        try {
          e.samples = await maskedSamples(p.path, p.meta, p.probe, consent, decodedDir);
        } catch (err) {
          report.warnings.push(sanitizeText(`${nameOf(i)}: could not read samples: ${(err as Error).message}`));
        }
      }
    }

    // Draft (raw column names: it is a file inside the workspace; only printed text is sanitized).
    const listedNames = candidates.filter((n) => !duplicates.has(n));
    const first = listedNames.map((n) => rawByName.get(n)).find((x) => x !== undefined);
    const dates = listedNames.map(guessExportDate).filter((d): d is string => d !== null).sort();
    const exportedAt = dates.length > 0 ? (dates[dates.length - 1] as string) : null;
    const render = (ex: SourceMeta | null): string => renderMetaDraft({
      source: name, kind: ex?.kind, existing: ex, exportedAt,
      mappings: first?.probe.mappings ?? [],
      files: candidates.map((n, i) => ({
        name: n, probe: rawByName.get(n)?.probe ?? null, error: entries[i]?.error ?? undefined,
        duplicateOf: duplicates.get(n), settings: ex?.files.find((f) => f.name === n),
      })),
    });
    if (candidates.length > 0) {
      // R1-4: create meta.md exclusively; if it appeared meanwhile (or existed), the draft goes elsewhere.
      let wroteMeta = false;
      if (existing === null && !fs.existsSync(metaPath)) {
        try {
          fs.writeFileSync(metaPath, render(null), { flag: 'wx' });
          wroteMeta = true;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }
      }
      if (wroteMeta) {
        report.meta_file = metaPath;
      } else {
        if (existing === null && fs.existsSync(metaPath)) {
          try { existing = loadMeta(dir); } catch { /* keep defaults */ }
        }
        const draftPath = path.join(dir, 'meta.draft.md');
        // R4-4: meta.draft.md may exist (even as a symlink): replace it through a temp file, never follow it.
        writeFileInWorkspace(dir, 'meta.draft.md', render(existing), { workspace: layout.workspace });
        report.meta_file = draftPath;
        report.meta_is_draft = true;
      }
    }

    // What the human must confirm (D25).
    entries.forEach((e) => {
      const p = e.probe;
      if (e.error) report.confirm.push(`${e.file}: could not be read (${e.error.split('\n')[0]}); fix it or leave it out`);
      if (!p) return;
      if (e.duplicate_of !== null) {
        report.confirm.push(`${e.file}: suspected duplicate of ${e.duplicate_of} (same headers and rows); commented out in the draft, confirm`);
        return;
      }
      if (p.encodingHow === 'detected' && (p.encoding !== 'utf-8' || p.encodingCandidates.length > 1)) {
        report.confirm.push(`${e.file}: encoding detected as ${p.encoding} (candidates: ${p.encodingCandidates.join(', ')}); confirm and set it in meta.md`);
      }
      for (const m of p.mappings) {
        if (m.column === null && m.field === 'email') report.confirm.push(`${e.file}: no email column found; set \`columns.email\` in meta.md`);
        else if (m.column !== null && m.confidence < REVIEW_THRESHOLD) {
          report.confirm.push(`${e.file}: ${m.field} → "${m.column}" is a guess (${m.how}, ${m.confidence}); confirm`);
        }
      }
    });
    if (candidates.length === 0) report.warnings.push('no data files found in the directory');
    else {
      if (!existing) report.confirm.push('consent_basis (opt_in / transactional / unknown): written as unknown; set it from how the data was collected');
      if (exportedAt && !existing?.exported_at) report.confirm.push(`exported_at: guessed ${exportedAt} from a file name; confirm`);
    }
    return report;
  } finally {
    fs.rmSync(decodedDir, { recursive: true, force: true });
  }
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
  let result: Awaited<ReturnType<typeof addSource>>;
  try {
    result = await addSource(name, { workspace: values.workspace as string | undefined });
  } catch (err) {
    if (err instanceof PreconditionError) throw err;
    throw new Error(sanitizeError(err)); // D28: nothing thrown may carry an address
  }
  const { report, workspaceWarnings } = result;
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
