import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { MergeStats, Overrides, PipelineConfig, SourceMeta, SourceStageResult } from './types.ts';
import { openDb, migrate } from './db.ts';
import { loadMeta } from './meta.ts';
import { loadOverrides } from './overrides.ts';
import { stageSource } from './stage.ts';
import { workspaceLayout, layoutDirs } from './paths.ts';
import type { WorkspaceLayout } from './paths.ts';
import { mergeStaged, readStagedRows, startRun } from './merge.ts';
import { countsAsOptIn, fileNameDate, fileRanks, resolvePriority } from './priority.ts';

const repo = path.resolve(import.meta.dirname, '..', '..');
const fixtures = path.join(repo, 'fixtures');
const expected = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8')) as {
  contacts_total: number;
  cross_source_dups: number;
  overlap: Array<{ a: string; b: string; contacts: number }>;
};

const CONFIG: PipelineConfig = {
  workspace: '',
  sources: { priority: [] },
  consent: { opt_in_bases: ['opt_in'], opt_in_sources: [] },
  masking: { keep_domain: true },
  backups: { keep: 20 },
};

interface Ws {
  layout: WorkspaceLayout;
  db: DatabaseSync;
}

/** Temp workspace with the fixture sources and overrides copied in and a migrated database. */
function fixtureWorkspace(): Ws {
  const ws = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 't7-merge-')), 'ws');
  const layout = workspaceLayout(ws);
  for (const d of layoutDirs(layout)) fs.mkdirSync(d, { recursive: true });
  fs.cpSync(path.join(fixtures, 'sources'), layout.resources, { recursive: true });
  fs.cpSync(path.join(fixtures, 'overrides'), layout.overrides, { recursive: true });
  const db = openDb(layout.dbPath);
  migrate(db, path.join(repo, 'schema', 'migrations'));
  return { layout, db };
}

function sourceNames(layout: WorkspaceLayout): string[] {
  return fs.readdirSync(layout.resources).filter((n) => fs.existsSync(path.join(layout.resources, n, 'meta.md'))).sort();
}

let runCounter = 0;

/** Stage the given sources (default all) and merge them, like clean-and-merge does. */
async function run(w: Ws, opts: { overrides?: Overrides; config?: PipelineConfig } = {}): Promise<{ stats: MergeStats; warnings: string[]; results: SourceStageResult[]; metas: SourceMeta[] }> {
  const overrides = opts.overrides ?? loadOverrides(w.layout.overrides);
  const names = sourceNames(w.layout); // D30: every merge gets every source with meta.md
  const metas = names.map((n) => loadMeta(path.join(w.layout.resources, n)));
  const results: SourceStageResult[] = [];
  for (const m of metas) results.push(await stageSource(m, { stagingDir: w.layout.staging, overrides }));
  const runId = `run-${++runCounter}`;
  const now = `2026-11-26T10:00:${String(runCounter % 60).padStart(2, '0')}.000Z`;
  startRun(w.db, runId, 'test', now);
  const warnings: string[] = [];
  const stats = await mergeStaged(results, {
    db: w.db, config: opts.config ?? CONFIG, metas, overrides, runId, now,
    resourceSources: sourceNames(w.layout), onWarning: (m) => warnings.push(m),
  });
  return { stats, warnings, results, metas };
}

const all = (db: DatabaseSync, sql: string, ...params: Array<string | number | null>) =>
  db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
const get = (db: DatabaseSync, sql: string, ...params: Array<string | number | null>) =>
  db.prepare(sql).get(...params) as Record<string, unknown> | undefined;

function snapshot(db: DatabaseSync) {
  return {
    contacts: all(db, 'SELECT * FROM contacts ORDER BY id'),
    contact_sources: all(db, 'SELECT * FROM contact_sources ORDER BY contact_id, source'),
    consents: all(db, 'SELECT * FROM consents ORDER BY contact_id, source'),
    sources: all(db, 'SELECT * FROM sources ORDER BY name'),
    suppressions: all(db, 'SELECT * FROM suppressions ORDER BY id'),
  };
}

function consentOf(db: DatabaseSync, email: string, source: string) {
  return get(db, 'SELECT k.status, k.evidence, k.recorded_at FROM consents k JOIN contacts c ON c.id = k.contact_id WHERE c.email = ? AND k.source = ?', email, source);
}

const inView = (db: DatabaseSync, view: string, email: string) => get(db, `SELECT 1 AS x FROM ${view} WHERE email = ?`, email) !== undefined;

