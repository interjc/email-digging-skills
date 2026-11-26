import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Overrides, SourceMeta, SourceStageResult } from './types.ts';
import { stageSource } from './stage.ts';
import { loadMeta } from './meta.ts';
import { loadOverrides } from './overrides.ts';
import { connect, ensureExtension, sqlStr } from './read/duck.ts';
import { GB, SJIS, tmpDir, writeFile } from './read/testutil.ts';

const repo = path.resolve(import.meta.dirname, '..', '..');
const NO_OVERRIDES: Overrides = { typo: [], suppressions: [], consents: [], exclude: [] };

/** Read a Parquet file back as plain JSON rows. */
async function parquet(file: string): Promise<Array<Record<string, unknown>>> {
  await ensureExtension('parquet');
  const conn = await connect();
  try {
    return (await conn.runAndReadAll(`SELECT * FROM read_parquet(${sqlStr(file)})`)).getRowObjectsJson() as Array<Record<string, unknown>>;
  } finally {
    conn.closeSync();
  }
}

async function parquetTypes(file: string): Promise<Record<string, string>> {
  const conn = await connect();
  try {
    const rows = (await conn.runAndReadAll(`SELECT column_name, column_type FROM (DESCRIBE SELECT * FROM read_parquet(${sqlStr(file)}))`)).getRows();
    return Object.fromEntries(rows.map((r) => [String(r[0]), String(r[1])]));
  } finally {
    conn.closeSync();
  }
}

function makeMeta(dir: string, over: Partial<SourceMeta> = {}): SourceMeta {
  return {
    source: path.basename(dir), kind: 'other', label: null,
    files: [{ name: 'a.csv', encoding: 'auto', header_row: 1 }],
    columns: {}, consent_basis: 'unknown', exported_at: null, dir, ...over,
  };
}

