import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { cleanAndMerge } from './clean-and-merge.ts';
import { reviewReport, renderReviewSummary, PENDING_FILE } from './review-report.ts';
import type { PendingDecisions } from './review-report.ts';
import { openDb, migrate } from './lib/db.ts';
import { loadOverrides } from './lib/overrides.ts';
import { layoutDirs, workspaceLayout } from './lib/paths.ts';
import type { WorkspaceLayout } from './lib/paths.ts';

const repo = path.resolve(import.meta.dirname, '..');
const fixtures = path.join(repo, 'fixtures');

function setup(): { ws: string; layout: WorkspaceLayout; root: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't7-rr-'));
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

test('review-report: pending decisions with full values in the file, masked summary', async () => {
  const { ws, layout, root } = setup();
  fs.mkdirSync(path.join(layout.resources, 'new-source'));
  fs.writeFileSync(path.join(layout.overrides, 'consents.yaml'), '- email: nobody@example.org\n  source: shop-alpha\n  status: granted\n');
  await cleanAndMerge({ workspace: ws, repoRoot: root });

  const r = await reviewReport({ workspace: ws, repoRoot: root });
  const p = r.pending;
  const typo = p.typo_decisions.map((t) => t.email);
  assert.ok(typo.includes('yuta.kobayashi@example.con'));
  assert.ok(!typo.includes('saki.watanabe@example.co.jo'), 'rejected typo has a decision');
  assert.ok(!typo.includes('hiroshi.tanaka@example.con'), 'accepted typo has a decision');
  const yuta = p.typo_decisions.find((t) => t.email === 'yuta.kobayashi@example.con');
  assert.deepEqual(yuta, { email: 'yuta.kobayashi@example.con', suggested: 'yuta.kobayashi@example.com', action: null, note: null, sources: ['shop-alpha'] });
  assert.deepEqual(p.sources_without_meta, ['new-source']);
  assert.ok(p.unknown_consent_basis.includes('cn-delta'));
  assert.ok(!p.unknown_consent_basis.includes('shop-alpha'));
  assert.equal(p.override_warnings.length, 1);
  assert.match(p.override_warnings[0] as string, /consents\.yaml: no contact n\*\*\*@e\*\*\*e\.org/);
  assert.deepEqual(p.orphaned, []);
  assert.ok(p.encodings.every((e) => e.detected !== 'utf-8' || e.candidates.length > 1), 'D25');

  // The file has the full values and loads as typo-decisions once `action` is filled in.
  const text = fs.readFileSync(path.join(layout.reports, PENDING_FILE), 'utf8');
  assert.ok(text.includes('yuta.kobayashi@example.con'));
  assert.match(text, /^\s+action:\s*$/m);
  const doc = parseYaml(text) as PendingDecisions;
  assert.equal(doc.typo_decisions.length, p.typo_decisions.length);
  const decided = doc.typo_decisions.map((t) => ({ ...t, action: 'reject' }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't7-rr-ov-'));
  fs.writeFileSync(path.join(dir, 'typo-decisions.yaml'), JSON.stringify(decided));
  assert.equal(loadOverrides(dir).typo.length, decided.length);

  const summary = renderReviewSummary(r);
  assert.match(summary, /Typo suspects without a decision: \d+/);
  assert.match(summary, /y\*\*\*@e\*\*\*e\.con → y\*\*\*@e\*\*\*e\.com \(shop-alpha\)/);
  assert.deepEqual(unmaskedAddresses(summary), []);
});

test('review-report: orphans are attributed to the exact run, also for runs in the same second', async () => {
  const { ws, layout, root } = setup();
  const now = new Date('2026-11-26T10:00:00Z');
  await cleanAndMerge({ workspace: ws, repoRoot: root, now });
  const exclude = path.join(layout.overrides, 'exclude.yaml');
  const base = fs.readFileSync(exclude, 'utf8');
  fs.writeFileSync(exclude, `${base}- email: ren.nakamura@example.jp\n`);
  const run1 = await cleanAndMerge({ workspace: ws, repoRoot: root, now });
  assert.equal(run1.report.merge?.contacts_orphaned, 1);
  assert.deepEqual((await reviewReport({ workspace: ws, repoRoot: root })).pending.orphaned.map((o) => o.email), ['ren.nakamura@example.jp']);

  fs.writeFileSync(exclude, `${base}- email: ren.nakamura@example.jp\n- email: kenji.ito@example.jp\n`);
  const run2 = await cleanAndMerge({ workspace: ws, repoRoot: root, now });
  assert.equal(run2.report.merge?.contacts_orphaned, 1);
  const r = await reviewReport({ workspace: ws, repoRoot: root });
  assert.deepEqual(r.pending.orphaned, [{ email: 'kenji.ito@example.jp', orphaned_at: '2026-11-26T10:00:00.002Z' }]);
  assert.deepEqual(unmaskedAddresses(renderReviewSummary(r)), []);
});

