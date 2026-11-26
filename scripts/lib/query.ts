import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';
import { backupStamp } from './db.ts';
import { maskEmail, maskName, maskValue } from './mask.ts';
import { sanitizeText } from './sanitize.ts';
import type { ProviderList } from './types.ts';
import { MERGED_ROWS_KEY } from './types.ts';

// Use the views as the single source of truth for sendability.
export const LIST_VIEWS: Record<ProviderList, string> = {
  strict: 'v_sendable_strict',
  not_blocked: 'v_not_blocked',
};

export function parseList(value: unknown): ProviderList {
  if (value === undefined || value === 'strict') return 'strict';
  if (value === 'not_blocked') return 'not_blocked';
  throw new Error('--list must be strict or not_blocked');
}

interface Query {
  sql: string;
  args?: SQLInputValue[];
  countSql?: string;
  /** Output columns (by name) a preset declares non-personal although SQLite reports no origin (D33). */
  safe?: string[];
}

export function presetQuery(name: string, opts: { source?: string; notIn?: string; list: ProviderList }): Query {
  switch (name) {
    case 'sources':
      return { sql: `
        SELECT s.name AS source, count(cs.contact_id) AS contacts, coalesce(sum(cs.occurrences), 0) AS rows,
          count(*) FILTER (WHERE k.status = 'granted') AS granted,
          count(*) FILTER (WHERE k.status = 'denied') AS denied,
          count(cs.contact_id) FILTER (WHERE coalesce(k.status, 'unknown') = 'unknown') AS unknown
        FROM sources s LEFT JOIN contact_sources cs ON cs.source = s.name
        LEFT JOIN consents k USING (contact_id, source)
        GROUP BY s.name ORDER BY s.name` };
    case 'overlap':
      return { sql: `
        SELECT a.name AS source_a, b.name AS source_b, coalesce(o.contacts, 0) AS contacts
        FROM sources a JOIN sources b ON a.name < b.name
        LEFT JOIN v_source_overlap o ON o.source_a = a.name AND o.source_b = b.name
        ORDER BY a.name, b.name` };
    case 'only-in':
      if (!opts.source || !opts.notIn) throw new Error('only-in requires --source and --not-in');
      return { sql: `
        SELECT c.id, c.email, c.name
        FROM contacts c JOIN contact_sources a ON a.contact_id = c.id
        WHERE a.source = ? AND NOT EXISTS (
          SELECT 1 FROM contact_sources b WHERE b.contact_id = c.id AND b.source = ?
        ) ORDER BY c.id`, args: [opts.source, opts.notIn] };
    case 'sendable': {
      const view = LIST_VIEWS[opts.list];
      return {
        sql: `SELECT id, email, name, email_status, flags FROM ${view} ORDER BY id`,
        countSql: `SELECT count(*) AS count FROM ${view}`,
      };
    }
    case 'domains':
      return { sql: `
        SELECT email_domain AS domain, count(*) AS contacts FROM contacts
        GROUP BY email_domain ORDER BY contacts DESC, email_domain LIMIT 20`, safe: ['domain'] };
    case 'status':
      return { sql: `
        SELECT 'status' AS kind, CAST(email_status AS TEXT) AS value, count(*) AS contacts FROM contacts GROUP BY email_status
        UNION ALL
        SELECT 'flag', f.value, count(DISTINCT c.id) FROM contacts c, json_each(c.flags) f GROUP BY f.value
        ORDER BY kind DESC, value`, safe: ['kind', 'value'] };
    case 'consent':
      return { sql: `
        WITH statuses(status) AS (VALUES ('granted'), ('denied'), ('unknown'))
        SELECT s.name AS source, t.status, count(cs.contact_id) AS contacts
        FROM sources s CROSS JOIN statuses t
        LEFT JOIN (contact_sources cs LEFT JOIN consents k USING (contact_id, source))
          ON cs.source = s.name AND coalesce(k.status, 'unknown') = t.status
        GROUP BY s.name, t.status ORDER BY s.name, t.status`, safe: ['status'] };
    case 'orphaned':
      return { sql: `SELECT id, email, orphaned_at FROM contacts WHERE orphaned_at IS NOT NULL ORDER BY id` };
    default:
      throw new Error('Unknown preset. Choose sources, overlap, only-in, sendable, domains, status, consent, or orphaned.');
  }
}