function sourceDir(name = 'shop-a'): string {
  const dir = path.join(tmpDir(), name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const CSV = [
  'Email,Name,Created,Locale,Newsletter,Extra',
  'Taro@Example.com, Taro Yamada ,2024/3/5 9:07,ja,yes,k1',
  'info@example.com,,2024年3月6日,,0,k2',
  'bad-address,Bad,not a date,en,maybe,k3',
  ',Empty,,,,k4',
  'a@example.com; b@example.org,Multi,2024-03-07,ja,1,k5',
  'taro@example.com,Dup,2024-03-08,ja,,k6',
  'user@example.con,Typo,,,,k7',
  'ｆｗ＠example.net,Wide,,,,k8',
].join('\n') + '\n';

test('stageSource: rows, rejected rows, stats and Parquet schema for one CSV', async () => {
  const dir = sourceDir();
  writeFile(dir, 'a.csv', CSV);
  const staging = tmpDir();
  const r = await stageSource(makeMeta(dir), { stagingDir: staging, overrides: NO_OVERRIDES });

  assert.equal(r.source, 'shop-a');
  assert.equal(r.dir, path.join(staging, 'shop-a'));
  const f = r.files[0]!;
  assert.deepEqual(
    [f.rows_read, f.empty, f.invalid, f.cells_split, f.dup_in_file, f.role, f.typo_suspect],
    [8, 1, 1, 1, 1, 1, 1],
  );
  assert.equal(f.sha256, sha(path.join(dir, 'a.csv')));
  assert.deepEqual([f.encoding, f.encodingHow], ['utf-8', 'detected']);
  assert.equal(f.mappings.find((m) => m.field === 'email')?.column, 'Email');
  assert.equal(r.staged_rows, 7); // 8 rows - 2 rejected + 1 extra split
  assert.equal(r.rejected_rows, 2);
  assert.equal(r.unique_emails, 6); // taro@ appears twice

  const rows = await parquet(path.join(r.dir, 'rows.parquet'));
  assert.equal(rows.length, 7);
  const taro = rows[0] as Record<string, any>;
  assert.equal(taro.source, 'shop-a');
  assert.equal(taro.file, 'a.csv');
  assert.equal(taro.row_number, 1);
  assert.equal(taro.split_index, 0);
  assert.equal(taro.raw_email, 'Taro@Example.com');
  assert.equal(taro.email, 'taro@example.com');
  assert.equal(taro.email_domain, 'example.com');
  assert.equal(taro.email_status, 'valid');
  assert.deepEqual(taro.flags, []);
  assert.equal(taro.suggested_email, null);
  assert.equal(taro.name, 'Taro Yamada'); // trimmed
  assert.equal(taro.locale, 'ja');
  assert.equal(taro.created_at, '2024-03-05T09:07:00');
  assert.equal(taro.last_seen_at, null);
  assert.equal(taro.consent_raw, 'yes');
  assert.equal(taro.consent_status, 'granted');
  assert.deepEqual(JSON.parse(taro.raw_fields as string), {
    Email: 'Taro@Example.com', Name: ' Taro Yamada ', Created: '2024/3/5 9:07', Locale: 'ja', Newsletter: 'yes', Extra: 'k1',
  });

  const role = rows[1] as Record<string, any>;
  assert.deepEqual([role.email, role.email_status, role.flags, role.name, role.locale, role.created_at, role.consent_status], ['info@example.com', 'role', ['role_address'], null, null, '2024-03-06', 'denied']);

  // split cell → two rows with the same row_number
  const multi = rows.filter((x) => x.row_number === 5);
  assert.deepEqual(multi.map((x) => [x.email, x.split_index, x.flags]), [
    ['a@example.com', 0, ['split_from_multi']],
    ['b@example.org', 1, ['split_from_multi']],
  ]);
  assert.equal(multi[0]?.name, 'Multi');

  const typo = rows.find((x) => x.row_number === 7) as Record<string, any>;
  assert.deepEqual([typo.email, typo.email_status, typo.flags, typo.suggested_email], ['user@example.con', 'typo_suspect', ['typo_suspect'], 'user@example.com']);
  assert.equal(typo.raw_email, 'user@example.con'); // never rewritten

  const wide = rows.find((x) => x.row_number === 8) as Record<string, any>;
  assert.deepEqual([wide.email, wide.flags], ['fw@example.net', ['width_normalized']]);

  const rejected = await parquet(path.join(r.dir, 'rejected.parquet'));
  assert.deepEqual(rejected.map((x) => [x.row_number, x.raw_value, x.reason]), [[3, 'bad-address', 'invalid_syntax'], [4, null, 'empty']]);

  const types = await parquetTypes(path.join(r.dir, 'rows.parquet'));
  assert.equal(types.flags, 'VARCHAR[]');
  assert.equal(types.raw_fields, 'VARCHAR');
  assert.equal(types.row_number, 'INTEGER');

  const stats = JSON.parse(fs.readFileSync(path.join(r.dir, 'stats.json'), 'utf8')) as SourceStageResult;
  assert.deepEqual(stats, r);
  assert.deepEqual(fs.readdirSync(r.dir).sort(), ['rejected.parquet', 'rows.parquet', 'stats.json']); // no temp files left
});

test('stageSource: dup_in_file counts extra occurrences in the same file only', async () => {
  const dir = sourceDir();
  writeFile(dir, 'a.csv', 'email\nx@example.com\nX@example.com\nx@example.com\ny@example.com\n');
  writeFile(dir, 'b.csv', 'email\nx@example.com\n');
  const meta = makeMeta(dir, { files: [{ name: 'a.csv', encoding: 'auto' }, { name: 'b.csv', encoding: 'auto' }] });
  const r = await stageSource(meta, { stagingDir: tmpDir(), overrides: NO_OVERRIDES });
  assert.deepEqual(r.files.map((f) => f.dup_in_file), [2, 0]);
  assert.equal(r.unique_emails, 2);
  assert.equal(r.staged_rows, 5);
});

test('stageSource: consent via meta consent_values and an explicit column mapping', async () => {
  const dir = sourceDir();
  writeFile(dir, 'a.csv', 'mail_addr,opt\na@example.com,済\nb@example.com,yes\nc@example.com,停止\nd@example.com,\n');
  const meta = makeMeta(dir, {
    columns: { email: 'mail_addr', consent: 'opt' },
    consent_values: { granted: ['済'], denied: ['停止'] },
  });
  const r = await stageSource(meta, { stagingDir: tmpDir(), overrides: NO_OVERRIDES });
  const rows = await parquet(path.join(r.dir, 'rows.parquet'));
  assert.deepEqual(rows.map((x) => [x.consent_raw, x.consent_status]), [['済', 'granted'], ['yes', 'unknown'], ['停止', 'denied'], [null, 'unknown']]);
  assert.ok(r.files[0]?.mappings.some((m) => m.field === 'email' && m.how === 'meta' && m.confidence === 1));
});

test('stageSource: no consent column → unknown for every row', async () => {
  const dir = sourceDir();
  writeFile(dir, 'a.csv', 'email\na@example.com\n');
  const r = await stageSource(makeMeta(dir), { stagingDir: tmpDir(), overrides: NO_OVERRIDES });
  const rows = await parquet(path.join(r.dir, 'rows.parquet'));
  assert.deepEqual([rows[0]?.consent_raw, rows[0]?.consent_status], [null, 'unknown']);
});

test('stageSource: overrides (D14/D22): exclude exact and pattern; typo accept; typo reject', async () => {
  const dir = sourceDir();
  writeFile(dir, 'a.csv', [
    'email,name',
    'qa-test@example.com,QA',
    'bot123@example.org,Bot',
    'hiroshi@example.con,Typo accepted',
    'saki@example.co.jo,Typo rejected',
    'info@example.co.jo,Role plus typo rejected',
    'keep@example.com,Keep',
    'wrong@example.con,Accepted then excluded',
    'Qa-Test@Example.com,Mixed case excluded too',
  ].join('\n') + '\n');
  const overrides: Overrides = {
    typo: [
      { email: 'hiroshi@example.con', action: 'accept', suggested: 'hiroshi@example.com' },
      { email: 'saki@example.co.jo', action: 'reject' },
      { email: 'info@example.co.jo', action: 'reject' },
      { email: 'wrong@example.con', action: 'accept' },
    ],
    suppressions: [], consents: [],
    exclude: [{ email: 'qa-test@example.com' }, { pattern: 'bot*@example.org' }, { email: 'wrong@example.com' }],
  };
  const r = await stageSource(makeMeta(dir), { stagingDir: tmpDir(), overrides });
  const rows = await parquet(path.join(r.dir, 'rows.parquet'));
  const byName = (n: string) => rows.find((x) => x.name === n) as Record<string, any>;

  const accepted = byName('Typo accepted');
  assert.deepEqual([accepted.email, accepted.email_domain, accepted.email_status, accepted.flags, accepted.suggested_email, accepted.raw_email],
    ['hiroshi@example.com', 'example.com', 'valid', ['typo_accepted'], null, 'hiroshi@example.con']);
  const rejected = byName('Typo rejected');
  assert.deepEqual([rejected.email, rejected.email_status, rejected.flags, rejected.suggested_email],
    ['saki@example.co.jo', 'valid', [], null]);
  const roleRejected = byName('Role plus typo rejected');
  assert.deepEqual([roleRejected.email_status, roleRejected.flags], ['role', ['role_address']]); // status recomputed

  const excluded = (await parquet(path.join(r.dir, 'rejected.parquet'))).map((x) => [x.row_number, x.raw_value, x.reason]);
  assert.deepEqual(excluded, [
    [1, 'qa-test@example.com', 'excluded_by_override'],
    [2, 'bot123@example.org', 'excluded_by_override'],
    [7, 'wrong@example.con', 'excluded_by_override'], // D22: matches the address after the accepted typo
    [8, 'Qa-Test@Example.com', 'excluded_by_override'],
  ]);
  assert.deepEqual(rows.map((x) => x.name), ['Typo accepted', 'Typo rejected', 'Role plus typo rejected', 'Keep']);
  // stats count staged rows after overrides
  assert.deepEqual([r.files[0]?.typo_suspect, r.files[0]?.role, r.files[0]?.invalid, r.files[0]?.empty], [0, 1, 0, 0]);
  assert.equal(r.unique_emails, 4);
});

test('stageSource: typo accept uses the human-written suggestion when it differs from the rule', async () => {
  const dir = sourceDir();
  writeFile(dir, 'a.csv', 'email\nx@gmial.com\n'); // email-scan:allow
  const overrides: Overrides = { ...NO_OVERRIDES, typo: [{ email: 'x@gmial.com', action: 'accept', suggested: 'x@example.net' }] }; // email-scan:allow
  const r = await stageSource(makeMeta(dir), { stagingDir: tmpDir(), overrides });
  const rows = await parquet(path.join(r.dir, 'rows.parquet'));
  assert.deepEqual([rows[0]?.email, rows[0]?.flags], ['x@example.net', ['typo_accepted']]);
});

test('stageSource: email column not found → error names the file and the headers, no values', async () => {
  const dir = sourceDir();
  writeFile(dir, 'a.csv', 'foo,bar\nsecret-value@example.com,x\n');
  // "foo" has no "@" in >= 50% of values? It does here, so use a file without any @ column
  writeFile(dir, 'b.csv', 'foo,bar\nplain,text\n');
  const meta = makeMeta(dir, { files: [{ name: 'b.csv', encoding: 'auto' }] });
  await assert.rejects(stageSource(meta, { stagingDir: tmpDir(), overrides: NO_OVERRIDES }), (err: Error) => {
    assert.match(err.message, /^b\.csv: no email column found\. Headers seen: "foo", "bar"/);
    assert.doesNotMatch(err.message, /plain|text/);
    return true;
  });
});

test('stageSource: reads only the files listed in meta; never modifies the source directory', async () => {
  const dir = sourceDir();
  writeFile(dir, 'a.csv', 'email\na@example.com\n');
  writeFile(dir, 'unlisted.csv', 'email\nz@example.com\n');
  const before = [sha(path.join(dir, 'a.csv')), sha(path.join(dir, 'unlisted.csv'))];
  const listing = fs.readdirSync(dir).sort();
  const r = await stageSource(makeMeta(dir), { stagingDir: tmpDir(), overrides: NO_OVERRIDES });
  assert.equal(r.staged_rows, 1);
  assert.deepEqual([sha(path.join(dir, 'a.csv')), sha(path.join(dir, 'unlisted.csv'))], before);
  assert.deepEqual(fs.readdirSync(dir).sort(), listing);
});

test('stageSource: re-staging removes and recreates the source directory, leaves other sources alone', async () => {
  const dir = sourceDir('shop-a');
  writeFile(dir, 'a.csv', 'email\na@example.com\n');
  const staging = tmpDir();
  const other = path.join(staging, 'other-source');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'keep.txt'), 'x');
  const first = await stageSource(makeMeta(dir), { stagingDir: staging, overrides: NO_OVERRIDES });
  fs.writeFileSync(path.join(first.dir, 'stale.txt'), 'old');
  fs.mkdirSync(path.join(first.dir, '_decoded'), { recursive: true });
  const second = await stageSource(makeMeta(dir), { stagingDir: staging, overrides: NO_OVERRIDES });
  assert.deepEqual(fs.readdirSync(second.dir).sort(), ['rejected.parquet', 'rows.parquet', 'stats.json']);
  assert.ok(fs.existsSync(path.join(other, 'keep.txt')));
  assert.deepEqual(second, first);
});

