import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanAndMerge, renderSummary, SOURCE_NEEDS_DRY_RUN } from './clean-and-merge.ts';
import { openDb, migrate } from './lib/db.ts';
import { layoutDirs, workspaceLayout } from './lib/paths.ts';
import type { WorkspaceLayout } from './lib/paths.ts';

const repo = path.resolve(import.meta.dirname, '..');
const fixtures = path.join(repo, 'fixtures');
const expected = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8')) as { contacts_total: number; cross_source_dups: number };

/** Initialized workspace outside the repository with the fixtures copied in, plus an empty repo root (no config.yaml). */
function setup(): { ws: string; layout: WorkspaceLayout; root: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't7-cm-'));
  const ws = path.join(base, 'ws');
  const root = path.join(base, 'repo');
  fs.mkdirSync(root);
  const layout = workspaceLayout(ws);
  for (const d of layoutDirs(layout)) fs.mkdirSync(d, { recursive: true });
  fs.cpSync(path.join(fixtures, 'sources'), layout.resources, { recursive: true });
  fs.cpSync(path.join(fixtures, 'overrides'), layout.overrides, { recursive: true });
  const db = openDb(layout.dbPath);
  migrate(db, path.join(repo, 'schema', 'migrations'));
  db.close();
  return { ws, layout, root };
}

function unmaskedAddresses(text: string): string[] {
  const re = /[^\s@＠﹫<>"'`()[\]{}:,;|]+[@＠﹫][^\s@＠﹫<>"'`()[\]{}:,;|]+/gu;
  return (text.match(re) ?? []).filter((m) => !m.includes('*'));
}

function query(layout: WorkspaceLayout, sql: string): Array<Record<string, unknown>> {
  const db = openDb(layout.dbPath, { readonly: true });
  try {
    return (db.prepare(sql).all() as Array<Record<string, unknown>>).map((r) => ({ ...r }));
  } finally {
    db.close();
  }
}

test('clean-and-merge: full run twice → backups, runs rows, reports, identical contacts', async () => {
  const { ws, layout, root } = setup();
  fs.mkdirSync(path.join(layout.resources, 'new-source'));
  const r1 = await cleanAndMerge({ workspace: ws, repoRoot: root, now: new Date('2026-11-26T10:00:00Z') });
  assert.equal(r1.status, 'ok');
  assert.equal(r1.run_id, '20261126T100000Z');
  assert.equal(r1.report.merge?.contacts_total, expected.contacts_total);
  assert.equal(r1.report.merge?.cross_source_dups, expected.cross_source_dups);
  assert.deepEqual(r1.report.sources_without_meta, ['new-source']);
  assert.ok(r1.backup_path && fs.existsSync(r1.backup_path));
  assert.ok(fs.existsSync(path.join(layout.reports, 'latest.md')));
  const contacts1 = query(layout, 'SELECT * FROM contacts ORDER BY id');

  // same second: run ids and report names do not collide
  const r2 = await cleanAndMerge({ workspace: ws, repoRoot: root, now: new Date('2026-11-26T10:00:00Z') });
  assert.equal(r2.status, 'ok');
  assert.equal(r2.run_id, '20261126T100000Z-1');
  assert.equal(r2.report.merge?.contacts_new, 0);
  assert.deepEqual(query(layout, 'SELECT * FROM contacts ORDER BY id'), contacts1);
  const runs = query(layout, 'SELECT id, status, report_path FROM runs ORDER BY id');
  assert.deepEqual(runs.map((r) => [r.id, r.status]), [['20261126T100000Z', 'ok'], ['20261126T100000Z-1', 'ok']]);
  assert.equal(runs[1]?.report_path, r2.paths.md);
  assert.equal(fs.readdirSync(layout.backups).length, 2);
  assert.ok(!fs.existsSync(path.join(ws, '.lock')), 'lock released');

  const summary = renderSummary(r2);
  assert.match(summary, /clean-and-merge 20261126T100000Z-1: ok/);
  assert.match(summary, new RegExp(`Contacts: ${expected.contacts_total} \\(new 0`));
  assert.deepEqual(unmaskedAddresses(summary), []);
});

test('clean-and-merge --dry-run: report only, no backup, database untouched', async () => {
  const { ws, layout, root } = setup();
  const r = await cleanAndMerge({ workspace: ws, repoRoot: root, dryRun: true, now: new Date('2026-11-26T11:00:00Z') });
  assert.equal(r.status, 'dry-run');
  assert.equal(r.report.merge, null);
  assert.equal(r.backup_path, null);
  assert.equal(r.run_id, '20261126T110000Z-dry-run');
  assert.ok(fs.existsSync(r.paths.md));
  assert.equal(r.report.priority_order[0], 'shop-alpha');
  assert.equal(query(layout, 'SELECT COUNT(*) AS n FROM contacts')[0]?.n, 0);
  assert.equal(query(layout, 'SELECT COUNT(*) AS n FROM runs')[0]?.n, 0);
  assert.deepEqual(fs.readdirSync(layout.backups), []);
});

test('clean-and-merge --source: only with --dry-run (D30); unknown or meta-less sources are errors', async () => {
  const { ws, layout, root } = setup();
  fs.mkdirSync(path.join(layout.resources, 'new-source'));
  await assert.rejects(cleanAndMerge({ workspace: ws, repoRoot: root, sources: ['cn-delta'] }), new RegExp(SOURCE_NEEDS_DRY_RUN.slice(0, 40).replace(/[-]/g, '\\-')));
  assert.equal(query(layout, 'SELECT COUNT(*) AS n FROM runs')[0]?.n, 0);
  assert.deepEqual(fs.readdirSync(layout.staging), [], 'nothing staged');

  const r = await cleanAndMerge({ workspace: ws, repoRoot: root, sources: ['cn-delta'], dryRun: true });
  assert.equal(r.status, 'dry-run');
  assert.deepEqual(r.report.stage.map((s) => s.source), ['cn-delta']);
  assert.equal(query(layout, 'SELECT COUNT(*) AS n FROM contacts')[0]?.n, 0);
  await assert.rejects(cleanAndMerge({ workspace: ws, repoRoot: root, sources: ['nope'], dryRun: true }), /unknown source "nope"/);
  await assert.rejects(cleanAndMerge({ workspace: ws, repoRoot: root, sources: ['new-source'], dryRun: true }), /no meta\.md \(run add-source new-source\)/);
});

/** Make output/reports a symlink to a directory outside the workspace, so writing reports fails. */
function breakReports(layout: WorkspaceLayout): string {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 't7-cm-out-'));
  fs.rmSync(layout.reports, { recursive: true, force: true });
  fs.symlinkSync(outside, layout.reports);
  return outside;
}

