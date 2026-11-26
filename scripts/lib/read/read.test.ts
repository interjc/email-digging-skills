import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { MetaFile } from '../types.ts';
import { probeFile, readRows } from './index.ts';
import { findDuplicates } from './duplicates.ts';
import { GB, SJIS, collect, tmpDir, utf16le, writeFile, writeSqlite, writeXlsx } from './testutil.ts';

const mf = (name: string, extra: Partial<MetaFile> = {}): MetaFile => ({ name, encoding: 'auto', ...extra });

async function readAll(file: string, meta: MetaFile, columns = {}) {
  const probe = await probeFile(file, meta, { columns });
  return { probe, rows: await collect(readRows(file, meta, probe)) };
}

test('csv: UTF-8, quoted newlines and commas, row numbers in file order, blank lines skipped', async () => {
  const dir = tmpDir();
  let s = 'id,email,name\n';
  for (let i = 1; i <= 3000; i++) s += `${i},u${i}@example.com,"Name, ${i}\nline2"\n`;
  const f = writeFile(dir, 'a.csv', s);
  const { probe, rows } = await readAll(f, mf('a.csv'));
  assert.equal(probe.format, 'csv');
  assert.equal(probe.rowCount, 3000);
  assert.deepEqual(probe.headers, ['id', 'email', 'name']);
  assert.equal(rows.length, 3000);
  assert.ok(rows.every((r, i) => r.row_number === i + 1 && r.cells.id === String(i + 1)));
  assert.equal(rows[1]?.cells.name, 'Name, 2\nline2');
});

test('csv: ragged rows are padded, empty cells are null, duplicate headers are renamed', async () => {
  const dir = tmpDir();
  const f = writeFile(dir, 'r.csv', 'email,email,\na@example.com,b@example.com,1\nc@example.com\n,,\n');
  const { probe, rows } = await readAll(f, mf('r.csv'));
  assert.deepEqual(probe.headers, ['email', 'email_1', 'column2']);
  assert.equal(rows[1]?.cells.email_1, null);
  assert.equal(rows[2]?.cells.email, null);
});

test('csv: header only → zero rows; empty file → clear error', async () => {
  const dir = tmpDir();
  const h = await probeFile(writeFile(dir, 'h.csv', 'email,name\n'), mf('h.csv'));
  assert.equal(h.rowCount, 0);
  assert.deepEqual(h.headers, ['email', 'name']);
  await assert.rejects(probeFile(writeFile(dir, 'e.csv', ''), mf('e.csv')), /no header row/);
});

test('csv: header_row 3 skips the preamble; rows are numbered from the first data row', async () => {
  const dir = tmpDir();
  const f = writeFile(dir, 'p.csv', 'Exported by X\n,,\nemail,name\na@example.com,A\nb@example.com,B\n');
  const meta = mf('p.csv', { header_row: 3 });
  const { probe, rows } = await readAll(f, meta);
  assert.deepEqual(probe.headers, ['email', 'name']);
  assert.equal(probe.rowCount, 2);
  assert.deepEqual(rows.map((r) => [r.row_number, r.cells.email]), [[1, 'a@example.com'], [2, 'b@example.com']]);
});

test('csv: delimiter auto (semicolon) and explicit delimiter; CRLF; no trailing newline', async () => {
  const dir = tmpDir();
  const semi = await readAll(writeFile(dir, 's.csv', 'email;name\r\na@example.com;A\r\nb@example.com;B'), mf('s.csv'));
  assert.deepEqual(semi.probe.headers, ['email', 'name']);
  assert.equal(semi.rows.length, 2);
  const pipe = await readAll(writeFile(dir, 'p.csv', 'email|name\na@example.com|A\n'), mf('p.csv', { delimiter: '|' }));
  assert.deepEqual(pipe.probe.headers, ['email', 'name']);
});

test('tsv/.txt: tab separated; UTF-16LE with BOM and encoding auto', async () => {
  const dir = tmpDir();
  const f = path.join(dir, 'u.txt');
  fs.writeFileSync(f, utf16le('メール\t氏名\na@example.com\t山田\nb@example.com\t鈴木\n'));
  const { probe, rows } = await readAll(f, mf('u.txt'));
  assert.equal(probe.format, 'tsv');
  assert.deepEqual([probe.encoding, probe.encodingHow], ['utf-16le', 'bom']);
  assert.deepEqual(probe.headers, ['メール', '氏名']);
  assert.equal(rows[1]?.cells['氏名'], '鈴木');
  assert.equal(probe.mappings.find((m) => m.field === 'email')?.column, 'メール');
});

