import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EmailCandidate, EmailStatus, Flag } from '../types.ts';
import { normalizeEmailCell } from './normalize.ts';

function accepted(
  raw: string,
  email: string,
  status: EmailStatus = 'valid',
  flags: Flag[] = [],
  suggestion: string | null = null,
): EmailCandidate {
  return { raw, email, domain: email.slice(email.indexOf('@') + 1), status, flags, suggestion, rejectReason: null };
}

function rejected(raw: string, rejectReason: 'empty' | 'invalid_syntax' = 'invalid_syntax', flags: Flag[] = []): EmailCandidate {
  return { raw, email: null, domain: null, status: null, flags, suggestion: null, rejectReason };
}

test('returns one empty candidate for null, undefined, and whitespace', () => {
  for (const cell of [null, undefined, '', ' \r\n\t　']) {
    assert.deepEqual(normalizeEmailCell(cell), [rejected(cell ?? '', 'empty')]);
  }
});

test('normalizes full-width characters and lowercases the whole address', () => {
  const fullWidth = 'ｔａｒｏ＠ｅｘａｍｐｌｅ．ｊｐ';
  assert.deepEqual(normalizeEmailCell(fullWidth), [accepted(fullWidth, 'taro@example.jp', 'valid', ['width_normalized'])]);
  assert.deepEqual(normalizeEmailCell('　TARO@EXAMPLE.JP　'), [accepted('TARO@EXAMPLE.JP', 'taro@example.jp')]);
});

test('extracts mailto addresses and removes enclosing punctuation', () => {
  for (const raw of [
    'MAILTO:<taro@example.jp>',
    '<mailto:taro@example.jp>',
    'mailto: taro@example.jp',
    'mailto: < taro@example.jp >',
    'ｍａｉｌｔｏ：＜taro@example.jp＞',
    '"山田 <taro@example.jp>"',
    '"taro@example.jp"',
    "'taro@example.jp'",
    '( taro@example.jp )',
    '( <taro@example.jp> )',
    '[taro@example.jp]',
  ]) {
    assert.deepEqual(normalizeEmailCell(raw), [accepted(raw, 'taro@example.jp')]);
  }
  assert.deepEqual(normalizeEmailCell("o'brien@example.jp"), [accepted("o'brien@example.jp", "o'brien@example.jp")]);
});

test('extracts named addresses before splitting and retains each original display name', () => {
  const first = '山田 <taro@example.jp>';
  const second = '"Ｙａｍａｄａ, Hanako; Sales | East" <hanako@example.jp>';
  const third = "'Doe, Jane' <jane@example.com>";
  assert.deepEqual(normalizeEmailCell(first), [accepted(first, 'taro@example.jp')]);
  assert.deepEqual(normalizeEmailCell(`a@example.com; ${first}, ${second} ${third}`), [
    accepted('a@example.com', 'a@example.com', 'valid', ['split_from_multi']),
    accepted(first, 'taro@example.jp', 'valid', ['split_from_multi']),
    accepted(second, 'hanako@example.jp', 'valid', ['split_from_multi']),
    accepted(third, 'jane@example.com', 'valid', ['split_from_multi']),
  ]);
});

test('removes invisible characters from addresses while preserving raw values', () => {
  const raw = '\ufefft\u200ba\u200cr\u200do@ex\u2060am\u00adple.\u0000jp';
  assert.deepEqual(normalizeEmailCell(raw), [accepted(raw, 'taro@example.jp')]);
});

test('splits all supported separators and retains order and raw spelling', () => {
  assert.deepEqual(normalizeEmailCell('a@example.com; b@example.com、c@example.com'), [
    accepted('a@example.com', 'a@example.com', 'valid', ['split_from_multi']),
    accepted('b@example.com', 'b@example.com', 'valid', ['split_from_multi']),
    accepted('c@example.com', 'c@example.com', 'valid', ['split_from_multi']),
  ]);
  for (const separator of [',', ';', '、', '，', '；', '|', '｜', '\n', '\r\n', '\t', ' ', '　']) {
    assert.deepEqual(normalizeEmailCell(`${separator} A@example.com ${separator} b@example.com ${separator}`), [
      accepted('A@example.com', 'a@example.com', 'valid', ['split_from_multi']),
      accepted('b@example.com', 'b@example.com', 'valid', ['split_from_multi']),
    ]);
  }
});

test('collapses duplicate addresses and retains the first part and split flag', () => {
  assert.deepEqual(normalizeEmailCell('a@example.com;a@example.com'), [
    accepted('a@example.com', 'a@example.com', 'valid', ['split_from_multi']),
  ]);
  assert.deepEqual(normalizeEmailCell('A@example.com;<a@example.com>;a@example.com'), [
    accepted('A@example.com', 'a@example.com', 'valid', ['split_from_multi']),
  ]);
});

test('rejects invalid syntax and retains raw values and normalization flags', () => {
  for (const raw of [
    'no-at-sign', 'a@@example.com', 'a@example', '@example.com', 'a@', 'é@example.com',
    'a@-example.com', 'a@example-.com', 'a@example..com', 'a@example.c', 'a@example.c0m',
    'a@example.com.', 'a@exam_ple.com', '"a"@example.com', 'Name <a@x>',
  ]) {
    assert.deepEqual(normalizeEmailCell(raw), [rejected(raw)]);
  }
  assert.deepEqual(normalizeEmailCell('ａ＠example; a@example.com'), [
    rejected('ａ＠example', 'invalid_syntax', ['split_from_multi', 'width_normalized']),
    accepted('a@example.com', 'a@example.com', 'valid', ['split_from_multi']),
  ]);
});