const TRIVIA = /^(?:[\s\uFEFF]+|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))*/u;
const SQL_TOKEN = /^\s*(?:--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[a-z_][\w$]*|.)/isu;

/** Check the operation after the CTE list; SQLite also accepts WITH followed by a write. */
function startsWithSelect(sql: string): boolean {
  let rest = sql;
  function next(): string {
    rest = rest.slice(rest.match(TRIVIA)?.[0].length ?? 0);
    const token = rest.match(SQL_TOKEN)?.[0] ?? '';
    rest = rest.slice(token.length);
    return token.toUpperCase();
  }
  function skipGroup(): boolean {
    let depth = 1;
    while (depth > 0) {
      const token = next();
      if (token === '' || token === ';') return false;
      if (token === '(') depth++;
      if (token === ')') depth--;
    }
    return true;
  }
  const first = next();
  if (first === 'SELECT') return true;
  if (first !== 'WITH') return false;
  let name = next();
  if (name === 'RECURSIVE') name = next();
  while (name !== '' && name !== ';') {
    let token = next();
    if (token === '(') {
      if (!skipGroup()) return false;
      token = next();
    }
    if (token !== 'AS') return false;
    token = next();
    if (token === 'NOT') {
      token = next();
      if (token !== 'MATERIALIZED') return false;
    }
    if (token === 'MATERIALIZED') token = next();
    if (token !== '(' || !skipGroup()) return false;
    token = next();
    if (token !== ',') return token === 'SELECT';
    name = next();
  }
  return false;
}

export function prepareReadOnly(db: DatabaseSync, sql: string): StatementSync {
  const refused = () => new Error('query is read-only; provide one SELECT or WITH … SELECT statement');
  if (sql.includes('\0') || !startsWithSelect(sql)) throw refused();
  const statement = db.prepare(sql);
  // Prepare compiles only the first statement. Ask SQLite where it ended instead of splitting on ';'.
  const suffix = sql.slice(statement.sourceSQL.length);
  if (suffix.replace(TRIVIA, '') !== '') throw refused();
  return statement;
}

// D33: masking is fail-closed. A text value passes (address-sanitized only) when SQLite traces its output
// column to a column known to hold no personal data, or a preset declares the column safe. Known personal
// columns get their field mask; everything else (computed expressions, unknown columns, JSON payloads)
// is masked as free text. Numbers and NULL pass.
const SAFE_COLUMNS = new Set([
  'schema_migrations.version', 'schema_migrations.applied_at',
  'sources.name', 'sources.kind', 'sources.label', 'sources.consent_basis', 'sources.counts_as_opt_in',
  'sources.priority', 'sources.exported_at', 'sources.updated_at',
  'contacts.id', 'contacts.locale', 'contacts.email_status', 'contacts.flags', 'contacts.first_seen_at',
  'contacts.orphaned_at', 'contacts.created_at', 'contacts.updated_at',
  'contact_sources.contact_id', 'contact_sources.source', 'contact_sources.first_seen_at',
  'contact_sources.last_seen_at', 'contact_sources.occurrences', 'contact_sources.files',
  'consents.contact_id', 'consents.source', 'consents.status', 'consents.recorded_at',
  'suppressions.id', 'suppressions.reason', 'suppressions.source', 'suppressions.created_at',
  'runs.id', 'runs.command', 'runs.started_at', 'runs.finished_at', 'runs.status', 'runs.report_path',
  'rejected_rows.id', 'rejected_rows.run_id', 'rejected_rows.source', 'rejected_rows.file',
  'rejected_rows.row_number', 'rejected_rows.reason',
  'imports.id', 'imports.run_id', 'imports.source', 'imports.file', 'imports.sha256', 'imports.encoding',
  'imports.rows_read', 'imports.imported_at',
  'sync_log.id', 'sync_log.provider', 'sync_log.direction', 'sync_log.dry_run', 'sync_log.started_at',
  'sync_log.finished_at', 'sync_log.counts', 'sync_log.status',
]);
const EMAIL_COLUMNS = new Set(['contacts.email', 'contacts.suggested_email', 'contact_sources.raw_email', 'suppressions.email']);
const NAME_COLUMNS = new Set(['contacts.name']);
const JSON_COLUMNS = new Set(['contact_sources.raw_fields', 'consents.evidence']);
/** JSON columns without personal data (flag names, file names, counts): parsed, strings address-sanitized. */
const SAFE_JSON_COLUMNS = new Set(['contacts.flags', 'contact_sources.files', 'sync_log.counts']);
const REDACTED_COLUMNS = new Set(['suppressions.note', 'rejected_rows.raw_value']);

