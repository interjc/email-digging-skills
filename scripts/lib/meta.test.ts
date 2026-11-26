import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadMeta, MetaError, listSourceDir, renderMetaDraft } from './meta.ts';
import { tmpDir } from './read/testutil.ts';

const repo = path.resolve(import.meta.dirname, '..', '..');

/** Make `<tmp>/<name>/` with the given data files and a meta.md made of `front`. */
function source(name: string, front: string, files: string[] = ['a.csv']): string {
  const dir = path.join(tmpDir(), name);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'email\na@example.com\n');
  fs.writeFileSync(path.join(dir, 'meta.md'), `---\n${front}\n---\n\n## Notes\n- x\n`);
  return dir;
}

const MIN = 'source: shop-a\nkind: product\nfiles:\n  - name: a.csv';

function errorsOf(dir: string): string[] {
  try {
    loadMeta(dir);
  } catch (err) {
    assert.ok(err instanceof MetaError, String(err));
    return err.errors;
  }
  assert.fail('expected loadMeta to throw');
}

test('loadMeta: minimal meta gets the defaults (encoding auto, header_row 1, null label/exported_at, unknown basis)', () => {
  const dir = source('shop-a', MIN);
  const meta = loadMeta(dir);
  assert.deepEqual(meta, {
    source: 'shop-a', kind: 'product', label: null,
    files: [{ name: 'a.csv', encoding: 'auto', header_row: 1 }],
    columns: {}, consent_basis: 'unknown', exported_at: null, dir,
  });
});

test('loadMeta: full meta (YAML date, columns, consent_values with numbers, file options)', () => {
  const dir = source('shop-a', [
    'source: shop-a', 'kind: event', 'label: Shop A', 'consent_basis: opt_in', 'exported_at: 2025-03-01',
    'files:', '  - name: a.csv', '    encoding: cp932', '    header_row: 3', '    delimiter: tab',
    '  - name: b.xlsx', '    sheet: People', '  - name: c.db', '    table: people',
    'columns:', '  email: メールアドレス', '  name:', '  consent: 配信',
    'consent_values:', '  granted: [1, "yes"]', '  denied: [0]',
  ].join('\n'), ['a.csv', 'b.xlsx', 'c.db']);
  const meta = loadMeta(dir);
  assert.equal(meta.exported_at, '2025-03-01');
  assert.deepEqual(meta.files, [
    { name: 'a.csv', encoding: 'cp932', header_row: 3, delimiter: '\t' },
    { name: 'b.xlsx', encoding: 'auto', header_row: 1, sheet: 'People' },
    { name: 'c.db', encoding: 'auto', header_row: 1, table: 'people' },
  ]);
  assert.deepEqual(meta.columns, { email: 'メールアドレス', consent: '配信' });
  assert.deepEqual(meta.consent_values, { granted: ['1', 'yes'], denied: ['0'] });
  assert.equal(meta.consent_basis, 'opt_in');
  assert.equal(meta.kind, 'event');
  assert.equal(meta.label, 'Shop A');
});

test('loadMeta: file entries may be plain names; BOM and CRLF in meta.md are fine', () => {
  const dir = source('shop-a', 'source: shop-a\nkind: other\nfiles:\n  - a.csv');
  fs.writeFileSync(path.join(dir, 'meta.md'), '﻿---\r\nsource: shop-a\r\nkind: other\r\nfiles:\r\n  - a.csv\r\n---\r\nbody\r\n');
  assert.equal(loadMeta(dir).files[0]?.name, 'a.csv');
});

test('loadMeta: source must equal the directory name and match the name pattern', () => {
  assert.match(errorsOf(source('shop-a', 'source: shop-b\nkind: product\nfiles:\n  - name: a.csv')).join('\n'), /source: "shop-b" must equal the directory name "shop-a"/);
  assert.match(errorsOf(source('Shop_A', 'source: Shop_A\nkind: product\nfiles:\n  - name: a.csv')).join('\n'), /source: "Shop_A" must be lowercase/);
  assert.match(errorsOf(source('shop-a', 'kind: product\nfiles:\n  - name: a.csv')).join('\n'), /source: required/);
  for (const bad of ['a--b', '-a', 'a-', 'a b']) {
    assert.match(errorsOf(source(bad, `source: ${JSON.stringify(bad)}\nkind: other\nfiles:\n  - name: a.csv`)).join('\n'), /source:/, bad);
  }
});