test('stageSource: an empty result still writes valid Parquet files', async () => {
  const dir = sourceDir();
  writeFile(dir, 'a.csv', 'email\n');
  const r = await stageSource(makeMeta(dir), { stagingDir: tmpDir(), overrides: NO_OVERRIDES });
  assert.equal(r.staged_rows, 0);
  assert.deepEqual(await parquet(path.join(r.dir, 'rows.parquet')), []);
  assert.deepEqual(await parquet(path.join(r.dir, 'rejected.parquet')), []);
});

test('stageSource: CP932 and GB18030 files, 4-byte names, auto-detected', async () => {
  const dir = sourceDir();
  writeFile(dir, 'jp.csv', SJIS.mailAddress, ',', SJIS.shimei, '\na@example.com,', SJIS.circled1, SJIS.kabu, SJIS.takaTall, '\n');
  writeFile(dir, 'cn.csv', 'email,name\nb@example.com,', GB.ext, '\n');
  const meta = makeMeta(dir, { files: [{ name: 'jp.csv', encoding: 'auto' }, { name: 'cn.csv', encoding: 'auto' }] });
  const r = await stageSource(meta, { stagingDir: tmpDir(), overrides: NO_OVERRIDES });
  assert.deepEqual(r.files.map((f) => f.encoding), ['cp932', 'gb18030']);
  const rows = await parquet(path.join(r.dir, 'rows.parquet'));
  assert.deepEqual(rows.map((x) => x.name), ['①㈱髙', '\u{20000}']);
});

