// Helpers for the tests in this directory (and stage/meta/add-source tests). Not a test file itself.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, ensureExtension, sqlStr } from './duck.ts';

export function tmpDir(prefix = 't6-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function bytes(...parts: Array<number[] | string>): Buffer {
  return Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'utf8') : Buffer.from(p))));
}

// Hand-encoded CP932 / GB18030 pieces (no iconv in the toolchain).
export const SJIS = {
  mail: [0x83, 0x81, 0x81, 0x5b, 0x83, 0x8b], // メール
  mailAddress: [0x83, 0x81, 0x81, 0x5b, 0x83, 0x8b, 0x83, 0x41, 0x83, 0x68, 0x83, 0x8c, 0x83, 0x58], // メールアドレス
  shimei: [0x8e, 0x81, 0x96, 0xbc], // 氏名
  circled1: [0x87, 0x40], // ①
  kabu: [0x87, 0x8a], // ㈱
  takaTall: [0xfb, 0xfc], // 髙
  halfKana: [0xb1], // ｱ
};
export const GB = {
  youxiang: [0xd3, 0xca, 0xcf, 0xe4], // 邮箱
  ext: [0x95, 0x32, 0x82, 0x36], // 𠀀 (U+20000, four bytes)
};

export const CRLF = [0x0d, 0x0a];

/** Write a file made of text and byte pieces. */
export function writeFile(dir: string, name: string, ...parts: Array<number[] | string>): string {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, bytes(...parts));
  return p;
}

export function utf16le(text: string, bom = true): Buffer {
  return Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(text, 'utf16le')]);
}

export function utf16be(text: string, bom = true): Buffer {
  const le = Buffer.from(text, 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let i = 0; i < le.length; i += 2) { be[i] = le[i + 1] as number; be[i + 1] = le[i] as number; }
  return Buffer.concat([bom ? Buffer.from([0xfe, 0xff]) : Buffer.alloc(0), be]);
}

/** Create an xlsx file from rows of cells (first row = header) with DuckDB's excel extension. */
export async function writeXlsx(file: string, rows: Array<Array<string | number | null>>, sheet = 'Sheet1'): Promise<void> {
  await ensureExtension('excel');
  const conn = await connect();
  try {
    const width = Math.max(...rows.map((r) => r.length));
    const lit = (v: string | number | null) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : sqlStr(v));
    const names = Array.from({ length: width }, (_, i) => `c${i}`);
    // header=false output: the first row of `rows` is written as data.
    const selects = rows.map((r) => `SELECT ${names.map((n, i) => `${lit(r[i] ?? null)}::VARCHAR AS ${n}`).join(', ')}`);
    await conn.run(`COPY (${selects.join(' UNION ALL BY NAME ')}) TO ${sqlStr(file)} (FORMAT xlsx, HEADER false, SHEET ${sqlStr(sheet)})`);
  } finally {
    conn.closeSync();
  }
}

/** Create a SQLite file with one table (all text columns) and rows. */
export async function writeSqlite(file: string, table: string, columns: string[], rows: Array<Array<string | null>>): Promise<void> {
  await ensureExtension('sqlite');
  const conn = await connect();
  try {
    await conn.run(`ATTACH ${sqlStr(file)} AS w (TYPE sqlite)`);
    await conn.run(`CREATE TABLE w."${table}" (${columns.map((c) => `"${c}" VARCHAR`).join(', ')})`);
    for (const r of rows) {
      await conn.run(`INSERT INTO w."${table}" VALUES (${r.map((v) => (v === null ? 'NULL' : sqlStr(v))).join(', ')})`);
    }
    await conn.run('DETACH w');
  } finally {
    conn.closeSync();
  }
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
