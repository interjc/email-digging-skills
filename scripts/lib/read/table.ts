// Open one source file as a table of strings: `headers` plus a stream of rows (arrays of string|null).
// Every cell is read as text; typing and cleaning happen later.

import fs from 'node:fs';
import path from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import type { FileFormat, MetaFile } from '../types.ts';
import { connect, ensureExtension, sqlIdent, sqlStr } from './duck.ts';

export interface OpenTable {
  headers: string[];
  rows: AsyncGenerator<Array<string | null>>;
  close(): Promise<void>;
}

export interface OpenTableOptions {
  /** For text formats: path of the UTF-8 copy (already decoded). Required for csv, tsv, json. */
  decodedPath?: string;
}

export function formatOf(file: string): FileFormat {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case '.csv': return 'csv';
    case '.tsv':
    case '.txt': return 'tsv';
    case '.xlsx': return 'xlsx';
    case '.json':
    case '.jsonl': return 'json';
    case '.db':
    case '.sqlite':
    case '.sqlite3': return 'sqlite';
    default:
      throw new Error(`unsupported file type "${ext || path.basename(file)}" (supported: .csv .tsv .txt .xlsx .json .jsonl .db .sqlite .sqlite3; save old .xls as .xlsx)`);
  }
}

const isTextFormat = (f: FileFormat): boolean => f === 'csv' || f === 'tsv' || f === 'json';
export { isTextFormat };

function cell(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v : String(v);
}

async function* streamRows(conn: DuckDBConnection, sql: string): AsyncGenerator<Array<string | null>> {
  const result = await conn.stream(sql);
  for await (const chunk of result.yieldRows()) {
    for (const row of chunk) yield row.map(cell);
  }
}

/** DuckDB names empty or repeated headers itself (`column3`, `email_1`); do the same for grid sources. */
export function uniqueHeaders(raw: Array<string | null>): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    let name = h === null || h.trim() === '' ? `column${i}` : h;
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    if (n > 0) name = `${name}_${n}`;
    return name;
  });
}

/** 1 → A, 26 → Z, 27 → AA. */
export function columnLetters(n: number): string {
  let s = '';
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s;
  return s;
}

/** Excel stores numbers as doubles; DuckDB prints whole ones as `2.0`. Drop the artifact. */
function xlsxCell(v: string | null): string | null {
  return v !== null && /^-?\d+\.0$/.test(v) ? v.slice(0, -2) : v;
}

