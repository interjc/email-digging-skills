import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { parse as parseYaml } from 'yaml';
import { normalizeEmailCell } from './lib/email/normalize.ts';
import type { ExpectedJson, FixtureFileSpec } from './make-fixtures.ts';
import {
  computeExpected,
  decoderLabelFor,
  FIXTURE_OVERRIDES,
  FIXTURE_SOURCES,
  fixturesRootDir,
} from './make-fixtures.ts';

const FIXTURES_DIR = fixturesRootDir();

/** Extract all entries from a ZIP archive (.xlsx) in memory without external tools. */
function readZipEntries(buf: Buffer): Map<string, Buffer> {
  // Find End of Central Directory (EOCD) signature 0x06054b50
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  assert.ok(eocdOffset >= 0, 'ZIP EOCD header not found');

  const cdCount = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const entries = new Map<string, Buffer>();

  let cursor = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    assert.equal(buf.readUInt32LE(cursor), 0x02014b50, 'Central directory signature mismatch');
    const method = buf.readUInt16LE(cursor + 10);
    const compSize = buf.readUInt32LE(cursor + 20);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localHeaderOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    cursor += 46 + nameLen + extraLen + commentLen;

    assert.equal(buf.readUInt32LE(localHeaderOffset), 0x04034b50, 'Local header signature mismatch');
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : Buffer.alloc(0);
    entries.set(name, data);
  }
  return entries;
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out.sort();
}

function parseMetaFrontmatter(metaText: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(metaText);
  assert.ok(match !== null, 'meta.md must contain YAML frontmatter delimited by ---');
  const [, yamlBody, markdownBody] = match;
  assert.ok(markdownBody !== undefined && markdownBody.includes('## Notes'), 'meta.md must contain a ## Notes section');
  const parsed = parseYaml(yamlBody ?? '');
  assert.equal(typeof parsed, 'object');
  assert.ok(parsed !== null);
  return parsed as Record<string, unknown>;
}

const EMAIL_FINDER = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const ALLOWED_DOMAIN = /^(?:example\.[a-z0-9.-]+|[^@]+\.example|[^@]+\.test|[^@]+\.invalid|localhost)$/i;

function assertAllowedDomains(text: string, label: string): void {
  const folded = text.normalize('NFKC');
  for (const match of folded.matchAll(EMAIL_FINDER)) {
    const domain = match[1];
    assert.ok(
      domain !== undefined && ALLOWED_DOMAIN.test(domain),
      `Disallowed email domain "${domain}" in ${label}`,
    );
  }
}

