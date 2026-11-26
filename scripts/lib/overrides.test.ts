import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOverrides } from './overrides.ts';

function tmp(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overrides-test-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test('missing files and empty dir give empty lists', () => {
  assert.deepEqual(loadOverrides(tmp()), { typo: [], suppressions: [], consents: [], exclude: [] });
  assert.deepEqual(loadOverrides(tmp({ 'typo-decisions.yaml': '# only comments\n', 'exclude.yaml': '[]\n' })).typo, []);
});

test('all four files load; emails are lowercased and trimmed only', () => {
  const dir = tmp({
    'typo-decisions.yaml': [
      '- email: " A@Example.CON "', '  action: accept', '  suggested: A@Example.com', '  note: fixed by phone',
      '- email: b@example.co.jo', '  action: reject',
    ].join('\n'),
    'suppressions.yaml': '- email: C@example.net\n  reason: bounced\n',
    'consents.yaml': '- email: d@example.org\n  source: shop\n  status: granted\n  note: form\n',
    'exclude.yaml': '- email: Test@Example.com\n- pattern: "*@Example.test"\n  note: qa\n',
  });
  assert.deepEqual(loadOverrides(dir), {
    typo: [
      { email: 'a@example.con', action: 'accept', suggested: 'a@example.com', note: 'fixed by phone' },
      { email: 'b@example.co.jo', action: 'reject' },
    ],
    suppressions: [{ email: 'c@example.net', reason: 'bounced' }],
    consents: [{ email: 'd@example.org', source: 'shop', status: 'granted', note: 'form' }],
    exclude: [{ email: 'test@example.com' }, { pattern: '*@example.test', note: 'qa' }],
  });
});

test('invalid entries are rejected with file name and entry number', () => {
  const bad = (name: string, text: string) => loadOverrides(tmp({ [name]: text }));
  assert.throws(() => bad('typo-decisions.yaml', '- email: a@example.com\n  action: maybe\n'), /typo-decisions\.yaml: entry 1: "action"/);
  assert.throws(() => bad('suppressions.yaml', '- email: a@example.com\n  reason: angry\n'), /suppressions\.yaml: entry 1: "reason"/);
  assert.throws(() => bad('suppressions.yaml', '- reason: manual\n'), /missing "email"/);
  assert.throws(() => bad('consents.yaml', '- email: a@example.com\n  status: granted\n'), /missing "source"/);
  assert.throws(() => bad('consents.yaml', '- email: a@example.com\n  source: s\n  status: yes\n'), /"status"/);
  assert.throws(() => bad('exclude.yaml', '- note: nothing\n'), /exactly one of/);
  assert.throws(() => bad('exclude.yaml', '- email: a@example.com\n  pattern: "*"\n'), /exactly one of/);
  assert.throws(() => bad('exclude.yaml', 'email: a@example.com\n'), /expected a list/);
  assert.throws(() => bad('exclude.yaml', '- just a string\n'), /entry 1 must be a mapping/);
  assert.throws(() => bad('exclude.yaml', ': : :\n  - [\n'), /not valid YAML/);
});