/** A trigger that makes the merge fail inside its transaction, after earlier writes. */
function breakMerge(layout: WorkspaceLayout): void {
  const db = openDb(layout.dbPath);
  db.exec("CREATE TRIGGER t7_fail BEFORE INSERT ON contact_sources BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
  db.close();
}

test('clean-and-merge: a report failure after commit → run ok, report_path null, clear exit-1 message', async () => {
  const { ws, layout, root } = setup();
  const outside = breakReports(layout);
  await assert.rejects(
    cleanAndMerge({ workspace: ws, repoRoot: root, now: new Date('2026-11-26T12:00:00Z') }),
    /^Error: merge committed \(run 20261126T120000Z\); report could not be written: .*outside the workspace.*; run review-report after fixing$/,
  );
  assert.deepEqual(query(layout, 'SELECT id, status, report_path FROM runs'), [{ id: '20261126T120000Z', status: 'ok', report_path: null }]);
  assert.equal(query(layout, 'SELECT COUNT(*) AS n FROM contacts')[0]?.n, expected.contacts_total);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.ok(!fs.existsSync(path.join(ws, '.lock')));
});

test('clean-and-merge: a merge failure rolls back, marks the run failed and writes the failure report', async () => {
  const { ws, layout, root } = setup();
  breakMerge(layout);
  const r = await cleanAndMerge({ workspace: ws, repoRoot: root, now: new Date('2026-11-26T12:00:00Z') });
  assert.equal(r.status, 'failed');
  assert.ok(r.report.errors.some((e) => e.includes('merge failed and was rolled back') && e.includes('forced failure')));
  assert.deepEqual(query(layout, 'SELECT status, report_path FROM runs'), [{ status: 'failed', report_path: r.paths.md }]);
  assert.equal(query(layout, 'SELECT COUNT(*) AS n FROM contacts')[0]?.n, 0);
  assert.equal(query(layout, 'SELECT COUNT(*) AS n FROM sources')[0]?.n, 0);
});

test('clean-and-merge: when the failure report cannot be written either, the run is still marked failed', async () => {
  const { ws, layout, root } = setup();
  breakMerge(layout);
  breakReports(layout);
  await assert.rejects(cleanAndMerge({ workspace: ws, repoRoot: root }), /merge failed and was rolled back \(run .*\): forced failure; the failure report could not be written either/);
  assert.deepEqual(query(layout, 'SELECT status, report_path FROM runs'), [{ status: 'failed', report_path: null }]);
});

test('clean-and-merge: runs in the same second get distinct millisecond timestamps', async () => {
  const { ws, layout, root } = setup();
  const now = new Date('2026-11-26T10:00:00Z');
  await cleanAndMerge({ workspace: ws, repoRoot: root, now });
  const r2 = await cleanAndMerge({ workspace: ws, repoRoot: root, now });
  assert.equal(r2.report.merged_at, '2026-11-26T10:00:00.001Z');
  assert.deepEqual(query(layout, 'SELECT started_at FROM runs ORDER BY id').map((x) => x.started_at), ['2026-11-26T10:00:00.000Z', '2026-11-26T10:00:00.001Z']);
});

test('clean-and-merge: an invalid meta.md stops the run before staging; the database is untouched', async () => {
  const { ws, layout, root } = setup();
  const metaPath = path.join(layout.resources, 'cn-delta', 'meta.md');
  fs.writeFileSync(metaPath, fs.readFileSync(metaPath, 'utf8').replace('kind: other', 'kind: weird'));
  await assert.rejects(cleanAndMerge({ workspace: ws, repoRoot: root }), /meta\.md is invalid[\s\S]*kind/);
  assert.deepEqual(fs.readdirSync(layout.staging), []);
  assert.deepEqual(fs.readdirSync(layout.backups), []);
  assert.equal(query(layout, 'SELECT COUNT(*) AS n FROM runs')[0]?.n, 0);
  assert.ok(!fs.existsSync(path.join(ws, '.lock')), 'lock released after an error');
});

test('clean-and-merge: a source without an email column fails the run, report lists the error, no db write', async () => {
  const { ws, layout, root } = setup();
  const dir = path.join(layout.resources, 'bad-src');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'x_2025-01-01.csv'), 'foo,bar\nnothing here,1\n');
  fs.writeFileSync(path.join(dir, 'meta.md'), '---\nsource: bad-src\nkind: other\nfiles:\n  - name: x_2025-01-01.csv\n    encoding: utf-8\n---\n');
  const r = await cleanAndMerge({ workspace: ws, repoRoot: root });
  assert.equal(r.status, 'failed');
  assert.ok(r.report.errors.some((e) => e.startsWith('bad-src:') && e.includes('no email column')));
  assert.equal(query(layout, 'SELECT COUNT(*) AS n FROM contacts')[0]?.n, 0);
  assert.equal(query(layout, 'SELECT COUNT(*) AS n FROM runs')[0]?.n, 0);
  assert.ok(fs.readFileSync(r.paths.md, 'utf8').includes('## Errors'));
});