test('loadMeta: errors name the field (kind, consent_basis, encoding, header_row, exported_at, files)', () => {
  const cases: Array<[string, RegExp]> = [
    ['source: shop-a\nfiles:\n  - name: a.csv', /kind: required/],
    ['source: shop-a\nkind: person\nfiles:\n  - name: a.csv', /kind: "person" must be one of/],
    [`${MIN}\nconsent_basis: maybe`, /consent_basis: "maybe" must be one of/],
    [`${MIN}\n    encoding: latin1`, /files\[0\]\.encoding: "latin1" must be one of/],
    [`${MIN}\n    header_row: 0`, /files\[0\]\.header_row: must be a whole number >= 1/],
    [`${MIN}\n    header_row: two`, /files\[0\]\.header_row/],
    [`${MIN}\nexported_at: 2025-02-30`, /exported_at: "2025-02-30" is not a valid/],
    [`${MIN}\nexported_at: March 2025`, /exported_at: "March 2025" is not a valid/],
    ['source: shop-a\nkind: other', /files: required/],
    ['source: shop-a\nkind: other\nfiles: []', /files: required/],
    ['source: shop-a\nkind: other\nfiles:\n  - encoding: auto', /files\[0\]\.name: required/],
    [`${MIN}\n  - name: a.csv`, /files\[1\]\.name: "a\.csv" is listed twice/],
    [`${MIN}\n    delimiter: ab`, /files\[0\]\.delimiter: expected one character/],
    [`${MIN}\ncolumns: [email]`, /columns: expected a mapping/],
    [`${MIN}\nconsent_values:\n  granted: yes`, /consent_values\.granted: expected a list/],
  ];
  for (const [front, re] of cases) assert.match(errorsOf(source('shop-a', front)).join('\n'), re, front);
});

test('loadMeta: file names must stay inside the source directory and exist', () => {
  const traversal = errorsOf(source('shop-a', 'source: shop-a\nkind: other\nfiles:\n  - name: ../x.csv'));
  assert.match(traversal.join('\n'), /files\[0\]\.name: must be a file name inside the source directory/);
  const missing = errorsOf(source('shop-a', 'source: shop-a\nkind: other\nfiles:\n  - name: nope.csv'));
  assert.match(missing.join('\n'), /files\[0\]\.name: file "nope\.csv" does not exist in shop-a\//);
});

test('loadMeta: no meta.md, no frontmatter, bad YAML', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'shop-a'));
  assert.throws(() => loadMeta(path.join(dir, 'shop-a')), /meta\.md not found/);
  fs.writeFileSync(path.join(dir, 'shop-a', 'meta.md'), 'just notes\n');
  assert.throws(() => loadMeta(path.join(dir, 'shop-a')), /must start with a YAML frontmatter/);
  fs.writeFileSync(path.join(dir, 'shop-a', 'meta.md'), '---\nsource: [unclosed\n---\n');
  assert.throws(() => loadMeta(path.join(dir, 'shop-a')), /not valid YAML/);
});

test('loadMeta (D21): table and query together are an error', () => {
  const e = errorsOf(source('shop-a', 'source: shop-a\nkind: other\nfiles:\n  - name: a.db\n    table: t\n    query: select 1', ['a.db']));
  assert.match(e.join('\n'), /files\[0\]: set either `table` or `query`, not both/);
});

test('loadMeta (D21): a value in both consent lists (after normalization) is an error naming the value', () => {
  const e = errorsOf(source('shop-a', `${MIN}\nconsent_values:\n  granted: ['Yes', '1']\n  denied: ['no', ' YES ']`));
  assert.match(e.join('\n'), /consent_values: " YES " is listed under both granted and denied/);
  // distinct values are fine
  assert.doesNotThrow(() => loadMeta(source('shop-a', `${MIN}\nconsent_values:\n  granted: ['yes']\n  denied: ['no']`)));
});