// ---------------------------------------------------------------------------

test('priority: config list first, then exported_at desc (nulls last), then name', () => {
  const order = resolvePriority(
    [
      { name: 'b', exported_at: '2024-01-01' }, { name: 'a', exported_at: '2024-01-01' },
      { name: 'z', exported_at: null }, { name: 'n', exported_at: '2025-05-05' }, { name: 'c', exported_at: null },
      { name: 'pinned', exported_at: '2000-01-01' },
    ],
    ['pinned', 'missing', 'z'],
  );
  assert.deepEqual(order, ['pinned', 'z', 'n', 'a', 'b', 'c']);
  assert.equal(countsAsOptIn('x', 'opt_in', CONFIG), true);
  assert.equal(countsAsOptIn('x', 'unknown', CONFIG), false);
  assert.equal(countsAsOptIn('x', 'unknown', { consent: { opt_in_bases: [], opt_in_sources: ['x'] } }), true);
});

test('fileRanks: dated files by date above undated ones; ties and undated by meta.files order', () => {
  assert.equal(fileNameDate('a_2025-02-30.csv'), null);
  const r = fileRanks(['b_2025-09-01.csv', 'plain.csv', 'a_2025-03-01.csv', 'other.csv', 'c_2025-09-01.csv']);
  const order = [...r.entries()].sort((x, y) => x[1] - y[1]).map((e) => e[0]);
  assert.deepEqual(order, ['plain.csv', 'other.csv', 'a_2025-03-01.csv', 'b_2025-09-01.csv', 'c_2025-09-01.csv']);
});

test('merge: totals match fixtures/expected.json after overrides', async () => {
  const w = fixtureWorkspace();
  const { stats, warnings } = await run(w);
  assert.equal(stats.contacts_total, expected.contacts_total);
  assert.equal(stats.contacts_new, expected.contacts_total);
  assert.equal(stats.cross_source_dups, expected.cross_source_dups);
  assert.deepEqual(stats.overlap, expected.overlap);
  assert.equal(stats.contacts_orphaned, 0);
  // typo: one original rewritten (accept) + one kept (reject); suppressions: rows newly inserted
  assert.deepEqual(stats.overrides_applied, { typo: 2, suppressions: 1, consents: 0, exclude: 1 });
  assert.deepEqual(warnings, []);
  // D8 with no configured priority: exported_at desc.
  assert.deepEqual(stats.priority_order, ['shop-alpha', 'app-gamma', 'form-eta', 'export-epsilon', 'zeta-signup', 'cn-delta', 'event-beta']);
  const src = all(w.db, 'SELECT name, priority, counts_as_opt_in FROM sources ORDER BY priority');
  assert.deepEqual(src.map((s) => [s.name, s.counts_as_opt_in]), [
    ['shop-alpha', 1], ['app-gamma', 1], ['form-eta', 0], ['export-epsilon', 0], ['zeta-signup', 0], ['cn-delta', 0], ['event-beta', 0],
  ]);
  // imports: one row per file, encoding n/a for xlsx / sqlite (D23).
  const imports = all(w.db, 'SELECT source, file, encoding FROM imports ORDER BY source, file');
  assert.equal(imports.length, 10);
  assert.equal(imports.find((i) => i.file === 'app_2025-08-01.db')?.encoding, 'n/a');
  assert.equal(imports.find((i) => i.file === 'users_2024-12-31.csv')?.encoding, 'gb18030');
  // typo accepted: the corrected address is the contact; rejected typo stays valid.
  const accepted = get(w.db, 'SELECT email_status, flags FROM contacts WHERE email = ?', 'hiroshi.tanaka@example.com');
  assert.equal(accepted?.email_status, 'valid');
  assert.ok(String(accepted?.flags).includes('typo_accepted'));
  assert.equal(get(w.db, 'SELECT 1 AS x FROM contacts WHERE email = ?', 'hiroshi.tanaka@example.con'), undefined);
  const suspect = get(w.db, 'SELECT email_status, suggested_email FROM contacts WHERE email = ?', 'yuta.kobayashi@example.con');
  assert.deepEqual({ ...suspect }, { email_status: 'typo_suspect', suggested_email: 'yuta.kobayashi@example.com' });
  // excluded test account never becomes a contact; it is in rejected_rows.
  assert.equal(get(w.db, 'SELECT 1 AS x FROM contacts WHERE email = ?', 'qa-test@example.com'), undefined);
  assert.ok(Number(get(w.db, "SELECT COUNT(*) AS n FROM rejected_rows WHERE reason = 'excluded_by_override'")?.n) >= 1);
  w.db.close();
});