export async function openTable(file: string, format: FileFormat, meta: MetaFile, opts: OpenTableOptions = {}): Promise<OpenTable> {
  const conn = await connect();
  const cleanups: Array<() => Promise<void>> = [];
  const close = async () => {
    for (const fn of cleanups.reverse()) {
      try { await fn(); } catch { /* best effort */ }
    }
    conn.closeSync();
  };
  try {
    const headerRow = meta.header_row ?? 1;
    if (headerRow < 1 || !Number.isInteger(headerRow)) throw new Error(`header_row must be a positive integer, got ${headerRow}`);

    if (format === 'csv' || format === 'tsv') {
      const p = opts.decodedPath ?? file;
      const delim = meta.delimiter ?? (format === 'tsv' ? '\t' : null);
      const options = [
        'header=true', 'all_varchar=true', 'null_padding=true', 'strict_mode=false',
        'parallel=false', // keeps file order and allows null padding with quoted newlines
        `skip=${headerRow - 1}`,
        ...(delim ? [`delim=${sqlStr(delim)}`] : []),
      ].join(', ');
      const result = await conn.stream(`SELECT * FROM read_csv(${sqlStr(p)}, ${options})`);
      const headers = result.columnNames();
      async function* gen(): AsyncGenerator<Array<string | null>> {
        for await (const chunk of result.yieldRows()) for (const row of chunk) yield row.map(cell);
      }
      return { headers, rows: gen(), close };
    }

    if (format === 'xlsx') {
      await ensureExtension('excel');
      const sheet = meta.sheet ? `, sheet=${sqlStr(meta.sheet)}` : '';
      const base = `header=false, all_varchar=true, stop_at_empty=false${sheet}`;
      // Without a range DuckDB takes the width of the first sheet row, which cuts the columns when
      // a short title row comes first, and (by default) stops at the first blank row. So: count the
      // rows, read the header row with a wide range, then read the data with an exact range.
      const countRows = await conn.runAndReadAll(`SELECT count(*) FROM read_xlsx(${sqlStr(file)}, ${base})`);
      const total = Number(countRows.getRows()[0]?.[0] ?? 0);
      if (total < headerRow) return { headers: [], rows: (async function* () {})(), close };
      const head = await conn.runAndReadAll(`SELECT * FROM read_xlsx(${sqlStr(file)}, ${base}, range='A1:XFD${headerRow}')`);
      const headerCells = (head.getRows()[headerRow - 1] ?? []).map(cell);
      let width = headerCells.length;
      while (width > 0 && (headerCells[width - 1] === null || (headerCells[width - 1] as string).trim() === '')) width--;
      const headers = uniqueHeaders(headerCells.slice(0, width).map(xlsxCell));
      async function* gen(): AsyncGenerator<Array<string | null>> {
        if (total <= headerRow || width === 0) return;
        const range = `A${headerRow + 1}:${columnLetters(width)}${total}`;
        for await (const row of streamRows(conn, `SELECT * FROM read_xlsx(${sqlStr(file)}, ${base}, range='${range}')`)) {
          if (row.every((v) => v === null || v.trim() === '')) continue; // blank sheet rows are not records
          yield row.map(xlsxCell);
        }
      }
      return { headers, rows: gen(), close };
    }

    if (format === 'sqlite') {
      await ensureExtension('sqlite');
      const alias = `src_${Math.random().toString(36).slice(2, 10)}`;
      await conn.run(`ATTACH ${sqlStr(file)} AS ${alias} (TYPE sqlite, READ_ONLY)`);
      cleanups.push(async () => { await conn.run(`DETACH ${alias}`); });
      let from: string;
      if (meta.query && meta.table) throw new Error('set either `table` or `query` for a SQLite file in meta.md, not both');
      if (meta.query) {
        from = `sqlite_query(${sqlStr(alias)}, ${sqlStr(meta.query)})`;
      } else {
        let table = meta.table ?? null;
        if (!table) {
          const tables = (await (await conn.runAndReadAll(
            `SELECT table_name FROM duckdb_tables() WHERE database_name = ${sqlStr(alias)} ORDER BY table_name`)).getRows())
            .map((r) => String(r[0]));
          if (tables.length === 1) table = tables[0] as string;
          else throw new Error(tables.length === 0
            ? 'the SQLite file has no tables'
            : `the SQLite file has several tables (${tables.join(', ')}); set \`table\` (or \`query\`) for this file in meta.md`);
        }
        from = `${alias}.main.${sqlIdent(table)}`;
      }
      const described = (await (await conn.runAndReadAll(`SELECT column_name FROM (DESCRIBE SELECT * FROM ${from})`)).getRows()).map((r) => String(r[0]));
      const select = described.map((c) => `CAST(${sqlIdent(c)} AS VARCHAR)`).join(', ');
      const rows = streamRows(conn, `SELECT ${select} FROM ${from}`);
      return { headers: uniqueHeaders(described), rows, close };
    }

    // json: every top-level element (array element or JSON line) is one record.
    await ensureExtension('json');
    const p = opts.decodedPath ?? file;
    const sql = `SELECT json FROM read_json_objects(${sqlStr(p)}, format='auto')`;
    const keys: string[] = [];
    const keySet = new Set<string>();
    for await (const [text] of streamRows(conn, sql)) {
      const obj = parseObject(text);
      for (const k of Object.keys(obj)) if (!keySet.has(k)) { keySet.add(k); keys.push(k); }
    }
    async function* gen(): AsyncGenerator<Array<string | null>> {
      for await (const [text] of streamRows(conn, sql)) {
        const obj = parseObject(text);
        yield keys.map((k) => jsonCell(obj[k]));
      }
    }
    return { headers: keys, rows: gen(), close };
  } catch (err) {
    await close();
    throw err;
  }
}

function parseObject(text: string | null | undefined): Record<string, unknown> {
  const v: unknown = JSON.parse(text ?? 'null');
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error('the JSON file must hold objects (an array of objects, or one object per line)');
  }
  return v as Record<string, unknown>;
}

function jsonCell(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Write the UTF-8 copy of a decoded text file and return its path. */
export function writeDecoded(dir: string, fileName: string, text: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${fileName}.utf8.txt`);
  fs.writeFileSync(out, text, 'utf8');
  return out;
}
