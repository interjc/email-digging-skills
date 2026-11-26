import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PipelineConfig, SourceMeta, SourceStageResult } from './types.ts';
import { openDb, migrate } from './db.ts';
import { loadMeta } from './meta.ts';
import { loadOverrides } from './overrides.ts';
import { stageSource } from './stage.ts';
import { layoutDirs, workspaceLayout } from './paths.ts';
import { mergeStaged, startRun } from './merge.ts';
import { autoEncodings, buildReport, renderMarkdown, SAMPLE_LIMIT, writeReport } from './report.ts';
import { SJIS, writeFile } from './read/testutil.ts';

const repo = path.resolve(import.meta.dirname, '..', '..');
const fixtures = path.join(repo, 'fixtures');
const CONFIG: PipelineConfig = {
  workspace: '', sources: { priority: [] }, consent: { opt_in_bases: ['opt_in'], opt_in_sources: [] },
  masking: { keep_domain: true }, backups: { keep: 20 },
};

/** Address-like substrings that are not masked (masked forms contain `*`). */
function unmaskedAddresses(text: string): string[] {
  const re = /[^\s@＠﹫<>"'`()[\]{}:,;|]+[@＠﹫][^\s@＠﹫<>"'`()[\]{}:,;|]+/gu;
  return (text.match(re) ?? []).filter((m) => !m.includes('*'));
}

async function stagedFixtures() {
  const ws = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 't7-report-')), 'ws');
  const layout = workspaceLayout(ws);
  for (const d of layoutDirs(layout)) fs.mkdirSync(d, { recursive: true });
  fs.cpSync(path.join(fixtures, 'sources'), layout.resources, { recursive: true });
  fs.cpSync(path.join(fixtures, 'overrides'), layout.overrides, { recursive: true });
  const overrides = loadOverrides(layout.overrides);
  const metas: SourceMeta[] = fs.readdirSync(layout.resources).sort().map((n) => loadMeta(path.join(layout.resources, n)));
  const results: SourceStageResult[] = [];
  for (const m of metas) results.push(await stageSource(m, { stagingDir: layout.staging, overrides }));
  return { layout, overrides, metas, results };
}

test('report: masked JSON + Markdown with every section, latest copies, sample limits', async () => {
  const { layout, overrides, metas, results } = await stagedFixtures();
  const db = openDb(layout.dbPath);
  migrate(db, path.join(repo, 'schema', 'migrations'));
  const now = '2026-11-26T12:00:00.000Z';
  startRun(db, 'r1', 'test', now);
  const merge = await mergeStaged(results, { db, config: CONFIG, metas, overrides, runId: 'r1', now });
  db.close();

  const report = await buildReport(results, merge, {
    runId: 'r1', generatedAt: now, status: 'ok', mergedAt: now, metas,
    sourcesWithoutMeta: ['new-source'], warnings: ['consents.yaml: no contact taro@example.com in source "x"; override ignored', 'header "owner\uFE6Bexample.org" ignored'],
  });
  assert.equal(report.status, 'ok');
  assert.equal(report.merge?.contacts_total, merge.contacts_total);
  assert.deepEqual(report.priority_order, merge.priority_order);
  assert.ok(report.samples.invalid.length > 0 && report.samples.invalid.length <= SAMPLE_LIMIT);
  assert.ok(report.samples.invalid.every((s) => s.reason !== 'empty'));
  assert.ok(report.samples.invalid.some((s) => s.reason === 'excluded_by_override'));
  // typo suspects (after overrides): accepted / rejected ones are gone, open ones listed with sources
  assert.ok(report.samples.typo.length >= 1);
  assert.ok(report.samples.typo.some((t) => t.masked === 'y***@e***e.con' && t.masked_suggestion === 'y***@e***e.com'));
  // warnings are sanitized even when the caller passes a full address
  // ... also with the compatibility form U+FE6B of @
  assert.equal(report.warnings[0], 'consents.yaml: no contact t***@e***e.com in source "x"; override ignored');
  assert.equal(report.warnings[1], 'header "o***@e***e.org" ignored');

  const paths = writeReport(report, layout.reports, layout.workspace);
  assert.equal(paths.json, path.join(layout.reports, 'r1.json'));
  assert.equal(fs.readFileSync(path.join(layout.reports, 'latest.json'), 'utf8'), fs.readFileSync(paths.json, 'utf8'));
  assert.equal(fs.readFileSync(path.join(layout.reports, 'latest.md'), 'utf8'), fs.readFileSync(paths.md, 'utf8'));
  const md = fs.readFileSync(paths.md, 'utf8');
  const json = fs.readFileSync(paths.json, 'utf8');
  for (const heading of ['## Files', '## Totals', '## Source overlap', '## Priority order used', '## Overrides applied', '## Warnings', '### Rejected rows', '### Typo suspects']) {
    assert.ok(md.includes(heading), heading);
  }
  // per-file table row: counts, encoding and mappings with confidence
  assert.match(md, /\| shop-alpha \| members_2025-03-01\.csv \| 10 \| 1 \| 1 \| 0 \| 0 \| 1 \| 0 \| cp932 \(meta\) \| email←メールアドレス \(meta 1\)/);
  assert.ok(md.includes(`- Unique contacts (not orphaned): ${merge.contacts_total}`));
  assert.ok(md.includes(`- Cross-source duplicates (addresses in 2+ sources): ${merge.cross_source_dups}`));
  assert.ok(md.includes('Skipped (no meta.md, run add-source): new-source'));
  assert.deepEqual(unmaskedAddresses(md), []);
  assert.deepEqual(unmaskedAddresses(json), []);
  assert.equal(JSON.parse(json).run_id, 'r1');
});