test('csv: UTF-8 with BOM has no BOM in the first header', async () => {
  const dir = tmpDir();
  const f = writeFile(dir, 'b.csv', [0xef, 0xbb, 0xbf], 'email,name\na@example.com,A\n');
  const probe = await probeFile(f, mf('b.csv'));
  assert.deepEqual([probe.encoding, probe.encodingHow], ['utf-8-sig', 'bom']);
  assert.equal(probe.headers[0], 'email');
});

test('csv: CP932 with ①㈱髙, read through the decoded copy; gb18030 with a 4-byte character', async () => {
  const dir = tmpDir();
  const cp = writeFile(dir, 'cp.csv', SJIS.mailAddress, ',', SJIS.shimei, '\na@example.com,', SJIS.circled1, SJIS.kabu, SJIS.takaTall, '\n');
  const a = await readAll(cp, mf('cp.csv'));
  assert.equal(a.probe.encoding, 'cp932');
  assert.deepEqual(a.probe.headers, ['メールアドレス', '氏名']);
  assert.equal(a.rows[0]?.cells['氏名'], '①㈱髙');
  const gb = writeFile(dir, 'gb.csv', 'email,name\nb@example.com,', GB.ext, '\n');
  const b = await readAll(gb, mf('gb.csv'));
  assert.equal(b.probe.encoding, 'gb18030');
  assert.equal(b.rows[0]?.cells.name, '\u{20000}');
});

test('csv: declared encoding wrong → hard error naming the encoding', async () => {
  const dir = tmpDir();
  const f = writeFile(dir, 'w.csv', [0xff, 0xff, 0xff]);
  await assert.rejects(probeFile(f, mf('w.csv', { encoding: 'utf-8' })), /cannot decode as utf-8/);
});

test('csv: decodedDir keeps the UTF-8 copy there; without it nothing is left behind', async () => {
  const dir = tmpDir();
  const f = writeFile(dir, 'd.csv', 'email\na@example.com\n');
  const decoded = path.join(dir, '_decoded');
  const meta = mf('d.csv');
  const probe = await probeFile(f, meta, { decodedDir: decoded });
  await collect(readRows(f, meta, probe, { decodedDir: decoded }));
  assert.deepEqual(fs.readdirSync(decoded), ['d.csv.utf8.txt']);
  assert.equal(fs.readFileSync(path.join(decoded, 'd.csv.utf8.txt'), 'utf8'), 'email\na@example.com\n');
});

test('xlsx: header row, sheet name, numbers without .0, blank rows skipped', async () => {
  const dir = tmpDir();
  const f = path.join(dir, 'x.xlsx');
  await writeXlsx(f, [['email', 'name', 'when', 'n'], ['a@example.com', 'A', '45356', '7'], [null, null, null, null], ['b@example.com', null, '45357.5', '8']], 'People');
  const meta = mf('x.xlsx', { sheet: 'People' });
  const { probe, rows } = await readAll(f, meta);
  assert.deepEqual([probe.format, probe.encoding, probe.encodingHow], ['xlsx', null, 'n/a']);
  assert.deepEqual(probe.headers, ['email', 'name', 'when', 'n']);
  assert.equal(probe.rowCount, 2);
  assert.deepEqual(rows.map((r) => r.row_number), [1, 2]);
  assert.equal(rows[0]?.cells.name, 'A');
  assert.equal(rows[1]?.cells.name, null);
  assert.equal(rows[1]?.cells.when, '45357.5');
});

test('xlsx: header_row 3', async () => {
  const dir = tmpDir();
  const f = path.join(dir, 'x3.xlsx');
  await writeXlsx(f, [['Report', null], ['generated', 'today'], ['email', 'name'], ['a@example.com', 'A']]);
  const { probe, rows } = await readAll(f, mf('x3.xlsx', { header_row: 3 }));
  assert.deepEqual(probe.headers, ['email', 'name']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.cells.email, 'a@example.com');
});

test('sqlite: single table is found; table and query options; NULL stays null', async () => {
  const dir = tmpDir();
  const f = path.join(dir, 's.db');
  await writeSqlite(f, 'people', ['id', 'mail', 'created'], [['1', 'a@example.com', '2024-01-02 03:04:05'], ['2', null, null]]);
  const one = await readAll(f, mf('s.db'));
  assert.equal(one.probe.format, 'sqlite');
  assert.deepEqual(one.probe.headers, ['id', 'mail', 'created']);
  assert.deepEqual(one.rows.map((r) => r.cells.mail), ['a@example.com', null]);
  assert.equal(one.probe.mappings.find((m) => m.field === 'email')?.column, 'mail');
  const byTable = await readAll(f, mf('s.db', { table: 'people' }));
  assert.equal(byTable.rows.length, 2);
  const byQuery = await readAll(f, mf('s.db', { query: 'select mail as email from people where id = 1' }));
  assert.deepEqual(byQuery.probe.headers, ['email']);
  assert.equal(byQuery.rows.length, 1);
});

