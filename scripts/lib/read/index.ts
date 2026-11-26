// Probe and read one source file. Public API of lib/read:
//   probeFile(path, metaFile?, opts?) → FileProbe
//   readRows(path, metaFile, probe, opts?) → AsyncIterable<{ row_number, cells }>

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FileProbe, MetaFile, SourceMeta } from '../types.ts';
import { decodeBytes } from './decode.ts';
import { sanitizeText } from '../sanitize.ts';
import type { DecodeResult } from './decode.ts';
import { detectColumns } from './synonyms.ts';
import { formatOf, isTextFormat, openTable, writeDecoded } from './table.ts';
import type { OpenTable } from './table.ts';

export { formatOf } from './table.ts';
export { parseDate } from './dates.ts';
export { makeConsentMatcher } from './consent.ts';
export { detectColumns, normalizeHeader } from './synonyms.ts';
export { decodeBytes } from './decode.ts';

export interface ReadOptions {
  /** Directory for the UTF-8 copy of a decoded text file. Default: a temp directory removed afterwards. */
  decodedDir?: string;
  /** Non-fatal findings, e.g. "columns beyond ZZ are not read" for xlsx. */
  onWarning?: (message: string) => void;
}

export interface ProbeOptions extends ReadOptions {
  /** `columns` of meta.md, so mappings from meta come first. */
  columns?: SourceMeta['columns'];
}

export interface RowRecord {
  /** 1-based data row in file order (header and preamble rows excluded). */
  row_number: number;
  cells: Record<string, string | null>;
}

const SAMPLE_LIMIT = 200;

interface Prepared {
  decode: DecodeResult | null;
  decodedPath: string | undefined;
  cleanup(): void;
}

function prepare(file: string, format: ReturnType<typeof formatOf>, meta: MetaFile, opts: ReadOptions, declaredEncodingOverride?: DecodeResult['encoding']): Prepared {
  if (!isTextFormat(format)) return { decode: null, decodedPath: undefined, cleanup() {} };
  const bytes = fs.readFileSync(file);
  const decode = decodeBytes(bytes, declaredEncodingOverride ?? meta.encoding ?? 'auto', { headerRow: meta.header_row ?? 1 });
  const ownDir = opts.decodedDir === undefined;
  const dir = opts.decodedDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mail-decoded-'));
  if (decode.text.trim() === '') throw new Error('no header row found (the file is empty)');
  const decodedPath = writeDecoded(dir, path.basename(file), decode.text);
  return {
    decode,
    decodedPath,
    cleanup() {
      if (ownDir) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Errors can quote file content (CSV parse errors do): every message leaves here sanitized (D28). */
function sanitized(err: unknown): Error {
  const out = new Error(sanitizeText(err instanceof Error ? err.message : String(err)));
  if (err instanceof Error) out.name = err.name;
  return out;
}

export async function probeFile(file: string, metaFile?: MetaFile, opts: ProbeOptions = {}): Promise<FileProbe> {
  try {
    return await probeFileUnsafe(file, metaFile, opts);
  } catch (err) {
    throw sanitized(err);
  }
}

async function probeFileUnsafe(file: string, metaFile: MetaFile | undefined, opts: ProbeOptions): Promise<FileProbe> {
  const meta: MetaFile = metaFile ?? { name: path.basename(file), encoding: 'auto' };
  const format = formatOf(file);
  if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);
  const prep = prepare(file, format, meta, opts);
  let table: OpenTable | null = null;
  try {
    table = await openTable(file, format, meta, { decodedPath: prep.decodedPath, onWarning: opts.onWarning ? (m) => opts.onWarning?.(sanitizeText(m)) : undefined });
    const headers = table.headers;
    if (headers.length === 0) throw new Error('no header row found (the file is empty, or header_row is past the end)');
    const samples: Array<Array<string | null>> = headers.map(() => []);
    let rowCount = 0;
    for await (const row of table.rows) {
      rowCount++;
      for (let i = 0; i < headers.length; i++) {
        const v = row[i] ?? null;
        const bucket = samples[i] as Array<string | null>;
        if (v !== null && v.trim() !== '' && bucket.length < SAMPLE_LIMIT) bucket.push(v);
      }
    }
    return {
      file: meta.name,
      format,
      encoding: prep.decode ? prep.decode.encoding : null,
      encodingHow: prep.decode ? prep.decode.how : 'n/a',
      encodingCandidates: prep.decode ? prep.decode.candidates : [],
      headers,
      rowCount,
      mappings: detectColumns({ headers, samples, metaColumns: opts.columns }),
    };
  } finally {
    await table?.close();
    prep.cleanup();
  }
}

/** Read every data row as strings, keyed by header. The encoding comes from the probe. */
export async function* readRows(file: string, metaFile: MetaFile, probe: FileProbe, opts: ReadOptions = {}): AsyncGenerator<RowRecord> {
  try {
    yield* readRowsUnsafe(file, metaFile, probe, opts);
  } catch (err) {
    throw sanitized(err);
  }
}

async function* readRowsUnsafe(file: string, metaFile: MetaFile, probe: FileProbe, opts: ReadOptions): AsyncGenerator<RowRecord> {
  const format = formatOf(file);
  const prep = prepare(file, format, metaFile, opts, probe.encoding ?? undefined);
  let table: OpenTable | null = null;
  try {
    table = await openTable(file, format, metaFile, { decodedPath: prep.decodedPath });
    const headers = table.headers;
    let n = 0;
    for await (const row of table.rows) {
      n++;
      const cells: Record<string, string | null> = {};
      for (let i = 0; i < headers.length; i++) cells[headers[i] as string] = row[i] ?? null;
      yield { row_number: n, cells };
    }
  } finally {
    await table?.close();
    prep.cleanup();
  }
}
