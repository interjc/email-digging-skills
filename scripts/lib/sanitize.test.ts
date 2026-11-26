import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseYaml } from 'yaml';
import { describeYamlError, sanitizeError, sanitizeText } from './sanitize.ts';

test('sanitizeText masks addresses inside prose, quotes, brackets and lists', () => {
  assert.equal(sanitizeText('bad row: taro@example.com here'), 'bad row: t***@e***e.com here');
  assert.equal(sanitizeText('"a@example.org", <b@example.net>; (c@example.jp)'), '"a***@e***e.org", <b***@e***e.net>; (c***@e***e.jp)');
  assert.equal(sanitizeText('mailto:taro@example.com'), 'mailto:t***@e***e.com');
});

test('sanitizeText handles full-width @, uppercase and several addresses', () => {
  assert.equal(sanitizeText('Taro＠Example.com'), 'T***@E***e.com');
  assert.equal(sanitizeText('a@example.com,b@example.org'), 'a***@e***e.com,b***@e***e.org');
});

test('sanitizeText blanks fragments that are not full addresses', () => {
  assert.equal(sanitizeText('secret@'), '***');
  assert.equal(sanitizeText('x @host'), 'x ***');
  assert.equal(sanitizeText('user@localhost'), '***');
});

test('sanitizeText leaves text without addresses and already-masked values alone', () => {
  assert.equal(sanitizeText('entry 3: "action" must be accept'), 'entry 3: "action" must be accept');
  assert.equal(sanitizeText('t***@e***e.com'), 't***@e***e.com');
  assert.equal(sanitizeText(''), '');
});

test('no input address survives sanitizeText', () => {
  const addresses = ['taro@example.com', 'a.b+c@example.co.jo', 'x_y@docomo.ne.jp', 'ＡＢ＠example.com']; // email-scan:allow
  for (const a of addresses) {
    const out = sanitizeText(`prefix ${a} suffix`);
    const local = a.normalize('NFKC').split('@')[0] as string;
    assert.ok(!out.toLowerCase().includes(a.toLowerCase()), out);
    assert.ok(!out.includes(local), out);
  }
});

test('sanitizeError takes the first line only and masks it', () => {
  assert.equal(sanitizeError(new Error('failed for taro@example.com\nsecond line b@example.net')), 'failed for t***@e***e.com');
  assert.equal(sanitizeError('plain a@example.com'), 'plain a***@e***e.com');
});

test('describeYamlError reports code and position, never the source text', () => {
  let msg = '';
  try {
    parseYaml('- email: leak@example.com\n  bad: [unclosed\n');
  } catch (err) {
    msg = describeYamlError(err);
  }
  assert.match(msg, /line \d+, column \d+/);
  assert.ok(!msg.includes('leak'));
  assert.equal(describeYamlError(new Error('x')), 'parse error');
});

// --- round 2 (review R2) ---------------------------------------------------------------------------

import { parseCliArgs, printWarnings } from './cli.ts';
import { parseYamlSafe } from './sanitize.ts';

test('sanitizeText finds compatibility forms of @ (small-form U+FE6B, full-width) and masks the original span', () => {
  for (const at of ['﹫', '＠']) {
    const out = sanitizeText(`x leak${at}example.com y`);
    assert.ok(!out.includes('leak'), out);
    assert.equal(out, 'x l***@e***e.com y');
  }
  // text outside the matches is left exactly as it was (no NFKC applied to it)
  assert.equal(sanitizeText('Ａ＝１ taro﹫example.org ㈱'), 'Ａ＝１ t***@e***e.org ㈱');
  // full-width letters in the address itself
  assert.ok(!sanitizeText('ｌｅａｋ＠ｅｘａｍｐｌｅ．ｃｏｍ').includes('ｌｅａｋ'));
});

test('sanitizeText: bare compatibility @ fragments are blanked', () => {
  assert.equal(sanitizeText('secret﹫'), '***');
  assert.equal(sanitizeText('x ＠host'), 'x ***');
});

test('parseYamlSafe: errors and warnings are code + position only, and nothing is printed', () => {
  const printed: string[] = [];
  const onWarning = (w: Error) => printed.push(w.message);
  process.on('warning', onWarning);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: unknown) => { printed.push(String(c)); return true; }) as typeof process.stderr.write;
  let res;
  try {
    res = parseYamlSafe('- email: !bogus leak@example.com\n');
  } finally {
    process.stderr.write = origErr;
    process.removeListener('warning', onWarning);
  }
  assert.deepEqual(res.errors, []);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0] as string, /^TAG_RESOLVE_FAILED at line 1, column \d+$/);
  assert.ok(!printed.join('').includes('leak'), printed.join(''));

  const bad = parseYamlSafe('a: [leak@example.com\n');
  assert.ok(bad.errors.length > 0 && bad.errors.every((e) => !e.includes('leak')));
  assert.equal(bad.value, null);
});

test('parseCliArgs: an unknown option holding an address-like value is masked in the error', () => {
  for (const argv of [['--leak@example.com'], ['--x=leak@example.com'], ['--workspace']]) {
    assert.throws(() => parseCliArgs(argv), (err: unknown) => err instanceof Error && !err.message.includes('leak@') && !err.message.includes('leak﹫'));
  }
  assert.throws(() => parseCliArgs(['--leak﹫example.com']), (err: unknown) => err instanceof Error && !err.message.includes('leak'));
  assert.deepEqual(parseCliArgs(['--json', 'name']).positionals, ['name']);
});

test('printWarnings masks addresses', () => {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: unknown) => { chunks.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    printWarnings(['odd file leak@example.com']);
  } finally {
    process.stderr.write = orig;
  }
  assert.equal(chunks.join(''), 'Warning: odd file l***@e***e.com\n');
});

// --- round 3 (review R4) ---------------------------------------------------------------------------

import { containsAddress } from './sanitize.ts';

test('containsAddress: the same detection as sanitizeText, NFKC-aware', () => {
  for (const t of ['taro@example.com', 'x leak﹫example.com y', 'Ｔａｒｏ＠ｅｘａｍｐｌｅ．ｃｏｍ', 'mailto:a@example.org', 'secret@', '＠host']) {
    assert.equal(containsAddress(t), true, t);
    assert.notEqual(sanitizeText(t), t, t);
  }
  for (const t of ['', 'plain text', 'column 3', 't***@e***e.com', '***', 'price 5 at shop']) {
    assert.equal(containsAddress(t), false, t);
  }
});

import { sanitizeDeep } from './sanitize.ts';

test('sanitizeDeep masks values and keys recursively, keeps structure, and its serialization parses', () => {
  const input = { dir: '@pending', list: ['a@example.com', 3, null, true, { 'k@example.org': 'x' }], n: 1 };
  const out = sanitizeDeep(input);
  const json = JSON.stringify(out);
  assert.doesNotThrow(() => JSON.parse(json));
  assert.ok(!json.includes('a@example') && !json.includes('k@example') && !json.includes('@pending'), json);
  assert.deepEqual(Object.keys(out), ['dir', 'list', 'n']);
  assert.equal((out.list as unknown[])[1], 3);
  assert.equal((out.list as unknown[])[2], null);
  assert.equal(input.dir, '@pending', 'the input is not mutated');
});
