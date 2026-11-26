// meta.md: load and validate (loadMeta), list the files of a source directory (R9), render a draft.

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  ColumnMapping, ConsentBasis, DeclaredEncoding, FileProbe, MetaFile, SourceKind, SourceMeta, StandardField,
} from './types.ts';
import { STANDARD_FIELDS } from './types.ts';
import { byNameStem } from './read/order.ts';
import { normalizeConsentToken } from './read/consent.ts';
import { describeYamlError, sanitizeText } from './sanitize.ts';

export const SOURCE_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const KINDS: SourceKind[] = ['product', 'event', 'other'];
const BASES: ConsentBasis[] = ['opt_in', 'transactional', 'unknown'];
const ENCODINGS: DeclaredEncoding[] = ['auto', 'utf-8', 'utf-8-sig', 'cp932', 'gb18030', 'utf-16le', 'utf-16be'];
const TOP_KEYS = ['source', 'kind', 'label', 'files', 'columns', 'consent_values', 'consent_basis', 'exported_at'];
const FILE_KEYS = ['name', 'encoding', 'sheet', 'header_row', 'table', 'query', 'delimiter'];
const NON_DATA = new Set(['meta.md', 'meta.draft.md', 'notes.txt']);

export class MetaError extends Error {
  errors: string[];
  constructor(dir: string, errors: string[]) {
    // D28: error text can echo meta.md values; mask anything address-like.
    const clean = errors.map(sanitizeText);
    super(`invalid meta.md in ${dir}:\n  - ${clean.join('\n  - ')}`);
    this.name = 'MetaError';
    this.errors = clean;
  }
}

/** True for files that can hold data: not meta files, NOTES.txt, `.md` files or dotfiles. */
export function isDataFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return !(NON_DATA.has(lower) || lower.endsWith('.md') || name.startsWith('.'));
}

export interface SourceDirListing {
  /** Regular files directly in the directory that may hold data, sorted by name. */
  files: string[];
  /** Subdirectories (ignored, reported). */
  subdirs: string[];
}

/** R9: only regular files directly in the source directory are candidates. */
export function listSourceDir(dir: string): SourceDirListing {
  const files: string[] = [];
  const subdirs: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) subdirs.push(entry.name);
    else if (entry.isFile() && isDataFileName(entry.name)) files.push(entry.name);
  }
  return { files: files.sort(byNameStem), subdirs: subdirs.sort() };
}

function splitFrontmatter(text: string): string | null {
  const t = text.replace(/^﻿/, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(t);
  return m ? (m[1] as string) : null;
}

/**
 * R1-6: a listed file must be a regular file directly in the source directory (a symlink is allowed
 * only when its real path is inside it), and never a meta/notes/`.md` file. Returns the problem or null.
 */
function fileProblem(dir: string, name: string): string | null {
  if (!isDataFileName(name)) return `"${name}" is not a data file (meta files, NOTES.txt, .md files and dotfiles are never read)`;
  const p = path.join(dir, name);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return `file "${name}" does not exist in ${path.basename(dir)}/`;
  }
  if (st.isSymbolicLink()) {
    let real: string;
    try {
      real = fs.realpathSync(p);
    } catch {
      return `"${name}" is a broken symlink`;
    }
    const rel = path.relative(fs.realpathSync(dir), real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return `"${name}" is a symlink to a file outside the source directory`;
    if (!fs.statSync(real).isFile()) return `"${name}" is not a regular file`;
    return null;
  }
  return st.isFile() ? null : `"${name}" is not a regular file`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function optString(v: unknown, field: string, errors: string[]): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v.trim() === '' ? null : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  errors.push(`${field}: expected text, got ${Array.isArray(v) ? 'a list' : typeof v}`);
  return null;
}

function parseDelimiter(v: unknown, field: string, errors: string[]): string | null {
  const s = optString(v, field, errors);
  if (s === null) return null;
  const mapped = s === 'tab' || s === '\\t' ? '\t' : s;
  if (mapped.length !== 1) errors.push(`${field}: expected one character (or "tab"), got "${s}"`);
  return mapped;
}

function parseExportedAt(v: unknown, errors: string[]): string | null {
  if (v === undefined || v === null || v === '') return null;
  let s: string;
  if (v instanceof Date) s = v.toISOString().slice(0, 10);
  else if (typeof v === 'string') s = v.trim();
  else { errors.push('exported_at: expected YYYY-MM-DD'); return null; }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const ok = m !== null && new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)).toISOString().slice(0, 10) === s;
  if (!ok) { errors.push(`exported_at: "${s}" is not a valid YYYY-MM-DD date`); return null; }
  return s;
}

