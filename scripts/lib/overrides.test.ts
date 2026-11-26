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

test('errors never echo file content: a malformed YAML line holding an address is reported by position only (D28)', () => {
  const bad: Record<string, string> = {
    'typo-decisions.yaml': '- email: leak@example.com\n  action: [unclosed\n',
    'suppressions.yaml': 'leak@example.com\n',
    'consents.yaml': '- email: leak@example.com\n  source: s\n  status: leak@example.org\n',
    'exclude.yaml': '- email: leak@example.com\n  pattern: "leak*@example.net"\n',
    'typo-decisions-2': '',
  };
  for (const [name, text] of Object.entries(bad)) {
    if (!name.endsWith('.yaml')) continue;
    let message = '';
    try {
      loadOverrides(tmp({ [name]: text }));
    } catch (err) {
      message = (err as Error).message;
    }
    assert.notEqual(message, '', `${name} should throw`);
    assert.ok(!message.includes('leak'), `${name}: ${message}`);
    assert.ok(message.includes(name), message);
  }
  assert.match(
    (() => { try { loadOverrides(tmp({ 'typo-decisions.yaml': '- a: [unclosed\n' })); return ''; } catch (e) { return (e as Error).message; } })(),
    /typo-decisions\.yaml is not valid YAML \(.* at line \d+, column \d+\)/,
  );
});

test('YAML warnings (unresolved tag) are not printed and stop the load with code and position only', () => {
  const printed: string[] = [];
  const onWarning = (w: Error) => printed.push(w.message);
  process.on('warning', onWarning);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: unknown) => { printed.push(String(c)); return true; }) as typeof process.stderr.write;
  let message = '';
  try {
    loadOverrides(tmp({ 'suppressions.yaml': '- email: !bogus leak@example.com\n  reason: manual\n' }));
  } catch (err) {
    message = (err as Error).message;
  } finally {
    process.stderr.write = origErr;
    process.removeListener('warning', onWarning);
  }
  assert.match(message, /suppressions\.yaml has a YAML warning \(TAG_RESOLVE_FAILED at line 1, column \d+\)/);
  assert.ok(!message.includes('leak'), message);
  assert.ok(!printed.join('').includes('leak'), printed.join(''));
});