export interface ColumnOrigin { table: string | null; column: string | null }

/** Free text of unknown meaning: addresses masked, then only the first character kept. */
export function maskFreeText(value: string): string {
  const sanitized = sanitizeText(value);
  if (sanitized !== value) return sanitized;
  return maskName(value) || '***';
}

/** A leaf inside a JSON payload, labelled by its key (or the column named next to it). */
function redactLeaf(label: string, value: unknown): unknown {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  const text = String(value);
  const masked = maskValue(label, sanitizeText(text));
  if (masked !== sanitizeText(text)) return sanitizeText(masked);
  return maskFreeText(text);
}

/**
 * `meta` marks objects whose `column` / `file` keys name the source, not the person: the top level of
 * consents.evidence and each entry of raw_fields._merged_rows (D36). Everywhere else (a source column that
 * happens to be called "file") the value is masked like any other field.
 */
function redactJson(value: unknown, label = '', meta = false): unknown {
  if (Array.isArray(value)) return value.map((v: unknown) => redactJson(v, label, meta));
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(row).map(([key, cell]) => {
      // consents.evidence: {"column","file","row_number","value"}; column and file name the source, not the person.
      if (meta && (key === 'column' || key === 'file') && typeof cell === 'string') return [sanitizeText(key), sanitizeText(cell)];
      const inner = meta && key === 'value' && typeof row.column === 'string' ? row.column : key;
      return [sanitizeText(key), redactJson(cell, inner, !meta && key === MERGED_ROWS_KEY)];
    }));
  }
  return redactLeaf(label, value);
}

function sanitizeParsed(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.map(sanitizeParsed);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [sanitizeText(k), sanitizeParsed(v)]));
  }
  return value;
}

export function redactCell(field: string, value: unknown, origin: ColumnOrigin | null = null, safe: ReadonlySet<string> = new Set()): unknown {
  if (value instanceof Uint8Array) return `<blob len=${value.length}>`;
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (typeof value === 'number') return value;
  const text = String(value);
  const key = origin?.table && origin.column ? `${origin.table}.${origin.column}` : null;

  if (key && REDACTED_COLUMNS.has(key)) return '<redacted>';
  if (key && JSON_COLUMNS.has(key)) {
    try {
      return redactJson(JSON.parse(text) as unknown, '', key === 'consents.evidence');
    } catch {
      return '<invalid JSON redacted>';
    }
  }
  if (key && SAFE_JSON_COLUMNS.has(key)) {
    try {
      return sanitizeParsed(JSON.parse(text) as unknown);
    } catch {
      return '<invalid JSON redacted>';
    }
  }
  if (key && EMAIL_COLUMNS.has(key)) return sanitizeText(maskEmail(text));
  if (key && NAME_COLUMNS.has(key)) return maskFreeText(text);
  if (key === 'contacts.email_domain') {
    if (safe.has(field)) return sanitizeText(text); // domain distribution preset
    return sanitizeText(maskEmail(`x@${text}`).split('@').at(-1) ?? '***');
  }
  if ((key && SAFE_COLUMNS.has(key)) || safe.has(field)) return sanitizeText(text);
  return maskFreeText(text);
}

