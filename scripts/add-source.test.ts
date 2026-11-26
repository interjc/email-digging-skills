import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { addSource, guessExportDate } from './add-source.ts';
import { loadMeta } from './lib/meta.ts';
import { layoutDirs, workspaceLayout } from './lib/paths.ts';
import { SJIS, tmpDir, writeFile, writeSqlite, writeXlsx } from './lib/read/testutil.ts';
import { withWorkspaceLock } from './lib/lock.ts';

const repo = path.resolve(import.meta.dirname, '..');

/** A minimal initialized workspace outside the repository (layout directories and an empty db file). */
function workspace(): { ws: string; resources: string } {
  const ws = path.join(tmpDir('t6-ws-'), 'ws');
  const layout = workspaceLayout(ws);
  for (const d of layoutDirs(layout)) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(layout.dbPath, '');
  return { ws, resources: layout.resources };
}

test('addSource: a missing source directory is created and nothing else happens', async () => {
  const { ws, resources } = workspace();
  const { report } = await addSource('shop-a', { workspace: ws });
  assert.equal(report.created_dir, true);
  assert.ok(fs.statSync(path.join(resources, 'shop-a')).isDirectory());
  assert.deepEqual(fs.readdirSync(path.join(resources, 'shop-a')), []);
  assert.equal(report.meta_file, null);
});

test('addSource: invalid names are refused', async () => {
  const { ws } = workspace();
  for (const bad of ['Shop', 'a_b', '../x', 'a--b', '-a', '']) {
    await assert.rejects(addSource(bad, { workspace: ws }), /invalid source name/, bad);
  }
});

test('addSource: an uninitialized workspace is a precondition error (exit 2 from the CLI)', async () => {
  const empty = path.join(tmpDir('t6-empty-'), 'ws');
  await assert.rejects(addSource('shop-a', { workspace: empty }), /not exist|not initialized/);
  const r = spawnSync('node', ['scripts/add-source.ts', 'shop-a', '--workspace', empty], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 2);
});

test('addSource: probes files, writes meta.md that loads, masks samples, lists what to confirm', async () => {
  const { ws, resources } = workspace();
  const dir = path.join(resources, 'shop-a');
  writeFile(dir, 'members_2025-03-01.csv', SJIS.mailAddress, ',', SJIS.shimei, ',Created\ntaro@example.jp,', [0x8e, 0x81, 0x96, 0xbc], ',2025/3/1\nhanako@example.jp,Hanako,2025/3/2\n');
  writeFile(dir, 'plain_2025-04-15.csv', 'Foo,Customer Email Address\nx,one@example.com\ny,two@example.com\n');
  fs.mkdirSync(path.join(dir, 'pages'));
  fs.writeFileSync(path.join(dir, 'pages', 'x.md'), 'notes');
  fs.writeFileSync(path.join(dir, 'NOTES.txt'), 'notes');

  const { report } = await addSource('shop-a', { workspace: ws });
  assert.equal(report.created_dir, false);
  assert.deepEqual(report.files.map((f) => f.file), ['members_2025-03-01.csv', 'plain_2025-04-15.csv']);
  assert.deepEqual(report.subdirs_ignored, ['pages']);
  assert.ok(report.warnings.includes('subdirectory ignored: pages/'));

  const jp = report.files[0]!;
  assert.deepEqual([jp.probe?.encoding, jp.probe?.encodingHow, jp.probe?.rowCount], ['cp932', 'detected', 2]);
  assert.deepEqual(jp.samples.email, ['t***@e***e.jp', 'h***@e***e.jp']);
  assert.deepEqual(jp.samples.name, ['氏*', 'H***']); // masked names
  assert.equal(jp.samples.created_at?.[0], '2025/3/1'); // dates are not personal data

  const all = JSON.stringify(report);
  assert.doesNotMatch(all, /taro@example\.jp|hanako@|one@example|two@example/); // no full addresses anywhere in the report

  // meta.md written and loadable
  const meta = loadMeta(dir);
  assert.deepEqual(meta.files.map((f) => f.name), ['members_2025-03-01.csv', 'plain_2025-04-15.csv']);
  assert.equal(meta.exported_at, '2025-04-15');
  assert.equal(meta.columns.email, 'メールアドレス');
  assert.equal(report.meta_file, path.join(dir, 'meta.md'));

  // confirm list
  const c = report.confirm.join('\n');
  assert.match(c, /members_2025-03-01\.csv: encoding detected as cp932/);
  assert.match(c, /plain_2025-04-15\.csv: email → "Customer Email Address" is a guess \(header_synonym, 0\.7\)/);
  assert.match(c, /consent_basis/);
  assert.match(c, /exported_at: guessed 2025-04-15/);
});