test('merge: representative row = newest file, contact fields by source priority, first_seen_at = min created_at', async () => {
  const w = fixtureWorkspace();
  await run(w);
  const cs = get(w.db, `SELECT cs.raw_email, cs.files, cs.occurrences, cs.first_seen_at, cs.raw_fields FROM contact_sources cs
    JOIN contacts c ON c.id = cs.contact_id WHERE c.email = ? AND cs.source = 'shop-alpha'`, 'taro.suzuki@example.jp');
  // The 2025-09-01 export holds the full-width form of the address.
  assert.equal(cs?.raw_email, 'ｔａｒｏ．ｓｕｚｕｋｉ＠ｅｘａｍｐｌｅ．ｊｐ');
  assert.equal(cs?.files, JSON.stringify(['members_2025-03-01.csv', 'members_2025-09-01.csv']));
  assert.equal(cs?.occurrences, 2);
  assert.equal(cs?.first_seen_at, '2025-01-10');
  assert.equal(JSON.parse(String(cs?.raw_fields)).会員ID, 'SA001');
  const c = get(w.db, 'SELECT name, flags, first_seen_at FROM contacts WHERE email = ?', 'taro.suzuki@example.jp');
  assert.equal(c?.name, '鈴木 太郎');
  // The address is also in event-beta (2023): first_seen_at is the minimum over every source.
  const min = get(w.db, `SELECT MIN(cs.first_seen_at) AS m FROM contact_sources cs JOIN contacts c ON c.id = cs.contact_id WHERE c.email = ?`, 'taro.suzuki@example.jp');
  assert.ok(String(min?.m) < '2025-01-10');
  assert.equal(c?.first_seen_at, min?.m);
  assert.ok(String(c?.flags).includes('width_normalized'));
  // flags stay sorted JSON arrays.
  for (const row of all(w.db, 'SELECT flags FROM contacts')) {
    const flags = JSON.parse(String(row.flags)) as string[];
    assert.deepEqual(flags, [...flags].sort());
  }
  w.db.close();
});

test('merge: re-run with the same inputs keeps contacts (ids), contact_sources and consents identical', async () => {
  const w = fixtureWorkspace();
  await run(w);
  const first = snapshot(w.db);
  const { stats } = await run(w);
  const second = snapshot(w.db);
  assert.deepEqual(second, first);
  assert.equal(stats.contacts_new, 0);
  assert.equal(stats.contacts_total, expected.contacts_total);
  assert.deepEqual(stats.overrides_applied, { typo: 2, suppressions: 0, consents: 0, exclude: 1 }, 'nothing newly inserted');
  assert.equal(Number(get(w.db, 'SELECT COUNT(*) AS n FROM suppressions')?.n), 1);
  assert.equal(Number(get(w.db, 'SELECT COUNT(*) AS n FROM imports')?.n), 20);
  // rejected_rows are replaced, not accumulated.
  const rejected = all(w.db, 'SELECT DISTINCT run_id FROM rejected_rows');
  assert.equal(rejected.length, 1);
  w.db.close();
});

test('consent rules: newest export wins, denied wins inside one file, evidence and recorded_at', async () => {
  const w = fixtureWorkspace();
  await run(w);
  // granted in 2025-03-01, denied in 2025-09-01 → denied
  const taro = consentOf(w.db, 'taro.suzuki@example.jp', 'shop-alpha');
  assert.equal(taro?.status, 'denied');
  assert.deepEqual(JSON.parse(String(taro?.evidence)), { column: 'メルマガ配信', value: '配信しない', file: 'members_2025-09-01.csv', row_number: 1 });
  assert.equal(taro?.recorded_at, '2025-01-10');
  // denied in 2025-03-01, granted in 2025-09-01 → granted
  assert.equal(consentOf(w.db, 'yuki.takahashi@example.jp', 'shop-alpha')?.status, 'granted');
  // two rows in 2025-09-01 (granted, then denied) → denied
  const kenji = consentOf(w.db, 'kenji.ito@example.jp', 'shop-alpha');
  assert.equal(kenji?.status, 'denied');
  assert.equal(JSON.parse(String(kenji?.evidence)).row_number, 4);
  // empty consent cell only → unknown without evidence
  const ren = consentOf(w.db, 'ren.nakamura@example.jp', 'shop-alpha');
  assert.deepEqual({ ...ren }, { status: 'unknown', evidence: null, recorded_at: null });
  assert.equal(inView(w.db, 'v_not_blocked', 'taro.suzuki@example.jp'), false);
  assert.equal(inView(w.db, 'v_sendable_strict', 'yuki.takahashi@example.jp'), true);
  w.db.close();
});

