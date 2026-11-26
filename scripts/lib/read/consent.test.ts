import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DENIED, DEFAULT_GRANTED, makeConsentMatcher } from './consent.ts';

test('R3 defaults: every listed granted/denied value', () => {
  const m = makeConsentMatcher();
  for (const v of DEFAULT_GRANTED) assert.equal(m(v), 'granted', v);
  for (const v of DEFAULT_DENIED) assert.equal(m(v), 'denied', v);
});

test('R3 normalization: NFKC, trim, case', () => {
  const m = makeConsentMatcher();
  assert.equal(m('  YES '), 'granted');
  assert.equal(m('Y'), 'granted');
  assert.equal(m('１'), 'granted'); // full-width digit
  assert.equal(m('ＴＲＵＥ'), 'granted');
  assert.equal(m('Opt-Out'), 'denied');
  assert.equal(m('　×　'), 'denied');
  assert.equal(m('Unsubscribed'), 'denied');
  assert.equal(m('配信する'), 'granted');
  assert.equal(m('配信停止'), 'denied');
});

test('R3 unknown: other values, empty, null', () => {
  const m = makeConsentMatcher();
  for (const v of ['maybe', '2', '', '   ', null, undefined, '未回答']) assert.equal(m(v), 'unknown', String(v));
});

test('R3 meta override: only the listed values count', () => {
  const m = makeConsentMatcher({ granted: ['済', 'OK'], denied: ['停止'] });
  assert.equal(m('済'), 'granted');
  assert.equal(m('ok'), 'granted');
  assert.equal(m('停止'), 'denied');
  assert.equal(m('yes'), 'unknown'); // built-in default no longer applies
  assert.equal(m('0'), 'unknown');
  // A missing list counts as empty.
  const onlyGranted = makeConsentMatcher({ granted: ['1'] });
  assert.equal(onlyGranted('1'), 'granted');
  assert.equal(onlyGranted('0'), 'unknown');
});

test('R3: a value listed as both granted and denied is denied', () => {
  const m = makeConsentMatcher({ granted: ['x'], denied: ['x'] });
  assert.equal(m('x'), 'denied');
});
