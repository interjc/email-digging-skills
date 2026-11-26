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
async function run(w: Ws, opts: { sources?: string[]; overrides?: Overrides; config?: PipelineConfig } = {}): Promise<{ stats: MergeStats; warnings: string[]; results: SourceStageResult[]; metas: SourceMeta[] }> {
  const overrides = opts.overrides ?? loadOverrides(w.layout.overrides);
  const names = opts.sources ?? sourceNames(w.layout);
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

test('partial run (--source): other sources keep their rows; sources gone from resources/ only warn', async () => {
  const w = fixtureWorkspace();
  await run(w);
  const before = snapshot(w.db);
  const { stats } = await run(w, { sources: ['shop-alpha'] });
  assert.deepEqual(snapshot(w.db).contact_sources, before.contact_sources);
  assert.deepEqual(snapshot(w.db).contacts, before.contacts);
  assert.equal(stats.contacts_total, expected.contacts_total);
  assert.deepEqual(stats.overlap, expected.overlap);

  fs.rmSync(path.join(w.layout.resources, 'event-beta'), { recursive: true });
  const { warnings, stats: s2 } = await run(w);
  assert.ok(warnings.some((m) => m.includes('"event-beta" is in the database but no longer in resources/')));
  assert.equal(Number(get(w.db, "SELECT COUNT(*) AS n FROM contact_sources WHERE source = 'event-beta'")?.n) > 0, true);
  assert.equal(s2.contacts_orphaned, 0);
  w.db.close();
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