test('consent overrides: applied with override evidence, duplicates warn (last wins), unknown pairs warn', async () => {
  const w = fixtureWorkspace();
  const base = loadOverrides(w.layout.overrides);
  const overrides: Overrides = {
    ...base,
    consents: [
      { email: 'aki.morita@example.jp', source: 'shop-alpha', status: 'granted', note: 'first' },
      { email: 'Aki.Morita@example.jp', source: 'shop-alpha', status: 'denied', note: 'Customer asked by phone' },
      { email: 'nobody@example.org', source: 'shop-alpha', status: 'granted' },
      { email: 'taro.suzuki@example.jp', source: 'no-such-source', status: 'granted' },
    ],
  };
  const { stats, warnings } = await run(w, { overrides });
  assert.equal(stats.overrides_applied.consents, 1);
  const aki = consentOf(w.db, 'aki.morita@example.jp', 'shop-alpha');
  assert.equal(aki?.status, 'denied');
  assert.deepEqual(JSON.parse(String(aki?.evidence)), { override: 'Customer asked by phone' });
  assert.equal(inView(w.db, 'v_not_blocked', 'aki.morita@example.jp'), false);
  assert.equal(warnings.length, 3, warnings.join('\n'));
  assert.ok(warnings.some((m) => m.includes('several entries')));
  assert.ok(warnings.some((m) => m.includes('n***@e***e.org')));
  assert.ok(warnings.every((m) => !/[a-z]+@example/.test(m)), 'warnings are masked');
  // stable on re-run (recorded_at of the override is kept)
  const before = snapshot(w.db);
  await run(w, { overrides });
  assert.deepEqual(snapshot(w.db), before);
  w.db.close();
});

test('orphans: removing a file orphans its exclusive addresses; restoring it clears orphaned_at with the same id', async () => {
  const w = fixtureWorkspace();
  await run(w);
  const dir = path.join(w.layout.resources, 'shop-alpha');
  const removed = 'members_2025-03-01.csv';
  const rows = await readStagedRows(path.join(w.layout.staging, 'shop-alpha'));
  const inRemoved = new Set(rows.filter((r) => r.file === removed).map((r) => r.email));
  const inKept = new Set(rows.filter((r) => r.file !== removed).map((r) => r.email));
  const otherSources = new Set<string>();
  for (const s of sourceNames(w.layout).filter((n) => n !== 'shop-alpha')) {
    for (const r of await readStagedRows(path.join(w.layout.staging, s))) otherSources.add(r.email);
  }
  const exclusive = [...inRemoved].filter((e) => !inKept.has(e) && !otherSources.has(e)).sort();
  assert.ok(exclusive.length >= 3, `exclusive: ${exclusive.length}`);
  const ids = new Map(exclusive.map((e) => [e, Number(get(w.db, 'SELECT id FROM contacts WHERE email = ?', e)?.id)]));
  const notBlockedBefore = exclusive.filter((e) => inView(w.db, 'v_not_blocked', e));
  assert.ok(notBlockedBefore.length > 0);

  // remove the file and its meta.md entry
  const metaPath = path.join(dir, 'meta.md');
  const metaText = fs.readFileSync(metaPath, 'utf8');
  const hidden = path.join(path.dirname(w.layout.resources), `${removed}.away`);
  fs.renameSync(path.join(dir, removed), hidden);
  fs.writeFileSync(metaPath, metaText.replace(/  - name: members_2025-03-01\.csv\n    encoding: cp932\n    header_row: 1\n/, ''));
  assert.notEqual(fs.readFileSync(metaPath, 'utf8'), metaText);

  const { stats } = await run(w);
  assert.equal(stats.contacts_orphaned, exclusive.length);
  for (const e of exclusive) {
    const c = get(w.db, 'SELECT id, orphaned_at FROM contacts WHERE email = ?', e);
    assert.equal(Number(c?.id), ids.get(e), 'contact is kept');
    assert.notEqual(c?.orphaned_at, null);
    assert.equal(inView(w.db, 'v_not_blocked', e), false);
    assert.equal(inView(w.db, 'v_sendable_strict', e), false);
  }
  assert.equal(stats.contacts_total, expected.contacts_total - exclusive.length);

  // restore
  fs.renameSync(hidden, path.join(dir, removed));
  fs.writeFileSync(metaPath, metaText);
  const again = await run(w);
  assert.equal(again.stats.contacts_orphaned, 0);
  assert.equal(again.stats.contacts_new, 0);
  for (const e of exclusive) {
    const c = get(w.db, 'SELECT id, orphaned_at FROM contacts WHERE email = ?', e);
    assert.equal(Number(c?.id), ids.get(e));
    assert.equal(c?.orphaned_at, null);
  }
  assert.deepEqual(exclusive.filter((e) => inView(w.db, 'v_not_blocked', e)), notBlockedBefore);
  w.db.close();
});

