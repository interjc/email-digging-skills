import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, parseConfig } from './config.ts';
import { repoRoot } from './paths.ts';

function tmpRepo(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-')));
  fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
  return root;
}

test('missing config.yaml gives the documented defaults and <repo>/workspace', () => {
  const root = tmpRepo();
  const warnings: string[] = [];
  const cfg = loadConfig({ repoRoot: root, env: {}, onWarning: (w) => warnings.push(w) });
  assert.deepEqual(cfg, {
    workspace: path.join(root, 'workspace'),
    sources: { priority: [] },
    consent: { opt_in_bases: ['opt_in'], opt_in_sources: [] },
    masking: { keep_domain: true },
    backups: { keep: 20 },
  });
  assert.deepEqual(warnings, []);
});

test('config.example.yaml parses to the same values as the defaults', () => {
  const text = fs.readFileSync(path.join(repoRoot(), 'config.example.yaml'), 'utf8');
  const { config, warnings } = parseConfig(text);
  assert.deepEqual(warnings, []);
  assert.deepEqual(config, {
    sources: { priority: [] },
    consent: { opt_in_bases: ['opt_in'], opt_in_sources: [] },
    masking: { keep_domain: true },
    backups: { keep: 20 },
  });
});

test('user values override defaults; workspace is resolved against the repo root', () => {
  const root = tmpRepo();
  fs.writeFileSync(path.join(root, 'config.yaml'), [
    'workspace: ./data',
    'sources:', '  priority: [a, b]',
    'consent:', '  opt_in_bases: [opt_in, transactional]', '  opt_in_sources: [c]',
    'masking:', '  keep_domain: false',
    'backups:', '  keep: 3',
  ].join('\n'));
  const cfg = loadConfig({ repoRoot: root, env: {}, onWarning: () => {} });
  assert.equal(cfg.workspace, path.join(root, 'data'));
  assert.deepEqual(cfg.sources.priority, ['a', 'b']);
  assert.deepEqual(cfg.consent, { opt_in_bases: ['opt_in', 'transactional'], opt_in_sources: ['c'] });
  assert.equal(cfg.masking.keep_domain, false);
  assert.equal(cfg.backups.keep, 3);
});

test('MAIL_PIPELINE_WORKSPACE in the environment wins over config.yaml', () => {
  const root = tmpRepo();
  fs.writeFileSync(path.join(root, 'config.yaml'), 'workspace: ./data\n');
  const cfg = loadConfig({ repoRoot: root, env: { MAIL_PIPELINE_WORKSPACE: '/somewhere/else' } });
  assert.equal(cfg.workspace, path.resolve('/somewhere/else'));
});

test('unknown keys produce warnings, not errors', () => {
  const warnings: string[] = [];
  const root = tmpRepo();
  fs.writeFileSync(path.join(root, 'config.yaml'), 'colour: red\nbackups:\n  keep: 5\n  frequency: daily\n');
  const cfg = loadConfig({ repoRoot: root, env: {}, onWarning: (w) => warnings.push(w) });
  assert.equal(cfg.backups.keep, 5);
  assert.equal(warnings.length, 2);
  assert.match(warnings.join('\n'), /"colour"/);
  assert.match(warnings.join('\n'), /"backups\.frequency"/);
});

test('type errors are rejected with the offending key', () => {
  assert.throws(() => parseConfig('backups:\n  keep: many\n'), /backups\.keep/);
  assert.throws(() => parseConfig('backups:\n  keep: 0\n'), /backups\.keep/);
  assert.throws(() => parseConfig('masking:\n  keep_domain: yes please\n'), /keep_domain/);
  assert.throws(() => parseConfig('sources:\n  priority: a\n'), /sources\.priority/);
  assert.throws(() => parseConfig('consent:\n  opt_in_bases: [maybe]\n'), /"maybe"/);
  assert.throws(() => parseConfig('workspace: 5\n'), /workspace/);
  assert.throws(() => parseConfig('- a\n- b\n'), /mapping/);
  assert.throws(() => parseConfig('a: [unclosed\n'), /not valid YAML/);
});

test('an empty config.yaml (or only comments) is the defaults', () => {
  assert.equal(parseConfig('# nothing\n').config.backups.keep, 20);
  assert.equal(parseConfig('sources:\n  priority: []\n#  - x\n').config.sources.priority.length, 0);
});

test('config errors and warnings never echo address-like values (D28)', () => {
  assert.throws(() => parseConfig('a: [leak@example.com\n'), (e: unknown) => !(e as Error).message.includes('leak') && /not valid YAML \(.*line \d+/.test((e as Error).message));
  assert.throws(() => parseConfig('consent:\n  opt_in_bases: [leak@example.com]\n'), (e: unknown) => !(e as Error).message.includes('leak@'));
  const { warnings } = parseConfig('leak@example.com: 1\n');
  assert.equal(warnings.length, 1);
  assert.ok(!String(warnings[0]).includes('leak@'), String(warnings[0]));
});