test('report: dry run has no merge section but staged totals and the priority order', async () => {
  const { results, metas } = await stagedFixtures();
  const report = await buildReport(results, null, { runId: 'd1', generatedAt: '2026-11-26T12:00:00.000Z', status: 'dry-run', priorityOrder: ['shop-alpha'], metas });
  assert.equal(report.dry_run, true);
  assert.equal(report.merge, null);
  assert.ok(report.staged_totals.unique_emails > 0);
  const md = renderMarkdown(report);
  assert.ok(md.includes('dry run: nothing was written to the database'));
  assert.ok(md.includes('Unique addresses over the staged sources'));
  assert.ok(!md.includes('## Overrides applied'));
  assert.deepEqual(unmaskedAddresses(md), []);
});

test('report: auto-detected encodings list every candidate; headers and errors are sanitized', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 't7-enc-')), 'shop-x');
  // cp932 without BOM, header row includes an address-looking column name
  writeFile(dir, 'a.csv', SJIS.mailAddress, ',', SJIS.shimei, ',owner@example.com\ntaro@example.jp,', SJIS.takaTall, ',x\n');
  const meta: SourceMeta = {
    source: 'shop-x', kind: 'other', label: null, files: [{ name: 'a.csv', encoding: 'auto', header_row: 1 }],
    columns: {}, consent_basis: 'unknown', exported_at: null, dir,
  };
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 't7-enc-st-'));
  const result = await stageSource(meta, { stagingDir: staging, overrides: { typo: [], suppressions: [], consents: [], exclude: [] } });
  const enc = autoEncodings([result], [meta]);
  assert.equal(enc.length, 1);
  assert.equal(enc[0]?.encoding, 'cp932');
  assert.ok((enc[0]?.candidates.length ?? 0) >= 1);
  assert.ok(enc[0]?.candidates.includes('cp932'));

  const report = await buildReport([result], null, { runId: 'e1', generatedAt: 'now', status: 'failed', metas: [meta], errors: ['shop-y: no email column found. Headers seen: "boss@example.org"'] });
  const md = renderMarkdown(report);
  assert.ok(md.includes('## Errors'));
  assert.ok(md.includes('b***@e***e.org'));
  assert.deepEqual(unmaskedAddresses(md), []);
  assert.deepEqual(unmaskedAddresses(JSON.stringify(report)), []);
});

test('report files stay inside the workspace: symlinked targets are replaced, an outside reports dir is refused', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't7-wr-'));
  const ws = path.join(base, 'ws');
  const reports = path.join(ws, 'output', 'reports');
  fs.mkdirSync(reports, { recursive: true });
  const outside = path.join(base, 'outside.md');
  fs.writeFileSync(outside, 'keep me');
  fs.symlinkSync(outside, path.join(reports, 'latest.md'));

  const report = { run_id: 'r9', generated_at: 'now', status: 'dry-run', dry_run: true, merged_at: null, stage: [], merge: null, priority_order: [],
    sources_without_meta: [], staged_totals: { unique_emails: 0, cross_source_dups: 0, rejected_rows: 0 },
    samples: { invalid: [], typo: [], low_confidence_mappings: [], auto_encodings: [] }, warnings: [], errors: [] } as const;
  writeReport(structuredClone(report) as never, reports, ws);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep me', 'the symlink target is untouched');
  assert.ok(fs.lstatSync(path.join(reports, 'latest.md')).isFile());
  assert.equal((fs.statSync(path.join(reports, 'r9.json')).mode & 0o777), 0o600);
  assert.deepEqual(fs.readdirSync(reports).filter((f) => f.endsWith('.tmp')), []);

  // reports directory that resolves outside the workspace
  const elsewhere = path.join(base, 'elsewhere');
  fs.mkdirSync(elsewhere);
  const ws2 = path.join(base, 'ws2');
  fs.mkdirSync(path.join(ws2, 'output'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(ws2, 'output', 'reports'));
  assert.throws(() => writeReport(structuredClone(report) as never, path.join(ws2, 'output', 'reports'), ws2), /outside the workspace/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  // a run id that is not a plain file name never escapes the directory
  assert.throws(() => writeReport({ ...structuredClone(report), run_id: '../x' } as never, reports, ws), /invalid file name/);
});
