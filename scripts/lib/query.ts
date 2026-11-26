import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';
import { backupStamp } from './db.ts';
import { maskEmail, maskValue } from './mask.ts';
import { sanitizeText } from './sanitize.ts';
import type { ProviderList } from './types.ts';

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
        GROUP BY email_domain ORDER BY contacts DESC, email_domain LIMIT 20` };
    case 'status':
      return { sql: `
        SELECT 'status' AS kind, CAST(email_status AS TEXT) AS value, count(*) AS contacts FROM contacts GROUP BY email_status
        UNION ALL
        SELECT 'flag', f.value, count(DISTINCT c.id) FROM contacts c, json_each(c.flags) f GROUP BY f.value
        ORDER BY kind DESC, value` };
    case 'consent':
      return { sql: `
        WITH statuses(status) AS (VALUES ('granted'), ('denied'), ('unknown'))
        SELECT s.name AS source, t.status, count(cs.contact_id) AS contacts
        FROM sources s CROSS JOIN statuses t
        LEFT JOIN (contact_sources cs LEFT JOIN consents k USING (contact_id, source))
          ON cs.source = s.name AND coalesce(k.status, 'unknown') = t.status
        GROUP BY s.name, t.status ORDER BY s.name, t.status` };
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

function redactCell(field: string, value: unknown, origin?: string | null): unknown {
  const label = (origin ?? field).normalize('NFKC').toLowerCase();
  if (value instanceof Uint8Array) return `<blob len=${value.length}>`;
  if (value === null || value === undefined) return value;
  if (['raw_fields', 'flags', 'evidence'].includes(label)) {
    try {
      return redactJson(JSON.parse(String(value)) as unknown);
    } catch {
      return '<invalid JSON redacted>';
    }
  }
  if (['raw_value', 'note'].includes(label)) return '<redacted>';
  if (label === 'email_status' && ['valid', 'role', 'typo_suspect'].includes(String(value))) return value;
  if (label === 'email_domain' && field === 'domain') return sanitizeText(String(value)); // Domain distribution preset.
  if (label === 'email_domain' && typeof value === 'string' && !value.includes('@')) {
    return sanitizeText(maskEmail(`x@${value}`).split('@').at(-1) ?? '***');
  }
  const text = typeof value === 'bigint' && Number.isSafeInteger(Number(value)) ? Number(value)
    : typeof value === 'bigint' ? value.toString() : value;
  // Address detection first, so a phone field containing an email cannot preserve its local part.
  const safe = sanitizeText(String(text));
  const originalMask = maskValue(label, safe);
  const masked = originalMask === safe && field !== label ? maskValue(field, safe) : originalMask;
  return masked === String(text) ? text : sanitizeText(masked);
}

function redactJson(value: unknown, field = ''): unknown {
  if (Array.isArray(value)) return value.map((v: unknown) => redactJson(v, field));
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(row).map(([key, cell]) => {
      const label = key === 'value' && typeof row.column === 'string' ? row.column : key;
      return [sanitizeText(key), redactJson(cell, label)];
    }));
  }
  return redactCell(field, value);
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
    rows.push(Object.fromEntries(columns.map((col, i) => [headers[i]!, redactCell(col.name, row[col.name], col.column)])));
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