test('sqlite: several tables need `table`', async () => {
  const dir = tmpDir();
  const f = path.join(dir, 'm.db');
  await writeSqlite(f, 'a', ['email'], [['a@example.com']]);
  await writeSqlite(f, 'b', ['email'], [['b@example.com']]);
  await assert.rejects(probeFile(f, mf('m.db')), /several tables \(a, b\)/);
  const { rows } = await readAll(f, mf('m.db', { table: 'b' }));
  assert.equal(rows[0]?.cells.email, 'b@example.com');
});

test('json: array of objects, heterogeneous keys, nested values as JSON text', async () => {
  const dir = tmpDir();
  const f = writeFile(dir, 'j.json', JSON.stringify([{ email: 'a@example.com', n: 1, o: { x: 1 } }, { email: 'b@example.com', extra: true, nothing: null }]));
  const { probe, rows } = await readAll(f, mf('j.json'));
  assert.equal(probe.format, 'json');
  assert.deepEqual(probe.headers, ['email', 'n', 'o', 'extra', 'nothing']);
  assert.deepEqual(rows[0]?.cells, { email: 'a@example.com', n: '1', o: '{"x":1}', extra: null, nothing: null });
  assert.equal(rows[1]?.cells.extra, 'true');
  assert.equal(rows[1]?.cells.nothing, null);
});

test('jsonl: one object per line', async () => {
  const dir = tmpDir();
  const f = writeFile(dir, 'j.jsonl', '{"email":"a@example.com"}\n{"email":"b@example.com","k":[1,2]}\n');
  const { rows } = await readAll(f, mf('j.jsonl'));
  assert.equal(rows.length, 2);
  assert.equal(rows[1]?.cells.k, '[1,2]');
});

test('json: top-level values that are not objects are rejected', async () => {
  const dir = tmpDir();
  await assert.rejects(probeFile(writeFile(dir, 'bad.json', '[1,2,3]'), mf('bad.json')), /must hold objects/);
});

test('unsupported extension is rejected with the supported list', async () => {
  const dir = tmpDir();
  await assert.rejects(probeFile(writeFile(dir, 'old.xls', 'x'), mf('old.xls')), /unsupported file type ".xls".*\.xlsx/);
});

test('probe: meta column mapping wins; content sniff finds an unlabeled email column', async () => {
  const dir = tmpDir();
  const f = writeFile(dir, 'c.csv', 'a,b\nx,u1@example.com\ny,u2@example.com\n');
  const sniff = await probeFile(f, mf('c.csv'));
  const email = sniff.mappings.find((m) => m.field === 'email');
  assert.deepEqual([email?.column, email?.how, email?.confidence], ['b', 'content_sniff', 1]);
  const meta = await probeFile(f, mf('c.csv'), { columns: { email: 'a', name: 'b' } });
  assert.deepEqual(meta.mappings.filter((m) => m.how === 'meta').map((m) => [m.field, m.column]), [['email', 'a'], ['name', 'b']]);
});

test('R9 duplicates: same headers and rows in another column order are suspected duplicates', async () => {
  const dir = tmpDir();
  const a = writeFile(dir, 'responses_2025-07-01.csv', 'Name,Email,Newsletter\nA,a@example.com,Yes\nB,b@example.com,No\n');
  const b = writeFile(dir, 'responses_2025-07-01 (1).csv', 'Email,Newsletter,Name\nb@example.com,No,B\na@example.com,Yes,A\n');
  const c = writeFile(dir, 'responses_other.csv', 'Name,Email,Newsletter\nA,a@example.com,Yes\nC,c@example.com,No\n'); // same headers, different rows
  const inputs = [];
  for (const [name, p] of [['responses_2025-07-01 (1).csv', b], ['responses_2025-07-01.csv', a], ['responses_other.csv', c]] as const) {
    const meta = mf(name);
    inputs.push({ name, path: p, meta, probe: await probeFile(p, meta) });
  }
  const dups = await findDuplicates(inputs);
  assert.deepEqual([...dups], [['responses_2025-07-01 (1).csv', 'responses_2025-07-01.csv']]);
});

test('R9 duplicates: a different header set is not a duplicate even with the same values', async () => {
  const dir = tmpDir();
  const a = writeFile(dir, 'a.csv', 'Name,Email\nA,a@example.com\n');
  const b = writeFile(dir, 'b.csv', 'Name,Mail\nA,a@example.com\n');
  const inputs = [];
  for (const [name, p] of [['a.csv', a], ['b.csv', b]] as const) inputs.push({ name, path: p, meta: mf(name), probe: await probeFile(p, mf(name)) });
  assert.equal((await findDuplicates(inputs)).size, 0);
});