test('loadMeta (D21): unknown keys are warnings, not errors', () => {
  const dir = source('shop-a', `${MIN}\n    note: hi\ntimezone: Asia/Tokyo\ncolumns:\n  mail: x\nconsent_values:\n  maybe: [1]`);
  const warnings: string[] = [];
  const meta = loadMeta(dir, (w) => warnings.push(w));
  assert.equal(meta.source, 'shop-a');
  assert.deepEqual(warnings.sort(), [
    'meta.md: unknown key "columns.mail" ignored (standard fields: email, name, created_at, last_seen_at, locale, consent)',
    'meta.md: unknown key "consent_values.maybe" ignored',
    'meta.md: unknown key "files[0].note" ignored',
    'meta.md: unknown key "timezone" ignored',
  ]);
});

test('loadMeta: data files present but not listed are warnings (meta files, NOTES.txt, .md and subdirectories are not)', () => {
  const dir = source('shop-a', MIN, ['a.csv', 'extra.csv', 'old.xlsx']);
  fs.writeFileSync(path.join(dir, 'NOTES.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'meta.draft.md'), 'x');
  fs.writeFileSync(path.join(dir, 'readme.MD'), 'x');
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');
  fs.mkdirSync(path.join(dir, 'pages'));
  fs.writeFileSync(path.join(dir, 'pages', 'inner.csv'), 'x');
  const warnings: string[] = [];
  loadMeta(dir, (w) => warnings.push(w));
  assert.deepEqual(warnings.sort(), [
    'shop-a/extra.csv is in the directory but not listed in meta.md; it will not be read',
    'shop-a/old.xlsx is in the directory but not listed in meta.md; it will not be read',
  ]);
});

test('R9 listSourceDir: regular files only; subdirectories reported; stem order puts "a.csv" before "a (1).csv"', () => {
  const dir = tmpDir();
  for (const f of ['b.csv', 'a (1).csv', 'a.csv', 'meta.md', 'NOTES.txt', 'x.md', '.hidden']) fs.writeFileSync(path.join(dir, f), 'x');
  fs.mkdirSync(path.join(dir, 'pages'));
  fs.symlinkSync(path.join(dir, 'a.csv'), path.join(dir, 'link.csv')); // a symlink is not a regular file
  assert.deepEqual(listSourceDir(dir), { files: ['a.csv', 'a (1).csv', 'b.csv'], subdirs: ['pages'] });
});

test('every fixture meta.md loads (and the form-eta duplicate and pages/ are not read)', () => {
  const sources = path.join(repo, 'fixtures', 'sources');
  if (!fs.existsSync(sources)) return;
  for (const name of fs.readdirSync(sources)) {
    const warnings: string[] = [];
    const meta = loadMeta(path.join(sources, name), (w) => warnings.push(w));
    assert.equal(meta.source, name);
    if (name === 'form-eta') {
      assert.deepEqual(meta.files.map((f) => f.name), ['responses_2025-07-01.csv']);
      assert.deepEqual(warnings, ['form-eta/responses_2025-07-01 (1).csv is in the directory but not listed in meta.md; it will not be read']);
    }
  }
});

test('renderMetaDraft: confident mappings are values, guesses are comments; duplicates are commented out; output loads', () => {
  const draft = renderMetaDraft({
    source: 'shop-a',
    files: [
      { name: 'a.csv', probe: { file: 'a.csv', format: 'csv', encoding: 'cp932', encodingHow: 'detected', encodingCandidates: ['cp932', 'gb18030'], headers: [], rowCount: 1, mappings: [] } },
      { name: 'a (1).csv', probe: null, duplicateOf: 'a.csv' },
    ],
    exportedAt: '2025-03-01',
    mappings: [
      { field: 'email', column: 'メールアドレス', how: 'header_synonym', confidence: 0.9 },
      { field: 'name', column: 'Full name here', how: 'header_synonym', confidence: 0.7 },
      { field: 'created_at', column: null, how: 'none', confidence: 0 },
    ],
  });
  assert.match(draft, /encoding: auto {2}# detected cp932 \(candidates: cp932, gb18030\)/);
  assert.match(draft, /# suspected duplicate of a\.csv/);
  assert.match(draft, /# - name: "a \(1\)\.csv"|# - name: a \(1\)\.csv/);
  assert.match(draft, /^ {2}email: メールアドレス/m);
  assert.match(draft, /^ {2}name: {3}# guess: Full name here \(header_synonym, 0\.7\); confirm/m);
  assert.match(draft, /exported_at: 2025-03-01 {3}# guessed/);
  const dir = path.join(tmpDir(), 'shop-a');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'a.csv'), 'x');
  fs.writeFileSync(path.join(dir, 'meta.md'), draft);
  const meta = loadMeta(dir);
  assert.deepEqual(meta.files.map((f) => f.name), ['a.csv']);
  assert.deepEqual(meta.columns, { email: 'メールアドレス' });
  assert.equal(meta.exported_at, '2025-03-01');
});

// ---------------------------------------------------------------------------
// Review R1 rework
// ---------------------------------------------------------------------------

test('R1-6: a listed symlink to an external file, a directory named like a file, and .md files are errors', () => {
  const dir = source('shop-a', 'source: shop-a\nkind: other\nfiles:\n  - name: a.csv', ['a.csv']);
  const outside = path.join(tmpDir(), 'outside.csv');
  fs.writeFileSync(outside, 'email\na@example.com\n');
  fs.symlinkSync(outside, path.join(dir, 'link.csv'));
  fs.mkdirSync(path.join(dir, 'folder.csv'));
  fs.writeFileSync(path.join(dir, 'notes.md'), 'x');
  fs.symlinkSync(path.join(dir, 'a.csv'), path.join(dir, 'inner-link.csv'));
  fs.symlinkSync(path.join(dir, 'gone.csv'), path.join(dir, 'broken.csv'));
  const front = (name: string) => `source: shop-a\nkind: other\nfiles:\n  - name: ${name}`;
  const write = (name: string) => fs.writeFileSync(path.join(dir, 'meta.md'), `---\n${front(name)}\n---\n`);

  write('link.csv');
  assert.match(errorsOf(dir).join('\n'), /files\[0\]\.name: "link\.csv" is a symlink to a file outside the source directory/);
  write('folder.csv');
  assert.match(errorsOf(dir).join('\n'), /files\[0\]\.name: "folder\.csv" is not a regular file/);
  write('notes.md');
  assert.match(errorsOf(dir).join('\n'), /files\[0\]\.name: "notes\.md" is not a data file/);
  write('meta.md');
  assert.match(errorsOf(dir).join('\n'), /is not a data file/);
  write('broken.csv');
  assert.match(errorsOf(dir).join('\n'), /broken symlink/);
  write('inner-link.csv'); // a symlink whose real path stays inside the directory is fine
  assert.equal(loadMeta(dir).files[0]?.name, 'inner-link.csv');
});

test('R1-1 (D28): YAML errors and invalid values never echo an address', () => {
  const dir = source('shop-a', 'source: shop-a\nkind: other\nfiles:\n  - name: a.csv');
  fs.writeFileSync(path.join(dir, 'meta.md'), '---\nsource: [secret.person@example.com\n---\n');
  assert.throws(() => loadMeta(dir), (err: Error) => {
    assert.doesNotMatch(err.message, /secret\.person|@example/);
    assert.match(err.message, /not valid YAML/);
    return true;
  });
  const bad = errorsOf(source('shop-b', 'source: shop-b\nkind: secret.person@example.com\nfiles:\n  - name: a.csv'));
  assert.doesNotMatch(bad.join('\n'), /secret\.person@example\.com/);
  assert.match(bad.join('\n'), /kind: "s\*\*\*@e\*\*\*e\.com" must be one of/);
  // warnings are sanitized too
  const warnings: string[] = [];
  loadMeta(source('shop-c', 'source: shop-c\nkind: other\nfiles:\n  - name: a.csv\n    x@example.org: 1'), (w) => warnings.push(w));
  assert.ok(warnings.length > 0);
  assert.ok(warnings.every((w) => !/x@example\.org/.test(w)));
});