test('stageSource: invalid source names are refused before anything is removed', async () => {
  const dir = sourceDir('shop-a');
  const staging = tmpDir();
  await assert.rejects(stageSource(makeMeta(dir, { source: '../x' }), { stagingDir: staging, overrides: NO_OVERRIDES }), /invalid source name/);
});

// ---------------------------------------------------------------------------
// Fixtures: every source, in one process, against fixtures/expected.json
// ---------------------------------------------------------------------------

interface Expected {
  sources: Record<string, { files: Record<string, Record<string, number>>; unique_emails: number }>;
  after_overrides: { excluded: number; typo_accepted: number };
}

const expectedPath = path.join(repo, 'fixtures', 'expected.json');
const haveFixtures = fs.existsSync(expectedPath);

test('fixtures: stage every source in one process and compare with expected.json', { skip: !haveFixtures }, async () => {
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8')) as Expected;
  const overrides = loadOverrides(path.join(repo, 'fixtures', 'overrides'));
  const staging = tmpDir();
  let excluded = 0;
  let typoAccepted = 0;
  for (const name of Object.keys(expected.sources)) {
    const meta = loadMeta(path.join(repo, 'fixtures', 'sources', name));
    const r = await stageSource(meta, { stagingDir: staging, overrides });
    const want = expected.sources[name]!;
    assert.deepEqual(r.files.map((f) => f.file), Object.keys(want.files), `${name}: files`);
    for (const f of r.files) {
      const got = Object.fromEntries(Object.keys(want.files[f.file]!).map((k) => [k, (f as unknown as Record<string, number>)[k]]));
      assert.deepEqual(got, want.files[f.file], `${name}/${f.file}`);
    }
    assert.equal(r.unique_emails, want.unique_emails, `${name}: unique_emails`);
    excluded += (await parquet(path.join(r.dir, 'rejected.parquet'))).filter((x) => x.reason === 'excluded_by_override').length;
    typoAccepted += (await parquet(path.join(r.dir, 'rows.parquet'))).filter((x) => (x.flags as string[]).includes('typo_accepted')).length;
  }
  assert.equal(excluded, expected.after_overrides.excluded);
  assert.equal(typoAccepted, expected.after_overrides.typo_accepted);
});