test('enforces the local and total address length limits', () => {
  const maxLocal = 'a'.repeat(64);
  const maxLength = `${maxLocal}@${'a'.repeat(62)}.${'a'.repeat(62)}.${'a'.repeat(59)}.com`;
  assert.equal(maxLength.length, 254);
  assert.deepEqual(normalizeEmailCell(maxLength), [accepted(maxLength, maxLength)]);
  for (const raw of [`a${maxLocal}@example.com`, `${maxLength}m`]) {
    assert.deepEqual(normalizeEmailCell(raw), [rejected(raw)]);
  }
});

test('accepts legacy mobile dots and flags each applicable address', () => {
  for (const raw of ['taro..yamada.@example.jp', '.taro@example.jp', 'taro.@example.jp', 'taro..yamada@example.jp']) {
    assert.deepEqual(normalizeEmailCell(raw), [accepted(raw, raw, 'valid', ['legacy_mobile_dots'])]);
  }
});

test('flags role addresses and recognizes the role before a plus tag', () => {
  for (const raw of ['info@example.com', 'info+jp@example.com', 'no-reply@example.com']) {
    assert.deepEqual(normalizeEmailCell(raw), [accepted(raw, raw, 'role', ['role_address'])]);
  }
  assert.deepEqual(normalizeEmailCell('myinfo@example.com'), [accepted('myinfo@example.com', 'myinfo@example.com')]);
});

test('suggests a correction for an exact typo without rewriting the address', () => {
  const raw = 'a@gmial.com'; // email-scan:allow
  const suggestion = 'a@gmail.com'; // email-scan:allow
  assert.deepEqual(normalizeEmailCell(raw), [accepted(raw, raw, 'typo_suspect', ['typo_suspect'], suggestion)]);
});

test('suggests corrections for known suffixes', () => {
  for (const [wrong, correct] of [
    ['example.con', 'example.com'], ['example.cmo', 'example.com'], ['example.comm', 'example.com'],
    ['example.co.jo', 'example.co.jp'], ['example.ne.jo', 'example.ne.jp'], ['example.or.jo', 'example.or.jp'],
    ['example.nett', 'example.net'],
  ]) {
    const raw = `a@${wrong}`;
    assert.deepEqual(normalizeEmailCell(raw), [accepted(raw, raw, 'typo_suspect', ['typo_suspect'], `a@${correct}`)]);
  }
});

test('gives typo status precedence over role status and keeps all flags sorted', () => {
  const raw = 'info@example.con';
  assert.deepEqual(normalizeEmailCell(raw), [
    accepted(raw, raw, 'typo_suspect', ['role_address', 'typo_suspect'], 'info@example.com'),
  ]);
  const combined = 'ＩＮＦＯ＋ｔｅｓｔ．．＠ｅｘａｍｐｌｅ．ｃｏｎ';
  assert.deepEqual(normalizeEmailCell(`${combined}; a@example.com`), [
    accepted(combined, 'info+test..@example.con', 'typo_suspect',
      ['legacy_mobile_dots', 'role_address', 'split_from_multi', 'typo_suspect', 'width_normalized'], 'info+test..@example.com'),
    accepted('a@example.com', 'a@example.com', 'valid', ['split_from_multi']),
  ]);
});

test('preserves Gmail dot and plus-tag variants as distinct addresses', () => {
  const variants = ['normalizer.test123@gmail.com', 'normalizertest123@gmail.com', 'normalizer.test123+fixture@gmail.com']; // email-scan:allow
  assert.deepEqual(normalizeEmailCell(variants.join(';')), variants.map((raw) => accepted(raw, raw, 'valid', ['split_from_multi'])));
});

test('falls back to offline provider-distance suggestions while keeping table rules and traps intact', () => {
  // Exact table typos stay handled by domain-typos.json (including gmail.co)
  for (const [wrong, right] of [
    ['a@gmail.co', 'a@gmail.com'], // email-scan:allow
    ['a@gmial.com', 'a@gmail.com'], // email-scan:allow
    ['a@gmaill.com', 'a@gmail.com'], // email-scan:allow
    ['a@outlool.com', 'a@outlook.com'], // email-scan:allow
    ['a@hotmal.com', 'a@hotmail.com'], // email-scan:allow
    ['a@icluod.com', 'a@icloud.com'], // email-scan:allow
    ['a@foxmial.com', 'a@foxmail.com'], // email-scan:allow
  ] as const) {
    assert.deepEqual(normalizeEmailCell(wrong), [accepted(wrong, wrong, 'typo_suspect', ['typo_suspect'], right)]);
  }

  // Known-real domains, curated providers, short/ambiguous domains, and distance-2 domains stay valid
  for (const raw of [
    'a@mail.com', // email-scan:allow
    'a@email.com', // email-scan:allow
    'a@126.com', // email-scan:allow
    'a@163.com', // email-scan:allow
    'a@123.com', // email-scan:allow
    'a@sina.cn', // email-scan:allow
    'a@q.com', // email-scan:allow
    'a@yahoo.co.jp', // email-scan:allow
    'a@yahoo.com', // email-scan:allow
    'a@docomo.ne.jp', // email-scan:allow
    'a@gmailll.com', // email-scan:allow
  ]) {
    assert.deepEqual(normalizeEmailCell(raw), [accepted(raw, raw, 'valid')]);
  }
});