test('review-report: every detected encoding (not the 20 report samples); exact header names only in the pending file', async () => {
  const { ws, layout, root } = setup();
  // 25 cp932 files without BOM, encoding auto → all detected (non-UTF-8 → to confirm, D25)
  const dir = path.join(layout.resources, 'many-files');
  fs.mkdirSync(dir);
  const files: string[] = [];
  for (let i = 0; i < 25; i++) {
    const name = `part${String(i).padStart(2, '0')}_2025-01-01.csv`;
    files.push(name);
    fs.writeFileSync(path.join(dir, name), Buffer.concat([
      Buffer.from([0x83, 0x81, 0x81, 0x5b, 0x83, 0x8b]), // メール
      Buffer.from(`,x\nm${i}@example.org,`), Buffer.from([0x83, 0x41]), Buffer.from('\n'),
    ]));
  }
  fs.writeFileSync(path.join(dir, 'meta.md'), `---\nsource: many-files\nkind: other\nfiles:\n${files.map((f) => `  - name: ${f}\n    encoding: auto\n`).join('')}---\n`);
  // a low-confidence mapping whose header holds an address (compatibility @ U+FE6B in another column)
  const odd = path.join(layout.resources, 'odd-header');
  fs.mkdirSync(odd);
  fs.writeFileSync(path.join(odd, 'list_2025-01-01.csv'), 'contact mail owner@example.org,note boss\uFE6Bexample.net\nz@example.org,a\n');
  fs.writeFileSync(path.join(odd, 'meta.md'), '---\nsource: odd-header\nkind: other\nfiles:\n  - name: list_2025-01-01.csv\n    encoding: utf-8\n---\n');

  const run = await cleanAndMerge({ workspace: ws, repoRoot: root });
  assert.equal(run.status, 'ok', run.report.errors.join('; '));
  assert.equal(run.report.samples.auto_encodings.length, 20, 'report samples are capped');
  const r = await reviewReport({ workspace: ws, repoRoot: root });
  const many = r.pending.encodings.filter((e) => e.source === 'many-files');
  assert.equal(many.length, 25);
  assert.ok(many.every((e) => e.detected === 'cp932' && e.candidates.includes('cp932')));

  const low = r.pending.low_confidence_mappings.find((m) => m.source === 'odd-header' && m.field === 'email');
  assert.equal(low?.column, 'contact mail owner@example.org', 'exact header in the pending decisions');
  const text = fs.readFileSync(r.pending_path, 'utf8');
  assert.ok(text.includes('contact mail owner@example.org'));
  const summary = renderReviewSummary(r);
  assert.ok(summary.includes('odd-header/list_2025-01-01.csv: email ←'));
  assert.ok(!summary.includes('owner@example.org'));
  assert.deepEqual(unmaskedAddresses(summary), []);
  assert.deepEqual(unmaskedAddresses(fs.readFileSync(path.join(layout.reports, 'latest.md'), 'utf8')), []);
});

test('review-report: the pending file stays inside the workspace; the lock is held', async () => {
  const { ws, layout, root } = setup();
  await cleanAndMerge({ workspace: ws, repoRoot: root });
  // a symlink at the target is replaced, not followed
  const outsideFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 't7-rr-out-')), 'victim.yaml');
  fs.writeFileSync(outsideFile, 'keep me');
  fs.symlinkSync(outsideFile, path.join(layout.reports, PENDING_FILE));
  await reviewReport({ workspace: ws, repoRoot: root });
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'keep me');
  assert.ok(fs.lstatSync(path.join(layout.reports, PENDING_FILE)).isFile());
  assert.equal(fs.statSync(path.join(layout.reports, PENDING_FILE)).mode & 0o777, 0o600);

  // a reports directory that resolves outside the workspace is refused
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 't7-rr-outdir-'));
  fs.cpSync(path.join(layout.reports, 'latest.json'), path.join(outsideDir, 'latest.json'));
  fs.rmSync(layout.reports, { recursive: true });
  fs.symlinkSync(outsideDir, layout.reports);
  await assert.rejects(reviewReport({ workspace: ws, repoRoot: root }), /outside the workspace/);
  assert.deepEqual(fs.readdirSync(outsideDir), ['latest.json']);
  fs.rmSync(layout.reports);
  fs.mkdirSync(layout.reports);
  fs.cpSync(path.join(outsideDir, 'latest.json'), path.join(layout.reports, 'latest.json'));

  fs.writeFileSync(path.join(ws, '.lock'), JSON.stringify({ pid: process.pid, command: 'clean-and-merge', started_at: '2026-11-26T00:00:00Z' }));
  await assert.rejects(reviewReport({ workspace: ws, repoRoot: root }), (err: Error) => err.name === 'PreconditionError' && /in use/.test(err.message));
});

test('review-report CLI: masked stdout and --json; exit 2 without a report', async () => {
  const { ws, root } = setup();
  const none = spawnSync('node', ['scripts/review-report.ts', '--workspace', ws], { cwd: repo, encoding: 'utf8' });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /run clean-and-merge first/);

  await cleanAndMerge({ workspace: ws, repoRoot: root });
  const r = spawnSync('node', ['scripts/review-report.ts', '--workspace', ws], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Full values and ready-to-edit entries: .*pending-decisions\.yaml/);
  assert.deepEqual(unmaskedAddresses(r.stdout), []);
  assert.deepEqual(unmaskedAddresses(r.stderr), []);

  const j = spawnSync('node', ['scripts/review-report.ts', '--workspace', ws, '--json'], { cwd: repo, encoding: 'utf8' });
  assert.equal(j.status, 0, j.stderr);
  const out = JSON.parse(j.stdout) as PendingDecisions;
  assert.ok(out.typo_decisions.length > 0);
  assert.ok(out.typo_decisions.every((t) => t.email.includes('*')));
  assert.deepEqual(unmaskedAddresses(j.stdout), []);
});