/**
 * Load and validate `<dir>/meta.md`. `source` must equal the directory name. Throws MetaError naming
 * every invalid field. Files present but not listed are passed to `onWarning`.
 */
export function loadMeta(dir: string, onWarning?: (message: string) => void): SourceMeta {
  const abs = path.resolve(dir);
  const metaPath = path.join(abs, 'meta.md');
  if (!fs.existsSync(metaPath)) throw new MetaError(abs, [`meta.md not found (run add-source to draft one)`]);
  const errors: string[] = [];
  const front = splitFrontmatter(fs.readFileSync(metaPath, 'utf8'));
  if (front === null) throw new MetaError(abs, ['meta.md must start with a YAML frontmatter block between two `---` lines']);
  let doc: unknown;
  try {
    doc = parseYaml(front);
  } catch (err) {
    throw new MetaError(abs, [`frontmatter is not valid YAML (${describeYamlError(err)})`]);
  }
  if (!isObj(doc)) throw new MetaError(abs, ['frontmatter must be a YAML mapping']);

  const warnings: string[] = [];
  for (const k of Object.keys(doc)) {
    if (!TOP_KEYS.includes(k)) warnings.push(`meta.md: unknown key "${k}" ignored`);
  }

  // source
  const dirName = path.basename(abs);
  let source = '';
  if (typeof doc.source !== 'string' || doc.source === '') errors.push('source: required');
  else {
    source = doc.source;
    if (!SOURCE_NAME_RE.test(source)) errors.push(`source: "${source}" must be lowercase letters, digits and single hyphens (e.g. product-a)`);
    if (source !== dirName) errors.push(`source: "${source}" must equal the directory name "${dirName}"`);
  }

  // kind, consent_basis, label
  let kind: SourceKind = 'other';
  if (doc.kind === undefined || doc.kind === null || doc.kind === '') {
    errors.push(`kind: required, one of ${KINDS.join(', ')}`);
  } else if (KINDS.includes(doc.kind as SourceKind)) kind = doc.kind as SourceKind;
  else errors.push(`kind: "${String(doc.kind)}" must be one of ${KINDS.join(', ')}`);
  let consent_basis: ConsentBasis = 'unknown';
  if (doc.consent_basis !== undefined && doc.consent_basis !== null) {
    if (BASES.includes(doc.consent_basis as ConsentBasis)) consent_basis = doc.consent_basis as ConsentBasis;
    else errors.push(`consent_basis: "${String(doc.consent_basis)}" must be one of ${BASES.join(', ')}`);
  }
  const label = optString(doc.label, 'label', errors);
  const exported_at = parseExportedAt(doc.exported_at, errors);

  // files
  const files: MetaFile[] = [];
  if (!Array.isArray(doc.files) || doc.files.length === 0) {
    errors.push('files: required, a non-empty list of { name, encoding, ... }');
  } else {
    const seen = new Set<string>();
    doc.files.forEach((raw: unknown, i: number) => {
      const f = `files[${i}]`;
      const entry: Record<string, unknown> | null = typeof raw === 'string' ? { name: raw } : isObj(raw) ? raw : null;
      if (entry === null) { errors.push(`${f}: expected a mapping with at least \`name\``); return; }
      for (const k of Object.keys(entry)) {
        if (!FILE_KEYS.includes(k)) warnings.push(`meta.md: unknown key "${f}.${k}" ignored`);
      }
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      if (name === '') { errors.push(`${f}.name: required`); return; }
      if (name !== path.basename(name) || name === '.' || name === '..') { errors.push(`${f}.name: must be a file name inside the source directory, got "${name}"`); return; }
      if (seen.has(name)) errors.push(`${f}.name: "${name}" is listed twice`);
      seen.add(name);
      const problem = fileProblem(abs, name);
      if (problem) errors.push(`${f}.name: ${problem}`);
      let encoding: DeclaredEncoding = 'auto';
      if (entry.encoding !== undefined && entry.encoding !== null && entry.encoding !== '') {
        if (ENCODINGS.includes(entry.encoding as DeclaredEncoding)) encoding = entry.encoding as DeclaredEncoding;
        else errors.push(`${f}.encoding: "${String(entry.encoding)}" must be one of ${ENCODINGS.join(', ')}`);
      }
      let header_row = 1;
      if (entry.header_row !== undefined && entry.header_row !== null && entry.header_row !== '') {
        if (typeof entry.header_row === 'number' && Number.isInteger(entry.header_row) && entry.header_row >= 1) header_row = entry.header_row;
        else errors.push(`${f}.header_row: must be a whole number >= 1, got "${String(entry.header_row)}"`);
      }
      const mf: MetaFile = { name, encoding, header_row };
      const sheet = optString(entry.sheet, `${f}.sheet`, errors);
      const table = optString(entry.table, `${f}.table`, errors);
      const query = optString(entry.query, `${f}.query`, errors);
      const delimiter = parseDelimiter(entry.delimiter, `${f}.delimiter`, errors);
      if (table !== null && query !== null) errors.push(`${f}: set either \`table\` or \`query\`, not both`);
      if (sheet !== null) mf.sheet = sheet;
      if (table !== null) mf.table = table;
      if (query !== null) mf.query = query;
      if (delimiter !== null) mf.delimiter = delimiter;
      files.push(mf);
    });
  }

  // columns
  const columns: SourceMeta['columns'] = {};
  if (doc.columns !== undefined && doc.columns !== null) {
    if (!isObj(doc.columns)) errors.push('columns: expected a mapping of standard field → original column name');
    else {
      for (const [k, v] of Object.entries(doc.columns)) {
        if (!(STANDARD_FIELDS as readonly string[]).includes(k)) warnings.push(`meta.md: unknown key "columns.${k}" ignored (standard fields: ${STANDARD_FIELDS.join(', ')})`);
        else {
          const s = optString(v, `columns.${k}`, errors);
          if (s !== null) columns[k as StandardField] = s;
        }
      }
    }
  }

  // consent_values
  let consent_values: SourceMeta['consent_values'];
  if (doc.consent_values !== undefined && doc.consent_values !== null) {
    if (!isObj(doc.consent_values)) errors.push('consent_values: expected { granted: [...], denied: [...] }');
    else {
      consent_values = {};
      for (const [k, v] of Object.entries(doc.consent_values)) {
        if (k !== 'granted' && k !== 'denied') { warnings.push(`meta.md: unknown key "consent_values.${k}" ignored`); continue; }
        if (v === null || v === undefined) continue;
        if (!Array.isArray(v) || v.some((x) => typeof x === 'object' && x !== null)) { errors.push(`consent_values.${k}: expected a list of values`); continue; }
        consent_values[k] = v.map((x) => String(x));
      }
    }
  }

  if (consent_values?.granted && consent_values.denied) {
    const granted = new Set(consent_values.granted.map(normalizeConsentToken));
    for (const v of consent_values.denied) {
      if (granted.has(normalizeConsentToken(v))) errors.push(`consent_values: "${v}" is listed under both granted and denied`);
    }
  }

  if (errors.length > 0) throw new MetaError(abs, errors);

  if (onWarning) {
    for (const w of warnings) onWarning(sanitizeText(w));
    const listed = new Set(files.map((f) => f.name));
    for (const name of listSourceDir(abs).files) {
      if (!listed.has(name)) onWarning(sanitizeText(`${dirName}/${name} is in the directory but not listed in meta.md; it will not be read`));
    }
  }

  const meta: SourceMeta = { source, kind, label, files, columns, consent_basis, exported_at, dir: abs };
  if (consent_values) meta.consent_values = consent_values;
  return meta;
}