test('fixtures: file encodings, header_row, xlsx/sqlite/json formats and null encodings (D23)', { skip: !haveFixtures }, async () => {
  const overrides = loadOverrides(path.join(repo, 'fixtures', 'overrides'));
  const staging = tmpDir();
  const stat = async (name: string) => stageSource(loadMeta(path.join(repo, 'fixtures', 'sources', name)), { stagingDir: staging, overrides });
  const beta = await stat('event-beta');
  assert.deepEqual([beta.files[0]?.encoding, beta.files[0]?.encodingHow], [null, 'n/a']); // xlsx: null in stats, merge stores 'n/a'
  assert.notEqual(beta.files[1]?.encoding, null); // its CSV
  const gamma = await stat('app-gamma');
  assert.deepEqual([gamma.files[0]?.encoding, gamma.files[0]?.encodingHow], [null, 'n/a']); // sqlite
  const eps = await stat('export-epsilon');
  assert.deepEqual([eps.files[0]?.encoding, eps.files[0]?.encodingHow], ['utf-16le', 'bom']);
  const delta = await stat('cn-delta');
  assert.equal(delta.files[0]?.encoding, 'gb18030');
});

test('fixtures: form-eta month-name dates (R5 addendum) land in created_at', { skip: !haveFixtures }, async () => {
  const overrides = loadOverrides(path.join(repo, 'fixtures', 'overrides'));
  const r = await stageSource(loadMeta(path.join(repo, 'fixtures', 'sources', 'form-eta')), { stagingDir: tmpDir(), overrides });
  const rows = await parquet(path.join(r.dir, 'rows.parquet'));
  const map = r.files[0]!.mappings.find((m) => m.field === 'created_at');
  assert.deepEqual([map?.column, map?.how], ['Submission time', 'header_synonym']);
  assert.equal(rows.length, 5);
  assert.ok(rows.every((x) => x.created_at !== null), 'every month-name date parsed');
  assert.ok(rows.some((x) => /^\d{4}-\d{2}-\d{2}$/.test(String(x.created_at))), 'one date-only value');
  assert.ok(rows.some((x) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(x.created_at))), 'datetime values');
});