type EmitRow = (values: readonly SQLOutputValue[]) => void;

/** Don't let an output-directory symlink send private exports somewhere else, even within the workspace. */
export function requireOutputDir(workspace: string, dir: string): string {
  const relative = path.relative(workspace, dir);
  const real = fs.realpathSync(dir);
  if (!relative || path.isAbsolute(relative) || relative.split(path.sep)[0] === '..' ||
      real !== path.join(fs.realpathSync(workspace), relative)) {
    throw new Error('Refusing a redirected output directory; restore the normal workspace layout.');
  }
  return real;
}

export function writeCsv(dir: string, stem: string, headers: string[], writeRows: (emit: EmitRow) => void): string {
  const stamp = `${stem}-${backupStamp()}`;
  let file: string;
  let fd: number;
  for (let suffix = 0; ; suffix++) {
    file = path.join(dir, `${stamp}${suffix ? `-${suffix}` : ''}.csv`);
    try {
      fd = fs.openSync(file, 'wx', 0o600);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  function line(values: readonly SQLOutputValue[]): void {
    const cells = values.map((value) => {
      const text = value instanceof Uint8Array ? Buffer.from(value).toString('hex') : String(value ?? '');
      return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    });
    fs.writeFileSync(fd, `${cells.join(',')}\r\n`);
  }
  try {
    try {
      line(headers);
      writeRows(line);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    fs.unlinkSync(file);
    throw err;
  }
  return file;
}

export function executeQuery(
  db: DatabaseSync, query: Query, limit: number, exportsDir?: string,
): { rows: Record<string, unknown>[]; count?: number } | { export_file: string; row_count: number } {
  db.exec('PRAGMA query_only = ON');
  const stmt = prepareReadOnly(db, query.sql);
  const args = query.args ?? [];
  const columns = stmt.columns();
  const names = columns.map((c) => c.name);
  if (new Set(names).size !== names.length) throw new Error('Give duplicate result columns distinct aliases.');
  stmt.setReadBigInts(true);

  if (exportsDir !== undefined) {
    let row_count = 0;
    const export_file = writeCsv(exportsDir, 'query', names, (emit) => {
      for (const row of stmt.iterate(...args)) {
        emit(names.map((name) => row[name] ?? null));
        row_count++;
      }
    });
    return { export_file, row_count };
  }

  const safe = new Set(query.safe ?? []);
  const namesUsed = new Set<string>();
  const headers = names.map((name) => {
    const safe = sanitizeText(name);
    let header = safe;
    for (let n = 2; namesUsed.has(header); n++) header = `${safe}:${n}`;
    namesUsed.add(header);
    return header;
  });
  const rows: Record<string, unknown>[] = [];
  for (const row of stmt.iterate(...args)) {
    rows.push(Object.fromEntries(columns.map((col, i) =>
      [headers[i]!, redactCell(col.name, row[col.name], { table: col.table, column: col.column }, safe)])));
    if (rows.length >= limit) break;
  }
  return query.countSql ? { rows, count: Number(db.prepare(query.countSql).get()?.count) } : { rows };
}

/** Sanitize structured output before serializing, so redaction cannot alter JSON syntax. */
export function printJson(value: unknown): void {
  const safe = (item: unknown): unknown => {
    if (typeof item === 'string') return sanitizeText(item);
    if (Array.isArray(item)) return item.map(safe);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([key, cell]) => [sanitizeText(key), safe(cell)]));
    }
    return item;
  };
  process.stdout.write(`${JSON.stringify(safe(value), null, 2)}\n`);
}

export function printText(text: string, stream: NodeJS.WritableStream = process.stdout): void {
  stream.write(`${sanitizeText(text)}\n`);
}