test('addSource (R9): suspected duplicates are commented out in the draft and listed for confirmation', async () => {
  const { ws, resources } = workspace();
  const dir = path.join(resources, 'form-eta');
  fs.cpSync(path.join(repo, 'fixtures', 'sources', 'form-eta'), dir, { recursive: true });
  fs.rmSync(path.join(dir, 'meta.md'));

  const { report } = await addSource('form-eta', { workspace: ws });
  assert.deepEqual(report.files.map((f) => [f.file, f.duplicate_of]), [
    ['responses_2025-07-01.csv', null],
    ['responses_2025-07-01 (1).csv', 'responses_2025-07-01.csv'],
  ]);
  assert.deepEqual(report.subdirs_ignored, ['pages']);
  assert.match(report.confirm.join('\n'), /responses_2025-07-01 \(1\)\.csv: suspected duplicate of responses_2025-07-01\.csv/);

  const text = fs.readFileSync(path.join(dir, 'meta.md'), 'utf8');
  assert.match(text, /# suspected duplicate of responses_2025-07-01\.csv/);
  const meta = loadMeta(dir);
  assert.deepEqual(meta.files.map((f) => f.name), ['responses_2025-07-01.csv']);
  assert.equal(meta.columns.created_at, 'Submission time');
  assert.equal(meta.columns.consent, 'Newsletter');
});

test('addSource: files with the same headers but different rows are both listed', async () => {
  const { ws, resources } = workspace();
  const dir = path.join(resources, 'shop-a');
  writeFile(dir, 'a.csv', 'Email\na@example.com\n');
  writeFile(dir, 'b.csv', 'Email\nb@example.com\n');
  const { report } = await addSource('shop-a', { workspace: ws });
  assert.deepEqual(report.files.map((f) => f.duplicate_of), [null, null]);
  assert.deepEqual(loadMeta(dir).files.map((f) => f.name), ['a.csv', 'b.csv']);
});

test('addSource: an existing meta.md is never overwritten; the draft goes to meta.draft.md', async () => {
  const { ws, resources } = workspace();
  const dir = path.join(resources, 'shop-a');
  writeFile(dir, 'a.csv', 'Email,Name\na@example.com,A\n');
  writeFile(dir, 'b.csv', 'Email,Name\nb@example.com,B\n');
  const original = '---\nsource: shop-a\nkind: product\nfiles:\n  - name: a.csv\n    encoding: utf-8\nconsent_basis: opt_in\n---\n\nmy notes\n';
  fs.writeFileSync(path.join(dir, 'meta.md'), original);

  const { report } = await addSource('shop-a', { workspace: ws });
  assert.equal(fs.readFileSync(path.join(dir, 'meta.md'), 'utf8'), original);
  assert.equal(report.meta_file, path.join(dir, 'meta.draft.md'));
  assert.equal(report.meta_is_draft, true);
  const draft = fs.readFileSync(path.join(dir, 'meta.draft.md'), 'utf8');
  assert.match(draft, /name: a\.csv/);
  assert.match(draft, /name: b\.csv/);
  assert.match(draft, /kind: product/); // the existing kind is carried over
  // running again overwrites only the draft
  await addSource('shop-a', { workspace: ws });
  assert.equal(fs.readFileSync(path.join(dir, 'meta.md'), 'utf8'), original);
});

test('addSource: a file that cannot be probed is reported, the others still are', async () => {
  const { ws, resources } = workspace();
  const dir = path.join(resources, 'shop-a');
  writeFile(dir, 'good.csv', 'Email\na@example.com\n');
  writeFile(dir, 'old.xls', 'not supported');
  writeFile(dir, 'empty.csv', '');
  const { report } = await addSource('shop-a', { workspace: ws });
  const byName = Object.fromEntries(report.files.map((f) => [f.file, f]));
  assert.ok(byName['good.csv']?.probe);
  assert.match(byName['old.xls']?.error ?? '', /unsupported file type ".xls"/);
  assert.match(byName['empty.csv']?.error ?? '', /empty/);
  assert.match(report.confirm.join('\n'), /old\.xls: could not be read/);
});

test('guessExportDate: first real YYYY-MM-DD in the name', () => {
  assert.equal(guessExportDate('members_2025-03-01.csv'), '2025-03-01');
  assert.equal(guessExportDate('export 2024-12-31 (1).csv'), '2024-12-31');
  assert.equal(guessExportDate('members_2025-02-30.csv'), null);
  assert.equal(guessExportDate('members.csv'), null);
  assert.equal(guessExportDate('20250301.csv'), null);
});

test('CLI: prints masked output only; --json is masked too; exit codes', () => {
  const { ws, resources } = workspace();
  const dir = path.join(resources, 'shop-a');
  writeFile(dir, 'members_2025-03-01.csv', 'Email,Name\ntaro@example.jp,山田太郎\n');

  const text = spawnSync('node', ['scripts/add-source.ts', 'shop-a', '--workspace', ws], { cwd: repo, encoding: 'utf8' });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /File: members_2025-03-01\.csv/);
  assert.match(text.stdout, /e\.g\. t\*\*\*@e\*\*\*e\.jp/);
  assert.match(text.stdout, /e\.g\. 山\*\*\*/);
  assert.match(text.stdout, /Please confirm:/);
  assert.doesNotMatch(text.stdout, /taro@example\.jp|山田太郎/);

  const json = spawnSync('node', ['scripts/add-source.ts', 'shop-a', '--workspace', ws, '--json'], { cwd: repo, encoding: 'utf8' });
  assert.equal(json.status, 0, json.stderr);
  assert.doesNotMatch(json.stdout, /taro@example\.jp|山田太郎/);
  assert.equal((JSON.parse(json.stdout) as { source: string }).source, 'shop-a');

  const created = spawnSync('node', ['scripts/add-source.ts', 'new-one', '--workspace', ws], { cwd: repo, encoding: 'utf8' });
  assert.equal(created.status, 0);
  assert.match(created.stdout, /Put the export files here/);

  const bad = spawnSync('node', ['scripts/add-source.ts', 'Bad_Name', '--workspace', ws], { cwd: repo, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /invalid source name/);
  const none = spawnSync('node', ['scripts/add-source.ts'], { cwd: repo, encoding: 'utf8' });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /Usage/);
});