test('suppression override: the address stays a contact but leaves both sendable views', async () => {
  const w = fixtureWorkspace();
  await run(w);
  const email = 'naoki.saito@example.jp';
  assert.ok(get(w.db, 'SELECT 1 AS x FROM contacts WHERE email = ?', email));
  assert.deepEqual({ ...get(w.db, 'SELECT reason, source FROM suppressions WHERE email = ?', email) }, { reason: 'manual', source: 'override' });
  assert.equal(inView(w.db, 'v_not_blocked', email), false);
  assert.equal(inView(w.db, 'v_sendable_strict', email), false);
  // removing the override does not remove the suppression (append-only)
  const overrides = { ...loadOverrides(w.layout.overrides), suppressions: [] };
  await run(w, { overrides });
  assert.equal(inView(w.db, 'v_not_blocked', email), false);
  w.db.close();
});

test('withdrawn consent override: the source denial comes back and the contact leaves v_sendable_strict', async () => {
  const w = fixtureWorkspace();
  const base = loadOverrides(w.layout.overrides);
  const email = 'taro.suzuki@example.jp'; // shop-alpha (opt-in source) says denied in the newest export
  const grant: Overrides = { ...base, consents: [{ email, source: 'shop-alpha', status: 'granted', note: 'granted by phone' }] };
  await run(w, { overrides: grant });
  assert.equal(consentOf(w.db, email, 'shop-alpha')?.status, 'granted');
  assert.equal(inView(w.db, 'v_sendable_strict', email), true);

  await run(w, { overrides: base });
  const k = consentOf(w.db, email, 'shop-alpha');
  assert.equal(k?.status, 'denied');
  assert.equal(JSON.parse(String(k?.evidence)).file, 'members_2025-09-01.csv');
  assert.equal(inView(w.db, 'v_sendable_strict', email), false);
  assert.equal(inView(w.db, 'v_not_blocked', email), false);
  w.db.close();
});

/** Workspace with two small UTF-8 sources; `hi` is newer, so it has the higher priority (D8). */
function twoSourceWorkspace(hiRows: string[], loRows: string[]): Ws {
  const ws = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 't7-two-')), 'ws');
  const layout = workspaceLayout(ws);
  for (const d of layoutDirs(layout)) fs.mkdirSync(d, { recursive: true });
  const write = (name: string, date: string, rows: string[]) => {
    const dir = path.join(layout.resources, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `list_${date}.csv`), ['Email,Name,Locale,Newsletter', ...rows].join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'meta.md'), `---\nsource: ${name}\nkind: other\nfiles:\n  - name: list_${date}.csv\n    encoding: utf-8\nconsent_basis: unknown\nexported_at: ${date}\n---\n`);
  };
  write('src-hi', '2025-06-01', hiRows);
  write('src-lo', '2024-06-01', loRows);
  const db = openDb(layout.dbPath);
  migrate(db, path.join(repo, 'schema', 'migrations'));
  return { layout, db };
}

test('name/locale follow the surviving source when the address leaves its higher-priority source', async () => {
  const w = twoSourceWorkspace(['mika@example.org,Mika Hi,ja,', 'other@example.org,Other,en,'], ['mika@example.org,Mika Lo,en-US,']);
  const { stats } = await run(w);
  assert.deepEqual(stats.priority_order, ['src-hi', 'src-lo']);
  const before = get(w.db, 'SELECT id, name, locale FROM contacts WHERE email = ?', 'mika@example.org');
  assert.deepEqual([before?.name, before?.locale], ['Mika Hi', 'ja']);

  const hi = path.join(w.layout.resources, 'src-hi', 'list_2025-06-01.csv');
  fs.writeFileSync(hi, 'Email,Name,Locale,Newsletter\nother@example.org,Other,en,\n');
  await run(w);
  const after = get(w.db, 'SELECT id, name, locale, orphaned_at FROM contacts WHERE email = ?', 'mika@example.org');
  assert.deepEqual([after?.id, after?.name, after?.locale, after?.orphaned_at], [before?.id, 'Mika Lo', 'en-US', null]);
  assert.deepEqual(all(w.db, `SELECT cs.source FROM contact_sources cs JOIN contacts c ON c.id = cs.contact_id WHERE c.email = 'mika@example.org'`).map((r) => r.source), ['src-lo']);
  w.db.close();
});

