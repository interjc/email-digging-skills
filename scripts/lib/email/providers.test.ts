import assert from 'node:assert/strict';
import { test } from 'node:test';
import { damerauLevenshteinOsa, isProviderDomain, suggestProvider } from './providers.ts';

test('damerauLevenshteinOsa computes edits and adjacent transpositions', () => {
  assert.equal(damerauLevenshteinOsa('gmail.com', 'gmail.com'), 0);
  assert.equal(damerauLevenshteinOsa('', 'abc'), 3);
  assert.equal(damerauLevenshteinOsa('abc', ''), 3);
  assert.equal(damerauLevenshteinOsa('gmaill.com', 'gmail.com'), 1); // deletion
  assert.equal(damerauLevenshteinOsa('hotmal.com', 'hotmail.com'), 1); // insertion
  assert.equal(damerauLevenshteinOsa('outlool.com', 'outlook.com'), 1); // substitution
  assert.equal(damerauLevenshteinOsa('icluod.com', 'icloud.com'), 1); // transposition
  assert.equal(damerauLevenshteinOsa('foxmial.com', 'foxmail.com'), 1); // transposition
  assert.equal(damerauLevenshteinOsa('gmailll.com', 'gmail.com'), 2); // distance 2
  // OSA (restricted) treats 'ca' -> 'abc' as 3, not 2
  assert.equal(damerauLevenshteinOsa('ca', 'abc'), 3);
});

test('suggestProvider suggests single-edit and transposition typos of curated providers', () => {
  assert.equal(suggestProvider('gmaill.com'), 'gmail.com');
  assert.equal(suggestProvider('outlool.com'), 'outlook.com');
  assert.equal(suggestProvider('hotmal.com'), 'hotmail.com');
  assert.equal(suggestProvider('icluod.com'), 'icloud.com');
  assert.equal(suggestProvider('foxmial.com'), 'foxmail.com');
  assert.equal(suggestProvider('gmial.com'), 'gmail.com');
  assert.equal(suggestProvider('docom.ne.jp'), 'docomo.ne.jp');
  assert.equal(suggestProvider('yaho.co.jp'), 'yahoo.co.jp');
  assert.equal(suggestProvider('i.softban.jp'), 'i.softbank.jp');
  assert.equal(suggestProvider('GMAILL.COM'), 'gmail.com');
});

test('suggestProvider returns null for providers, known_real domains, and short/ambiguous traps', () => {
  // Known providers themselves must never be suggested
  for (const domain of [
    'gmail.com', 'yahoo.com', 'yahoo.co.jp', 'docomo.ne.jp', 'sina.cn', 'sina.com',
    '126.com', '163.com', 'qq.com', 'me.com', 'i.softbank.jp',
  ]) {
    assert.equal(suggestProvider(domain), null, `provider ${domain} must return null`);
    assert.equal(isProviderDomain(domain), true, `${domain} should be recognized as a provider`);
  }

  // Known-real domains close to providers must never be "corrected"
  for (const domain of [
    'mail.com', 'email.com', 'q.com', 'gmx.com', 'gmx.net',
    'ymail.com', 'rocketmail.com', 'yahoo.co.uk', 'hotmail.co.uk', 'live.jp',
  ]) {
    assert.equal(suggestProvider(domain), null, `known_real ${domain} must return null`);
    assert.equal(isProviderDomain(domain), false, `${domain} is known_real, not a curated provider`);
  }

  // Short differing labels (< 5 chars in candidate) and multi-candidate ties
  assert.equal(suggestProvider('123.com'), null, 'tie between 126.com and 163.com and short label');
  assert.equal(suggestProvider('164.com'), null, 'short differing label 163');
  assert.equal(suggestProvider('qb.com'), null, 'short differing label qq');
  assert.equal(suggestProvider('mx.com'), null, 'short differing label me');
  assert.equal(suggestProvider('gmail.co'), null, 'differing label com has length 3 (< 5); table handles gmail.co');
  assert.equal(suggestProvider('e.softbank.jp'), null, 'differing label i has length 1 (< 5)');

  // Different label count
  assert.equal(suggestProvider('gm.ail.com'), null, 'label count mismatch (3 vs 2)');
  assert.equal(suggestProvider('yahoo.cojp'), null, 'label count mismatch (2 vs 3); table handles yahoo.cojp');

  // Distance 2 or more
  assert.equal(suggestProvider('gmailll.com'), null, 'distance 2 from gmail.com');
  assert.equal(suggestProvider('example.com'), null, 'unrelated domain');
});

test('suggestProvider refuses a candidate that is at OSA distance 1 from another provider', () => {
  const custom = { providers: ['alpha1.com', 'alpha2.com', 'gamma10.com'] };
  // alpha1.com and alpha2.com are at distance 1 from each other, so a typo near alpha1.com is refused
  assert.equal(suggestProvider('alpha1x.com', custom), null);
  // gamma10.com has no distance-1 neighbor in providers, so a distance-1 typo is suggested
  assert.equal(suggestProvider('gamma10x.com', custom), 'gamma10.com');
  // alpha3.com is distance 1 from both alpha1.com and alpha2.com (multiple candidates) -> null
  assert.equal(suggestProvider('alpha3.com', custom), null);
});