// ---------------------------------------------------------------------------
// Review R1 rework
// ---------------------------------------------------------------------------

test('R1-1 (D28): addresses planted in Newsletter, date, locale cells, headers, file and directory names never print', async () => {
  const { ws, resources } = workspace();
  const dir = path.join(resources, 'shop-a');
  writeFile(dir, 'members_2025-03-01.csv', [
    'Email,Name,Created,Locale,Newsletter,hanako.yamada@example.jp Hanako Yamada',
    'one@example.com,Taro Yamada,leak.date@example.net,leak.locale@example.org,leak.news@example.com,x',
    'two@example.com,Jiro Sato,2025/3/2,ja,yes,y',
    'three@example.com,Saburo Ito,2025/3/3,en-US,0,z',
  ].join('\n') + '\n');
  writeFile(dir, 'leak.file@example.com.xls', 'not supported'); // email-scan:allow
  fs.mkdirSync(path.join(dir, 'leak.dir@example.com'));

  const { report } = await addSource('shop-a', { workspace: ws });
  const planted = /one@example\.com|two@example\.com|three@example\.com|leak\.[a-z]+@example|hanako\.yamada@example\.jp|Taro Yamada|Jiro Sato|Saburo Ito/;
  assert.doesNotMatch(JSON.stringify(report), planted);

  const cli = (args: string[]) => spawnSync('node', ['scripts/add-source.ts', 'shop-a', '--workspace', ws, ...args], { cwd: repo, encoding: 'utf8' });
  for (const out of [cli([]), cli(['--json'])]) {
    assert.equal(out.status, 0, out.stderr);
    assert.doesNotMatch(out.stdout + out.stderr, planted);
  }
  const f = report.files.find((x) => x.file.startsWith('members'))!;
  assert.deepEqual(f.samples.created_at, ['(unparsed)', '2025/3/2', '2025/3/3']); // an address in a date column shows no value
  assert.deepEqual(f.samples.locale, ['(other)', 'ja', 'en-US']);
  assert.deepEqual(f.samples.consent, ['(other)', 'yes', '0']);
  assert.ok(f.probe?.headers.some((h) => h.includes('h***@e***e.jp')));
  assert.match(report.confirm.join('\n'), /a header cell contains an address; the header row may be wrong/);
  // an unprobeable file name with an address is masked in the error line as well
  assert.match(report.files.map((x) => x.file).join('|'), /l\*\*\*@e\*\*\*e\.com\.xls/);
});