test('a source gone from resources/ keeps its rows with a warning; consent overrides for it are ignored', async () => {
  const w = fixtureWorkspace();
  await run(w);
  fs.rmSync(path.join(w.layout.resources, 'event-beta'), { recursive: true });
  const overrides: Overrides = { ...loadOverrides(w.layout.overrides), consents: [{ email: 'taro.suzuki@example.jp', source: 'event-beta', status: 'granted' }] };
  const { warnings, stats } = await run(w, { overrides });
  assert.ok(warnings.some((m) => m.includes('"event-beta" is in the database but no longer in resources/')));
  assert.ok(warnings.some((m) => m.includes('source "event-beta" is not merged') && m.includes('t***@e***e.jp')));
  assert.equal(stats.overrides_applied.consents, 0);
  assert.ok(Number(get(w.db, "SELECT COUNT(*) AS n FROM contact_sources WHERE source = 'event-beta'")?.n) > 0);
  assert.equal(consentOf(w.db, 'taro.suzuki@example.jp', 'event-beta')?.status, 'unknown');
  assert.equal(stats.contacts_orphaned, 0);
  w.db.close();
});

test('a 150 000-row group for one address merges (no argument spreads over rows); denied in the newest file wins', async () => {
  const ws = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 't7-big-')), 'ws');
  const layout = workspaceLayout(ws);
  for (const d of layoutDirs(layout)) fs.mkdirSync(d, { recursive: true });
  const dir = path.join(layout.resources, 'big');
  fs.mkdirSync(dir, { recursive: true });
  const N = 150_000;
  const lines = ['Email,Name,Newsletter'];
  for (let i = 0; i < N - 1; i++) lines.push('bulk@example.com,Bulk,yes');
  lines.push('bulk@example.com,Bulk,no');
  fs.writeFileSync(path.join(dir, 'big_2025-01-01.csv'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'meta.md'), '---\nsource: big\nkind: other\nfiles:\n  - name: big_2025-01-01.csv\n    encoding: utf-8\n---\n');
  const db = openDb(layout.dbPath);
  migrate(db, path.join(repo, 'schema', 'migrations'));
  const w: Ws = { layout, db };
  const { stats } = await run(w);
  assert.equal(stats.contacts_total, 1);
  const cs = get(db, 'SELECT occurrences, raw_fields FROM contact_sources');
  assert.equal(cs?.occurrences, N);
  // D36: 149 999 identical older rows collapse into one stacked entry; the cell stays small.
  assert.equal((JSON.parse(String(cs?.raw_fields))._merged_rows as unknown[]).length, 1);
  assert.ok(String(cs?.raw_fields).length < 500);
  const k = consentOf(db, 'bulk@example.com', 'big');
  assert.equal(k?.status, 'denied');
  assert.equal(JSON.parse(String(k?.evidence)).row_number, N);
  db.close();
});

test('merge failure rolls back the whole transaction', async () => {
  const w = fixtureWorkspace();
  await run(w);
  const before = snapshot(w.db);
  const overrides = loadOverrides(w.layout.overrides);
  const metas = [loadMeta(path.join(w.layout.resources, 'shop-alpha'))];
  const results = [await stageSource(metas[0] as SourceMeta, { stagingDir: w.layout.staging, overrides })];
  // run_id without a runs row → the rejected_rows insert violates the foreign key, after other writes.
  await assert.rejects(mergeStaged(results, { db: w.db, config: CONFIG, metas, overrides, runId: 'no-such-run', now: '2026-11-27T00:00:00.000Z' }));
  assert.deepEqual(snapshot(w.db), before);
  w.db.close();
});