test('clean-and-merge: a held workspace lock is a precondition error', async () => {
  const { ws, root } = setup();
  fs.writeFileSync(path.join(ws, '.lock'), JSON.stringify({ pid: process.pid, command: 'other', started_at: '2026-11-26T00:00:00Z' }));
  await assert.rejects(cleanAndMerge({ workspace: ws, repoRoot: root }), (err: Error) => err.name === 'PreconditionError' && /in use/.test(err.message));
});

test('clean-and-merge CLI: masked stdout, exit 0; --json; exit 2 for an uninitialized workspace', () => {
  const { ws } = setup();
  const r = spawnSync('node', ['scripts/clean-and-merge.ts', '--workspace', ws], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /: ok/);
  assert.match(r.stdout, /Report: .*\.md/);
  assert.deepEqual(unmaskedAddresses(r.stdout), []);
  assert.deepEqual(unmaskedAddresses(r.stderr), []);

  const j = spawnSync('node', ['scripts/clean-and-merge.ts', '--workspace', ws, '--json', '--dry-run'], { cwd: repo, encoding: 'utf8' });
  assert.equal(j.status, 0, j.stderr);
  const out = JSON.parse(j.stdout) as { status: string; merge: unknown };
  assert.equal(out.status, 'dry-run');
  assert.equal(out.merge, null);
  assert.deepEqual(unmaskedAddresses(j.stdout), []);

  const src = spawnSync('node', ['scripts/clean-and-merge.ts', '--workspace', ws, '--source', 'cn-delta'], { cwd: repo, encoding: 'utf8' });
  assert.equal(src.status, 1);
  assert.ok(src.stderr.includes(SOURCE_NEEDS_DRY_RUN), src.stderr);

  const empty = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 't7-cm-empty-')), 'ws');
  const e = spawnSync('node', ['scripts/clean-and-merge.ts', '--workspace', empty], { cwd: repo, encoding: 'utf8' });
  assert.equal(e.status, 2);
});