test('R1-1: a long mistaken header row is shortened in the output', async () => {
  const { ws, resources } = workspace();
  writeFile(path.join(resources, 'shop-a'), 'a.csv', `${'Hanako Yamada Ichiro Sato '.repeat(10)},Email\nx,u@example.com\n`);
  const { report } = await addSource('shop-a', { workspace: ws });
  assert.ok(report.files[0]!.probe!.headers[0]!.length <= 60);
});

test('R1-4: a meta.md that appears while probing is never overwritten (draft goes to meta.draft.md)', async () => {
  const { ws, resources } = workspace();
  const dir = path.join(resources, 'shop-a');
  writeFile(dir, 'a.csv', 'Email\na@example.com\n');
  const written = '---\nsource: shop-a\nkind: event\nfiles:\n  - name: a.csv\n    header_row: 1\nconsent_basis: opt_in\n---\nhand written\n';
  const orig = fs.writeFileSync;
  let raced = false;
  // Simulate another process creating meta.md right before add-source's own exclusive create.
  (fs as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = ((file: fs.PathOrFileDescriptor, data: unknown, options?: unknown) => {
    if (!raced && String(file) === path.join(dir, 'meta.md')) {
      raced = true;
      orig(file, written);
    }
    return (orig as (...a: unknown[]) => void)(file, data, options);
  }) as typeof fs.writeFileSync;
  try {
    const { report } = await addSource('shop-a', { workspace: ws });
    assert.equal(raced, true);
    assert.equal(report.meta_is_draft, true);
    assert.equal(report.meta_file, path.join(dir, 'meta.draft.md'));
  } finally {
    (fs as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = orig;
  }
  assert.equal(fs.readFileSync(path.join(dir, 'meta.md'), 'utf8'), written);
  assert.match(fs.readFileSync(path.join(dir, 'meta.draft.md'), 'utf8'), /kind: event/); // the new meta.md's settings are in the draft
});

test('R1-5: the draft keeps every per-file setting and the explicit settings of an existing meta.md', async () => {
  const { ws, resources } = workspace();
  const dir = path.join(resources, 'shop-a');
  writeFile(dir, 'pipe.txt', 'Exported\nignored,row\nEmail|Name\na@example.com|A\n');
  await writeXlsx(path.join(dir, 'book.xlsx'), [['Title'], ['Email', 'Name'], ['b@example.com', 'B']], 'People');
  await writeSqlite(path.join(dir, 'app.db'), 'people', ['mail'], [['c@example.com']]);
  writeFile(dir, 'new_2025-05-05.csv', 'Email\nd@example.com\n'); // not in the existing meta
  const original = [
    '---', 'source: shop-a', 'kind: product', 'label: Shop A', 'files:',
    '  - name: pipe.txt', '    encoding: utf-8', '    header_row: 3', '    delimiter: "|"',
    '  - name: book.xlsx', '    sheet: People', '    header_row: 2',
    '  - name: app.db', '    query: "select mail as email from people"',
    'columns:', '  email: Email', 'consent_values:', '  granted: ["済"]', '  denied: ["停止"]',
    'consent_basis: opt_in', 'exported_at: 2025-01-02', '---', '', 'notes', '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'meta.md'), original);

  const { report } = await addSource('shop-a', { workspace: ws });
  assert.equal(report.meta_is_draft, true);
  assert.equal(fs.readFileSync(path.join(dir, 'meta.md'), 'utf8'), original);
  assert.deepEqual(report.files.map((f) => f.error), [null, null, null, null]); // nothing failed to probe

  // The draft, used as a meta.md, loads and keeps every setting.
  const copy = path.join(tmpDir(), 'shop-a');
  fs.cpSync(dir, copy, { recursive: true });
  fs.renameSync(path.join(copy, 'meta.draft.md'), path.join(copy, 'meta.md'));
  const meta = loadMeta(copy);
  const byName = Object.fromEntries(meta.files.map((f) => [f.name, f]));
  assert.deepEqual(byName['pipe.txt'], { name: 'pipe.txt', encoding: 'utf-8', header_row: 3, delimiter: '|' });
  assert.deepEqual(byName['book.xlsx'], { name: 'book.xlsx', encoding: 'auto', header_row: 2, sheet: 'People' });
  assert.deepEqual(byName['app.db'], { name: 'app.db', encoding: 'auto', header_row: 1, query: 'select mail as email from people' });
  assert.ok(byName['new_2025-05-05.csv']); // the new file is added with defaults
  assert.equal(meta.kind, 'product');
  assert.equal(meta.label, 'Shop A');
  assert.equal(meta.consent_basis, 'opt_in');
  assert.equal(meta.exported_at, '2025-01-02');
  assert.deepEqual(meta.consent_values, { granted: ['済'], denied: ['停止'] });
  assert.equal(meta.columns.email, 'Email');
});

test('R1-7: add-source decodes into <workspace>/output/staging/_probe-<pid>/, never the OS temp dir, and cleans up', async () => {
  const { ws, resources } = workspace();
  const layout = workspaceLayout(ws);
  const dir = path.join(resources, 'shop-a');
  writeFile(dir, 'cp.csv', SJIS.mailAddress, ',', SJIS.shimei, '\na@example.com,x\n');
  writeFile(dir, 'cp2.csv', SJIS.mailAddress, ',', SJIS.shimei, '\nb@example.com,y\n');
  const decodedWrites: string[] = [];
  const mkdtemps: string[] = [];
  const origWrite = fs.writeFileSync;
  const origMk = fs.mkdtempSync;
  (fs as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (String(file).endsWith('.utf8.txt')) decodedWrites.push(String(file));
    return (origWrite as (...a: unknown[]) => void)(file, ...rest);
  }) as typeof fs.writeFileSync;
  (fs as { mkdtempSync: typeof fs.mkdtempSync }).mkdtempSync = ((prefix: string, ...rest: unknown[]) => {
    mkdtemps.push(prefix);
    return (origMk as (...a: unknown[]) => string)(prefix, ...rest);
  }) as typeof fs.mkdtempSync;
  try {
    await addSource('shop-a', { workspace: ws });
  } finally {
    (fs as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = origWrite;
    (fs as { mkdtempSync: typeof fs.mkdtempSync }).mkdtempSync = origMk;
  }
  assert.ok(decodedWrites.length >= 2);
  assert.ok(decodedWrites.every((p) => p.startsWith(path.join(layout.staging, '_probe-'))), decodedWrites.join(', '));
  assert.deepEqual(mkdtemps.filter((p) => p.includes('mail-decoded')), []);
  assert.deepEqual(fs.readdirSync(layout.staging), []); // removed afterwards
});

test('R1-8: invalid dates in file names are ignored; D25 asks only about non-UTF-8 or ambiguous encodings', async () => {
  assert.equal(guessExportDate('export-2025-13-01.csv'), null);
  assert.equal(guessExportDate('export-2025-00-10.csv'), null);
  assert.equal(guessExportDate('export-2025-02-29.csv'), null);
  assert.equal(guessExportDate('export-2024-02-29.csv'), '2024-02-29');
  const { ws, resources } = workspace();
  const dir = path.join(resources, 'shop-a');
  writeFile(dir, 'export-2025-13-01.csv', 'Email\na@example.com\n'); // plain UTF-8, no BOM
  writeFile(dir, 'bom.csv', [0xef, 0xbb, 0xbf], 'Email\nb@example.com\n');
  const { report } = await addSource('shop-a', { workspace: ws });
  const plain = report.files.find((f) => f.file === 'export-2025-13-01.csv');
  assert.equal(plain?.probe?.encodingHow, 'detected');
  assert.equal(plain?.probe?.encoding, 'utf-8');
  assert.doesNotMatch(report.confirm.join('\n'), /encoding detected/); // reported, but not asked about
  assert.doesNotMatch(report.confirm.join('\n'), /exported_at/);
  assert.equal(loadMeta(dir).exported_at, null);
});

test('R1-9 (D26): add-source holds the workspace lock; a held lock stops it with a precondition error', async () => {
  const { ws, resources } = workspace();
  writeFile(path.join(resources, 'shop-a'), 'a.csv', 'Email\na@example.com\n');
  await withWorkspaceLock(ws, 'clean-and-merge', async () => {
    await assert.rejects(addSource('shop-a', { workspace: ws }), /in use by "clean-and-merge"/);
    const r = spawnSync('node', ['scripts/add-source.ts', 'shop-a', '--workspace', ws], { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 2);
  });
  assert.ok(!fs.existsSync(path.join(ws, '.lock')));
  await addSource('shop-a', { workspace: ws });
  assert.ok(!fs.existsSync(path.join(ws, '.lock'))); // released afterwards
  // two at once: exactly one wins
  fs.rmSync(path.join(resources, 'shop-a', 'meta.md'));
  const results = await Promise.allSettled([addSource('shop-a', { workspace: ws }), addSource('shop-a', { workspace: ws })]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.match(String((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason), /in use/);
});