test('typo counter: a reject counts only when its address is among the original (pre-override) staged addresses', async () => {
  const w = fixtureWorkspace();
  const base = loadOverrides(w.layout.overrides);
  const overrides: Overrides = {
    ...base,
    typo: [
      ...base.typo,
      { email: 'yuta.kobayashi@example.con', action: 'accept', suggested: 'yuta.kobayashi@example.com' },
      // present only as the accepted correction above, never as an original value
      { email: 'yuta.kobayashi@example.com', action: 'reject' },
    ],
  };
  const { stats, warnings } = await run(w, { overrides });
  assert.ok(get(w.db, 'SELECT 1 AS x FROM contacts WHERE email = ?', 'yuta.kobayashi@example.com'), 'the correction is a contact');
  // hiroshi (accept) + saki (reject) + yuta (accept); the reject of the corrected address does not count
  assert.equal(stats.overrides_applied.typo, 3);
  assert.ok(warnings.some((m) => m.includes('y***@e***e.com (reject) matched no address')), warnings.join('\n'));
  w.db.close();
});

/** One UTF-8 source `users-d36` with the given files ({name: csv text}); meta.md lists them in this order. */
function d36Workspace(files: Record<string, string>, columns: string): Ws {
  const ws = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 't7-d36-')), 'ws');
  const layout = workspaceLayout(ws);
  for (const d of layoutDirs(layout)) fs.mkdirSync(d, { recursive: true });
  const dir = path.join(layout.resources, 'users-d36');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  const list = Object.keys(files).map((n) => `  - name: ${n}\n    encoding: utf-8\n`).join('');
  fs.writeFileSync(path.join(dir, 'meta.md'), `---\nsource: users-d36\nkind: product\nfiles:\n${list}columns:\n${columns}consent_basis: opt_in\nexported_at: 2025-06-01\n---\n`);
  const db = openDb(layout.dbPath);
  migrate(db, path.join(repo, 'schema', 'migrations'));
  return { layout, db };
}

function d36Source(w: Ws, email: string) {
  const cs = get(w.db, `SELECT cs.occurrences, cs.first_seen_at, cs.last_seen_at, cs.raw_fields FROM contact_sources cs
    JOIN contacts c ON c.id = cs.contact_id WHERE c.email = ?`, email);
  return { occurrences: cs?.occurrences, first_seen_at: cs?.first_seen_at, last_seen_at: cs?.last_seen_at, raw: JSON.parse(String(cs?.raw_fields)) as Record<string, unknown> };
}

type Stacked = Array<{ file: string; row_number: number; fields: Record<string, unknown> }>;

test('D36: same address under two user ids in one source: the latest row wins, empty values are filled, other rows are stacked', async () => {
  const w = d36Workspace({
    'users_2025-06-01.csv': [
      'User ID,Email,Name,Lang,Created,Last Used,Newsletter,Plan',
      'U3,dup@example.org,,,2025-03-01,,yes,paid',
      'U1,dup@example.org,Old Name,ja,2025-01-01,,no,free',
      'U2,other@example.org,Other,en,2025-01-02,,yes,free',
      'U4,same@example.org,Same,en,2025-02-01,,yes,free',
      'U4,same@example.org,Same,en,2025-02-01,,yes,free',
      // An old account still in use beats a newer registration that was never used (activity first).
      'U5,active@example.org,Active Old,en,2024-01-01,2025-05-20,yes,paid',
      'U6,active@example.org,Active New,en,2025-04-01,,yes,free',
      // file / row_number columns of the source must not overwrite the stacking metadata.
      'U7,meta@example.org,Meta,en,2025-01-01,,yes,free',
      'U8,meta@example.org,Meta,en,2025-02-01,,yes,paid',
    ].join('\n') + '\n',
  }, '  email: Email\n  name: Name\n  locale: Lang\n  created_at: Created\n  last_seen_at: Last Used\n  consent: Newsletter\n');
  const { stats } = await run(w);
  // dup, same, active, meta have two rows each; same is identical, so it is not stacked.
  assert.deepEqual(stats.same_address_rows, { groups: 4, stacked: 3, capped: 0, max_rows: 2, by_source: [{ source: 'users-d36', groups: 4, stacked: 3 }] });

  const dup = d36Source(w, 'dup@example.org');
  assert.equal(dup.occurrences, 2);
  assert.equal(dup.first_seen_at, '2025-01-01');
  // U3 registered later (created 2025-03-01), so it is the representative even though it comes first.
  assert.equal(dup.raw['User ID'], 'U3');
  assert.equal(dup.raw.Plan, 'paid');
  const stacked = dup.raw._merged_rows as Stacked;
  assert.equal(stacked.length, 1);
  assert.equal(stacked[0]?.file, 'users_2025-06-01.csv');
  assert.equal(typeof stacked[0]?.row_number, 'number');
  assert.deepEqual(stacked[0]?.fields, { 'User ID': 'U1', Name: 'Old Name', Lang: 'ja', Created: '2025-01-01', Newsletter: 'no', Plan: 'free' });
  // The latest row has no name and no locale: the older row fills both.
  const c = get(w.db, 'SELECT name, locale FROM contacts WHERE email = ?', 'dup@example.org');
  assert.deepEqual([c?.name, c?.locale], ['Old Name', 'ja']);
  // Consent (D15 kept): inside one file a denial wins over the later user's grant; evidence names that row.
  const consent = get(w.db, `SELECT k.status, k.evidence FROM consents k JOIN contacts c ON c.id = k.contact_id WHERE c.email = ?`, 'dup@example.org');
  assert.equal(consent?.status, 'denied');
  assert.equal(JSON.parse(String(consent?.evidence)).row_number, stacked[0]?.row_number);

  const active = d36Source(w, 'active@example.org');
  assert.equal(active.raw['User ID'], 'U5');
  assert.equal(active.last_seen_at, '2025-05-20');
  assert.equal(get(w.db, 'SELECT name FROM contacts WHERE email = ?', 'active@example.org')?.name, 'Active Old');

  // Identical duplicate rows add nothing to stack.
  const same = d36Source(w, 'same@example.org');
  assert.equal(same.occurrences, 2);
  assert.equal('_merged_rows' in same.raw, false);

  // Re-running is idempotent.
  const first = snapshot(w.db);
  await run(w);
  assert.deepEqual(snapshot(w.db), first);
  w.db.close();
});