describe('fixtures generator and committed fixtures', () => {
  it('round-trips every text fixture through its declared encoding and verifies BOMs and special bytes', () => {
    for (const spec of FIXTURE_SOURCES) {
      const srcDir = path.join(FIXTURES_DIR, 'sources', spec.source);
      const metaRaw = fs.readFileSync(path.join(srcDir, 'meta.md'));
      const metaText = new TextDecoder('utf-8', { fatal: true }).decode(metaRaw);
      const fm = parseMetaFrontmatter(metaText);
      assert.equal(fm.source, spec.source);
      assert.equal(fm.kind, spec.kind);
      assert.equal(fm.consent_basis, spec.consent_basis);

      for (const file of spec.files) {
        if (file.physicalEncoding === null) continue;
        const filePath = path.join(srcDir, file.name);
        const raw = fs.readFileSync(filePath);

        if (file.physicalEncoding === 'utf-8-sig') {
          assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${file.name} must start with UTF-8 BOM`);
        } else if (file.physicalEncoding === 'utf-16le-bom') {
          assert.deepEqual([...raw.subarray(0, 2)], [0xff, 0xfe], `${file.name} must start with UTF-16LE BOM`);
        }

        const label = decoderLabelFor(file.metaFile?.encoding ?? 'utf-8', file.physicalEncoding);
        const decoded = new TextDecoder(label, { fatal: true }).decode(raw);
        assert.ok(decoded.length > 0, `${file.name} decoded text must be non-empty`);

        // Verify key characters survived encoding round-trip
        if (spec.source === 'shop-alpha' && file.name === 'members_2025-03-01.csv') {
          assert.ok(decoded.includes('①'), 'CP932 fixture must include ①');
          assert.ok(decoded.includes('㈱'), 'CP932 fixture must include ㈱');
          assert.ok(decoded.includes('髙'), 'CP932 fixture must include 髙');
        }
        if (spec.source === 'cn-delta') {
          assert.ok(decoded.includes('\u{20000}'), 'GB18030 fixture must include U+20000 (𠀀)');
          assert.ok(
            raw.includes(Buffer.from([0x95, 0x32, 0x82, 0x36])),
            'GB18030 fixture must encode U+20000 as 95 32 82 36',
          );
        }
        if (spec.source === 'event-beta' && file.name === 'walkin_2023-11-03.csv') {
          const lines = decoded.trimEnd().split('\n');
          assert.equal(lines[2], file.headers.join(','), 'walkin CSV header must be on line 3 (header_row: 3)');
        }
      }
    }
  });

  it('verifies binary fixtures (.xlsx sheet/cells and .db rows) and form-eta R9 layout', () => {
    // Verify event-beta/attendees_2023-11-03.xlsx via in-memory ZIP inspection
    const xlsxPath = path.join(FIXTURES_DIR, 'sources', 'event-beta', 'attendees_2023-11-03.xlsx');
    const entries = readZipEntries(fs.readFileSync(xlsxPath));
    const workbookXml = entries.get('xl/workbook.xml')?.toString('utf8') ?? '';
    assert.ok(workbookXml.includes('name="attendees"'), 'XLSX workbook must contain sheet "attendees"');
    const allXml = [...entries.entries()]
      .filter(([name]) => name.endsWith('.xml'))
      .map(([, buf]) => buf.toString('utf8'))
      .join('\n');
    for (const h of ['Email', 'Name', 'Registered', 'Locale']) {
      assert.ok(allXml.includes(h), `XLSX must include header ${h}`);
    }
    assert.ok(allXml.includes('Taro.Suzuki@Example.JP'), 'XLSX must include Taro Suzuki row');
    assert.ok(allXml.includes('emily.chen@example.org'), 'XLSX must include Emily Chen rows');

    // Verify app-gamma/app_2025-08-01.db via node:sqlite
    const dbPath = path.join(FIXTURES_DIR, 'sources', 'app-gamma', 'app_2025-08-01.db');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare('SELECT id, email, display_name, created_at, newsletter, locale FROM users ORDER BY id').all();
      const appSpec = FIXTURE_SOURCES.find((s) => s.source === 'app-gamma');
      assert.ok(appSpec !== undefined);
      const dbFileSpec = appSpec.files[0];
      assert.ok(dbFileSpec !== undefined);
      assert.equal(rows.length, dbFileSpec.rows.length);
      assert.equal(rows[4]?.email, null);
      assert.equal(rows[3]?.newsletter, null);
    } finally {
      db.close();
    }

    // Verify form-eta R9 layout: duplicate CSV not in meta.md + pages/ with two .md files
    const formEtaDir = path.join(FIXTURES_DIR, 'sources', 'form-eta');
    const formMeta = parseMetaFrontmatter(fs.readFileSync(path.join(formEtaDir, 'meta.md'), 'utf8'));
    const listedFiles = (formMeta.files as Array<{ name: string }>).map((f) => f.name);
    assert.deepEqual(listedFiles, ['responses_2025-07-01.csv']);
    assert.ok(fs.existsSync(path.join(formEtaDir, 'responses_2025-07-01 (1).csv')));
    const pageFiles = fs.readdirSync(path.join(formEtaDir, 'pages')).sort();
    assert.equal(pageFiles.length, 2);
    assert.ok(pageFiles.every((f) => f.endsWith('.md')));
  });

  it('matches fixtures/expected.json against a fresh recount from annotations', () => {
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(FIXTURES_DIR, 'expected.json'), 'utf8'),
    ) as ExpectedJson;
    const recounted = computeExpected(FIXTURE_SOURCES, FIXTURE_OVERRIDES);
    assert.deepEqual(onDisk, recounted);
    assert.equal(Object.keys(onDisk.sources).length, 7);
    assert.equal(onDisk.after_overrides.excluded, 1);
    assert.equal(onDisk.after_overrides.typo_accepted, 1);
    assert.ok(onDisk.cross_source_dups >= 2);
    assert.ok(onDisk.overlap.length > 0);
  });

  it('agrees with normalizeEmailCell (R1) for every declared fixture row annotation', () => {
    const emailColFor = (spec: FixtureFileSpec): string => {
      const col = spec.headers.find((h) =>
        ['メールアドレス', '邮箱', 'Email Address', 'E-mail', 'mail', 'Email', 'email'].includes(h),
      );
      assert.ok(col !== undefined, `Could not find email header for ${spec.name}`);
      return col;
    };

    for (const src of FIXTURE_SOURCES) {
      for (const file of src.files) {
        const emailHeader = emailColFor(file);
        for (const row of file.rows) {
          const rawVal = row.cells[emailHeader];
          const cellStr = rawVal === null || rawVal === undefined ? null : String(rawVal);
          const candidates = normalizeEmailCell(cellStr);
          const { expect, emails, suggestion } = row.annotation;

          if (expect === 'empty') {
            assert.equal(candidates.length, 1);
            assert.equal(candidates[0]?.rejectReason, 'empty');
          } else if (expect === 'invalid') {
            assert.equal(candidates.length, 1);
            assert.equal(candidates[0]?.rejectReason, 'invalid_syntax');
          } else if (expect === 'split:3') {
            assert.equal(candidates.length, 3);
            assert.deepEqual(
              candidates.map((c) => c.email),
              emails,
            );
            assert.ok(candidates.every((c) => c.flags.includes('split_from_multi')));
          } else {
            assert.equal(candidates.length, 1, `Expected 1 candidate for ${cellStr}`);
            const cand = candidates[0];
            assert.ok(cand !== undefined);
            assert.equal(cand.rejectReason, null);
            assert.equal(cand.email, emails[0]);
            if (expect === 'role') assert.equal(cand.status, 'role');
            if (expect === 'typo') {
              assert.equal(cand.status, 'typo_suspect');
              assert.equal(cand.suggestion, suggestion);
            }
            if (expect === 'legacy') {
              assert.equal(cand.status, 'valid');
              assert.ok(cand.flags.includes('legacy_mobile_dots'));
            }
            if (expect === 'valid' || expect === 'excluded') {
              assert.equal(cand.status, 'valid');
            }
          }
        }
      }
    }
  });

  it('verifies overrides/*.yaml parse as top-level YAML lists matching FIXTURE_OVERRIDES', () => {
    const overridesDir = path.join(FIXTURES_DIR, 'overrides');
    const checks: Array<[string, unknown[]]> = [
      ['exclude.yaml', FIXTURE_OVERRIDES.exclude],
      ['typo-decisions.yaml', FIXTURE_OVERRIDES.typo],
      ['suppressions.yaml', FIXTURE_OVERRIDES.suppressions],
      ['consents.yaml', FIXTURE_OVERRIDES.consents],
    ];
    for (const [name, expectedList] of checks) {
      const parsed = parseYaml(fs.readFileSync(path.join(overridesDir, name), 'utf8'));
      assert.ok(Array.isArray(parsed), `${name} must be a top-level YAML list`);
      assert.deepEqual(parsed, expectedList);
    }
  });

  it('contains only allowed example.* email domains across every file in fixtures/', () => {
    const allFiles = walkFiles(FIXTURES_DIR);
    assert.ok(allFiles.length > 0);

    for (const filePath of allFiles) {
      const rel = path.relative(FIXTURES_DIR, filePath);
      const buf = fs.readFileSync(filePath);

      if (filePath.endsWith('.xlsx')) {
        const entries = readZipEntries(buf);
        for (const [entryName, data] of entries) {
          if (entryName.endsWith('.xml')) {
            assertAllowedDomains(data.toString('utf8'), `${rel}:${entryName}`);
          }
        }
      } else if (filePath.endsWith('.db')) {
        const db = new DatabaseSync(filePath, { readOnly: true });
        try {
          const rows = db.prepare('SELECT email FROM users').all();
          for (const row of rows) {
            if (typeof row.email === 'string') {
              assertAllowedDomains(row.email, rel);
            }
          }
        } finally {
          db.close();
        }
      } else {
        // Decode according to file BOM / source encoding
        let text: string;
        if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
          text = new TextDecoder('utf-16le', { fatal: true }).decode(buf);
        } else {
          try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
          } catch {
            try {
              text = new TextDecoder('shift_jis', { fatal: true }).decode(buf);
            } catch {
              text = new TextDecoder('gb18030', { fatal: true }).decode(buf);
            }
          }
        }
        assertAllowedDomains(text, rel);
      }
    }
  });
});
