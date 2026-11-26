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
  const re = /[^\s@＠<>"'`()[\]{}:,;|]+[@＠][^\s@＠<>"'`()[\]{}:,;|]+/gu;
  return (text.match(re) ?? []).filter((m) => !m.includes('*'));
}

test('review-report: pending decisions with full values in the file, masked summary', async () => {
  const { ws, layout, root } = setup();
  fs.mkdirSync(path.join(layout.resources, 'new-source'));
  fs.writeFileSync(path.join(layout.overrides, 'consents.yaml'), '- email: nobody@example.org\n  source: shop-alpha\n  status: granted\n');
  await cleanAndMerge({ workspace: ws, repoRoot: root });

  const r = reviewReport({ workspace: ws, repoRoot: root });
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

test('review-report: contacts orphaned by the latest run are listed', async () => {
  const { ws, layout, root } = setup();
  await cleanAndMerge({ workspace: ws, repoRoot: root, now: new Date('2026-11-26T10:00:00Z') });
  // drop one export from shop-alpha
  const dir = path.join(layout.resources, 'shop-alpha');
  fs.rmSync(path.join(dir, 'members_2025-03-01.csv'));
  const metaPath = path.join(dir, 'meta.md');
  fs.writeFileSync(metaPath, fs.readFileSync(metaPath, 'utf8').replace(/  - name: members_2025-03-01\.csv\n    encoding: cp932\n    header_row: 1\n/, ''));
  const run = await cleanAndMerge({ workspace: ws, repoRoot: root, now: new Date('2026-11-26T11:00:00Z') });
  assert.ok((run.report.merge?.contacts_orphaned ?? 0) > 0);

  const r = reviewReport({ workspace: ws, repoRoot: root });
  assert.equal(r.pending.orphaned.length, run.report.merge?.contacts_orphaned);
  assert.ok(r.pending.orphaned.every((o) => o.orphaned_at === '2026-11-26T11:00:00.000Z'));
  assert.deepEqual(unmaskedAddresses(renderReviewSummary(r)), []);
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