test('D36: an older file with later activity loses to the newest file; stacking is capped and collapsed; a reserved column disables it', async () => {
  const header = 'User ID,Email,Name,Created,Last Login';
  const many = Array.from({ length: 30 }, (_, i) => `M${String(i).padStart(2, '0')},shared@example.org,Shared,2025-01-01,2025-02-${String(i % 28 + 1).padStart(2, '0')}`);
  const w = d36Workspace({
    'users_2025-01-01.csv': [header, 'A1,moved@example.org,From Old,2024-01-01,2025-12-31'].join('\n') + '\n',
    'users_2025-06-01.csv': [header, 'A2,moved@example.org,From New,2025-03-01,', ...many,
      'S1,twice@example.org,Twice,2025-01-01,2025-01-05', 'S2,twice@example.org,Twice,2025-01-01,2025-01-05', 'S3,twice@example.org,Twice,2025-01-01,2025-03-01'].join('\n') + '\n',
  }, '  email: Email\n  name: Name\n  created_at: Created\n  last_seen_at: Last Login\n');
  const { stats } = await run(w);
  assert.deepEqual([stats.same_address_rows.groups, stats.same_address_rows.capped, stats.same_address_rows.max_rows], [3, 1, 30]);

  const moved = d36Source(w, 'moved@example.org');
  assert.equal(moved.raw['User ID'], 'A2', 'newest file first, even when an older file has a later activity date');
  assert.equal((moved.raw._merged_rows as Stacked)[0]?.file, 'users_2025-01-01.csv');
  assert.equal(get(w.db, 'SELECT name FROM contacts WHERE email = ?', 'moved@example.org')?.name, 'From New');

  const shared = d36Source(w, 'shared@example.org');
  assert.equal(shared.occurrences, 30);
  assert.equal((shared.raw._merged_rows as Stacked).length, 20);
  assert.equal(shared.raw._merged_rows_omitted, 9);

  // S1 and S2 differ from the representative S3 the same way except for the id: two entries, not collapsed.
  const twice = d36Source(w, 'twice@example.org');
  assert.equal(twice.raw['User ID'], 'S3');
  assert.deepEqual((twice.raw._merged_rows as Stacked).map((e) => e.fields['User ID']), ['S2', 'S1']);
  w.db.close();

  const r = d36Workspace({
    'users_2025-06-01.csv': ['Email,Name,_merged_rows', 'x@example.org,X1,kept', 'x@example.org,X2,other'].join('\n') + '\n',
  }, '  email: Email\n  name: Name\n');
  const { warnings } = await run(r);
  assert.equal(d36Source(r, 'x@example.org').raw._merged_rows, 'other');
  assert.equal(warnings.filter((m) => m.includes('_merged_rows')).length, 1);
  r.db.close();
});
