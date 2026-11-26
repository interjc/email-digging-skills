import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectColumns, headerSynonymScore, normalizeHeader } from './synonyms.ts';

const map = (headers: string[], samples: Array<Array<string | null>> = [], metaColumns = {}) =>
  Object.fromEntries(detectColumns({ headers, samples: headers.map((_, i) => samples[i] ?? []), metaColumns }).map((m) => [m.field, m]));

test('normalizeHeader: NFKC, lowercase, drops spaces, underscores, hyphens', () => {
  assert.equal(normalizeHeader('E-Mail Address'), 'emailaddress');
  assert.equal(normalizeHeader('Ｅメール'), 'eメール');
  assert.equal(normalizeHeader('Created_At'), 'createdat');
  assert.equal(normalizeHeader('Submission time'), 'submissiontime');
});

test('R6 exact synonym → 0.9 (English, Japanese, Chinese)', () => {
  let m = map(['Email', 'Name', 'Created At', 'Updated At', 'Locale', 'Newsletter']);
  assert.deepEqual(
    ['email', 'name', 'created_at', 'last_seen_at', 'locale', 'consent'].map((f) => [m[f]?.column, m[f]?.how, m[f]?.confidence]),
    [['Email', 'header_synonym', 0.9], ['Name', 'header_synonym', 0.9], ['Created At', 'header_synonym', 0.9],
      ['Updated At', 'header_synonym', 0.9], ['Locale', 'header_synonym', 0.9], ['Newsletter', 'header_synonym', 0.9]],
  );
  m = map(['メールアドレス', '氏名', '登録日', '最終ログイン', '言語', 'メルマガ配信']);
  assert.equal(m.email?.column, 'メールアドレス');
  assert.equal(m.name?.column, '氏名');
  assert.equal(m.created_at?.column, '登録日');
  assert.equal(m.last_seen_at?.column, '最終ログイン');
  assert.equal(m.locale?.column, '言語');
  assert.equal(m.consent?.column, 'メルマガ配信');
  m = map(['邮箱', '姓名', '注册时间', '最后登录', '语言', '订阅']);
  assert.deepEqual(['email', 'name', 'created_at', 'last_seen_at', 'locale', 'consent'].map((f) => m[f]?.column), ['邮箱', '姓名', '注册时间', '最后登录', '语言', '订阅']);
});

test('R6 contained synonym → 0.7', () => {
  const m = map(['Customer Email Address 2', 'Full name here']);
  assert.equal(m.email?.confidence, 0.7);
  assert.equal(m.email?.column, 'Customer Email Address 2');
  assert.equal(m.name?.confidence, 0.7);
});

test('R6 addendum: submission time / submitted at / 提交时间 map to created_at', () => {
  for (const h of ['Submission time', 'Submitted at', '提交时间', 'submission_time']) {
    const m = map(['Name', 'Email', h]);
    assert.equal(m.created_at?.column, h, h);
    assert.equal(m.created_at?.confidence, 0.9, h);
  }
});

test('R6 content sniff for the email column (>= 50% with @, confidence = share)', () => {
  const m = map(['col_a', 'col_b'], [['x', 'y', 'z'], ['a@example.com', 'b@example.com', 'junk', 'c@example.com']]);
  assert.equal(m.email?.how, 'content_sniff');
  assert.equal(m.email?.column, 'col_b');
  assert.equal(m.email?.confidence, 0.75);
  const low = map(['col_a'], [['a@example.com', 'x', 'y']]);
  assert.equal(low.email?.how, 'none');
  assert.equal(low.email?.column, null);
  // full-width ＠ counts after NFKC
  const fw = map(['x'], [['a＠example.com', 'b＠example.com']]);
  assert.equal(fw.email?.confidence, 1);
  // empty samples are ignored
  assert.equal(map(['x'], [[null, '', '  ', 'a@example.com']]).email?.confidence, 1);
});

test('R6 synonym wins over sniff; sniff is only a fallback', () => {
  const m = map(['Email', 'other'], [['not an address'], ['a@example.com']]);
  assert.equal(m.email?.column, 'Email');
  assert.equal(m.email?.how, 'header_synonym');
});

test('R6 meta.md mapping first (confidence 1), exact then normalized match', () => {
  const m = map(['Contact', 'Full Name', 'when'], [], { email: 'Contact', created_at: 'WHEN' });
  assert.deepEqual([m.email?.column, m.email?.how, m.email?.confidence], ['Contact', 'meta', 1]);
  assert.deepEqual([m.created_at?.column, m.created_at?.how, m.created_at?.confidence], ['when', 'meta', 1]);
  assert.equal(m.name?.how, 'header_synonym');
});

test('R6 meta column missing from the file falls back to auto-detection', () => {
  const m = map(['Email'], [], { email: 'gone' });
  assert.equal(m.email?.column, 'Email');
  assert.equal(m.email?.how, 'header_synonym');
});

test('R6 one header is used for one field only', () => {
  const m = map(['date']);
  assert.equal(m.created_at?.column, 'date');
  assert.equal(m.last_seen_at?.column, null);
  // "update date" prefers the longer last_seen synonym over the shorter created_at "date"
  const u = map(['update_date']);
  assert.equal(u.last_seen_at?.column, 'update_date');
  assert.equal(u.created_at?.column, null);
});

test('R6 no match → how none, confidence 0; six mappings always returned', () => {
  const all = detectColumns({ headers: ['foo', 'bar'], samples: [[], []] });
  assert.equal(all.length, 6);
  assert.ok(all.every((m) => m.how === 'none' && m.column === null && m.confidence === 0));
});

test('headerSynonymScore counts recognizable header cells', () => {
  assert.equal(headerSynonymScore(['メール', '氏名']), 1.8);
  assert.equal(headerSynonymScore(['xyz', 'abc']), 0);
});
