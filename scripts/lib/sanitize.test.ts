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