// ---------------------------------------------------------------------------
// Draft rendering (add-source)
// ---------------------------------------------------------------------------

function y(v: string): string {
  // Quote only when YAML needs it.
  return /^[\p{L}\p{N}][\p{L}\p{N} ._/()\-+]*$/u.test(v) && !/^(true|false|null|yes|no|on|off|~|\d+(\.\d+)?)$/i.test(v) && !/ $/.test(v)
    ? v
    : JSON.stringify(v);
}

export interface DraftFile {
  name: string;
  probe: FileProbe | null;
  error?: string;
  /** Set for a suspected duplicate: the file it duplicates. The entry is written commented out. */
  duplicateOf?: string;
  /** Per-file settings of an existing meta.md; kept as they are (R1-5). */
  settings?: MetaFile;
}

export interface DraftInput {
  source: string;
  kind?: SourceKind;
  files: DraftFile[];
  /** `YYYY-MM-DD` guessed from a file name, or null. */
  exportedAt: string | null;
  /** Column mappings of the first listed file, written to `columns:` when confidence >= 0.8. */
  mappings: ColumnMapping[];
  /** An existing meta.md: its label, consent settings, exported_at and explicit columns are kept. */
  existing?: SourceMeta | null;
}

/** Draft meta.md text. Nothing detected is silently final: low-confidence mappings are comments. */
export function renderMetaDraft(input: DraftInput): string {
  const ex = input.existing ?? null;
  const out: string[] = ['---', `source: ${input.source}`, `kind: ${input.kind ?? ex?.kind ?? 'other'}            # product / event / other`, ex?.label ? `label: ${y(ex.label)}` : 'label:'];
  out.push('files:');
  for (const f of input.files) {
    const lines: string[] = [`- name: ${y(f.name)}`];
    const p = f.probe;
    const st = f.settings;
    if (st && st.encoding !== 'auto') {
      lines.push(`  encoding: ${st.encoding}`);
    } else {
      const detail = p && p.encodingHow === 'detected' && p.encoding !== null
        ? `  # detected ${p.encoding}${p.encodingCandidates.length > 1 ? ` (candidates: ${p.encodingCandidates.join(', ')})` : ''}; confirm, then write it here`
        : '';
      lines.push(`  encoding: auto${detail}`);
    }
    if (st?.sheet) lines.push(`  sheet: ${y(st.sheet)}`);
    else if (p?.format === 'xlsx') lines.push('  sheet:                # blank = first sheet');
    if (st?.table) lines.push(`  table: ${y(st.table)}`);
    else if (p?.format === 'sqlite' && !st?.query) lines.push('  table:                # required when the database has several tables');
    if (st?.query) lines.push(`  query: ${JSON.stringify(st.query)}`);
    if (st?.delimiter) lines.push(`  delimiter: ${JSON.stringify(st.delimiter)}`);
    lines.push(`  header_row: ${st?.header_row ?? 1}`);
    if (f.error) lines.push(`  # could not be probed: ${f.error.replace(/\s+/g, ' ')}`);
    if (f.duplicateOf !== undefined) {
      out.push(`# suspected duplicate of ${f.duplicateOf} (same headers and rows); uncomment to include`);
      for (const l of lines) out.push(`# ${l}`);
    } else {
      out.push(...lines);
    }
  }
  out.push('columns:                 # original column name for each standard field; blank = auto-detect');
  for (const m of input.mappings) {
    const fixed = ex?.columns[m.field];
    if (fixed) out.push(`  ${m.field}: ${y(fixed)}`);
    else if (m.column !== null && m.confidence >= 0.8) out.push(`  ${m.field}: ${y(m.column)}   # ${m.how}, ${m.confidence}`);
    else if (m.column !== null) out.push(`  ${m.field}:   # guess: ${y(m.column)} (${m.how}, ${m.confidence}); confirm`);
    else out.push(`  ${m.field}:`);
  }
  if (ex?.consent_values) {
    out.push('consent_values:');
    if (ex.consent_values.granted) out.push(`  granted: ${JSON.stringify(ex.consent_values.granted)}`);
    if (ex.consent_values.denied) out.push(`  denied: ${JSON.stringify(ex.consent_values.denied)}`);
  }
  out.push(ex
    ? `consent_basis: ${ex.consent_basis}   # kept from the existing meta.md`
    : 'consent_basis: unknown   # how consent was collected: opt_in / transactional / unknown; confirm');
  if (ex?.exported_at) out.push(`exported_at: ${ex.exported_at}   # kept from the existing meta.md`);
  else out.push(`exported_at: ${input.exportedAt ?? ''}${input.exportedAt ? '   # guessed from a file name; confirm' : ''}`.trimEnd());
  out.push('---', '', '## Notes', '- How the data was collected and which period it covers', '- Known problems (test accounts, unclear columns)', '');
  return out.join('\n');
}
