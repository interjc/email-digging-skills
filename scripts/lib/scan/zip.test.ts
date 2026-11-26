import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { DuckDBInstance } from '@duckdb/node-api';
import { isZipBuffer, readZipEntries } from './zip.ts';

function buildZip(
  files: Array<{ name: string; content: Buffer; method: 0 | 8; dataDescriptor?: boolean }>,
): Buffer {
  const localParts: Buffer[] = [];
  const cdParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const compressed = file.method === 8 ? deflateRawSync(file.content) : file.content;
    const flags = 0x0800 | (file.dataDescriptor ? 0x0008 : 0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(file.method, 8);
    local.writeUInt32LE(file.dataDescriptor ? 0 : compressed.length, 18);
    local.writeUInt32LE(file.dataDescriptor ? 0 : file.content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const dd = file.dataDescriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (file.dataDescriptor) {
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(0, 4);
      dd.writeUInt32LE(compressed.length, 8);
      dd.writeUInt32LE(file.content.length, 12);
    }

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(file.method, 10);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(file.content.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);

    localParts.push(local, nameBuf, compressed, dd);
    cdParts.push(cd, nameBuf);
    offset += local.length + nameBuf.length + compressed.length + dd.length;
  }

  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

describe('minimal in-memory ZIP reader', () => {
  it('reads stored, deflated, and data-descriptor entries', () => {
    const zip = buildZip([
      { name: 'plain.xml', content: Buffer.from('<root>hello</root>', 'utf8'), method: 0 },
      {
        name: 'xl/sheet1.xml',
        content: Buffer.from('<t>taro@example.com</t>', 'utf8'),
        method: 8,
        dataDescriptor: true,
      },
    ]);

    assert.equal(isZipBuffer(zip), true);
    const entries = readZipEntries(zip);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.name, 'plain.xml');
    assert.equal(entries[0]?.data.toString('utf8'), '<root>hello</root>');
    assert.equal(entries[1]?.name, 'xl/sheet1.xml');
    assert.equal(entries[1]?.data.toString('utf8'), '<t>taro@example.com</t>');
  });

  it('rejects non-zip buffers cleanly', () => {
    assert.equal(isZipBuffer(Buffer.from('plain text')), false);
    assert.throws(() => readZipEntries(Buffer.from('not a zip')), /Invalid ZIP/);
  });

  it('reads XML entries from a DuckDB-generated .xlsx file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zip-xlsx-test-'));
    const xlsxPath = join(dir, 'sample.xlsx');
    try {
      const db = await DuckDBInstance.create(':memory:');
      const conn = await db.connect();
      await conn.run('INSTALL excel; LOAD excel;');
      const escaped = xlsxPath.replaceAll("'", "''");
      await conn.run(
        `COPY (SELECT 'taro@example.com' AS email) TO '${escaped}' (FORMAT xlsx);`,
      );
      conn.closeSync();
      db.closeSync();

      const raw = readFileSync(xlsxPath);
      assert.equal(isZipBuffer(raw), true);
      const entries = readZipEntries(raw);
      const xmlEntries = entries.filter((e) => e.name.endsWith('.xml'));
      assert.ok(xmlEntries.length > 0, 'expected XML entries inside DuckDB xlsx');
      const combined = xmlEntries.map((e) => e.data.toString('utf8')).join('\n');
      assert.ok(combined.includes('taro@example.com'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
