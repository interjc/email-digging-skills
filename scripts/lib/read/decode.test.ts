import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeBytes, detectBom } from './decode.ts';
import { GB, SJIS, bytes, utf16be, utf16le } from './testutil.ts';

test('R4 step 1: meta encoding is used; a decode error is a hard error', () => {
  const r = decodeBytes(bytes('name,x\n', SJIS.circled1, SJIS.kabu), 'cp932');
  assert.equal(r.how, 'meta');
  assert.equal(r.encoding, 'cp932');
  assert.ok(r.text.includes('①') && r.text.includes('㈱'));
  assert.throws(() => decodeBytes(bytes([0xff, 0xff, 0x41]), 'utf-8'), /cannot decode as utf-8 \(declared in meta\.md\)/);
});

test('R4 step 1: utf-8-sig strips the BOM; utf-8 declared with a BOM does too', () => {
  const withBom = bytes([0xef, 0xbb, 0xbf], 'email\n');
  assert.equal(decodeBytes(withBom, 'utf-8-sig').text, 'email\n');
  assert.equal(decodeBytes(withBom, 'utf-8').text, 'email\n');
});

test('R4 step 2: BOMs (utf-8-sig, utf-16le, utf-16be)', () => {
  const u8 = decodeBytes(bytes([0xef, 0xbb, 0xbf], 'メール\n'), 'auto');
  assert.deepEqual([u8.encoding, u8.how, u8.text], ['utf-8-sig', 'bom', 'メール\n']);
  const le = decodeBytes(utf16le('メール\tname\n'), 'auto');
  assert.deepEqual([le.encoding, le.how, le.text], ['utf-16le', 'bom', 'メール\tname\n']);
  const be = decodeBytes(utf16be('メール\tname\n'), 'auto');
  assert.deepEqual([be.encoding, be.how, be.text], ['utf-16be', 'bom', 'メール\tname\n']);
  assert.equal(detectBom(bytes('abc')), null);
});

test('R4 step 3: valid UTF-8 (no BOM) is detected as utf-8', () => {
  const r = decodeBytes(bytes('メール,氏名\n'), 'auto');
  assert.deepEqual([r.encoding, r.how, r.candidates], ['utf-8', 'detected', ['utf-8']]);
});

test('R4 step 3: CP932 when UTF-8 fails (①㈱髙 decode as cp932)', () => {
  const r = decodeBytes(bytes(SJIS.mailAddress, ',', SJIS.shimei, '\n', SJIS.circled1, SJIS.kabu, SJIS.takaTall, ',x\n'), 'auto');
  assert.equal(r.encoding, 'cp932');
  assert.equal(r.how, 'detected');
  assert.ok(r.text.includes('メールアドレス,氏名'));
  assert.ok(r.text.includes('①㈱髙'));
});

test('R4 step 3: cp932-only bytes list one candidate', () => {
  // halfwidth katakana followed by an ASCII comma is invalid in gb18030
  const r = decodeBytes(bytes(SJIS.halfKana, ',x\n'), 'auto');
  assert.deepEqual([r.encoding, r.candidates], ['cp932', ['cp932']]);
});

test('R4 step 3: gb18030 with a 4-byte character (cp932 rejects it)', () => {
  const r = decodeBytes(bytes('name,email\n', GB.ext, ',a@example.com\n'), 'auto');
  assert.deepEqual([r.encoding, r.how, r.candidates], ['gb18030', 'detected', ['gb18030']]);
  assert.ok(r.text.includes('\u{20000}'));
});

test('R4 step 3: both cp932 and gb18030 decode → header synonyms decide (Japanese header → cp932)', () => {
  const b = bytes(SJIS.mail, ',', SJIS.shimei, '\nx,y\n');
  const r = decodeBytes(b, 'auto');
  assert.deepEqual(r.candidates, ['cp932', 'gb18030']);
  assert.equal(r.encoding, 'cp932');
  assert.ok(r.text.startsWith('メール,氏名'));
});

test('R4 step 3: both decode → header synonyms decide (Chinese header → gb18030)', () => {
  // 邮箱 followed by one more hanzi: every byte pair is also valid in Shift_JIS
  const b = bytes(GB.youxiang, [0xd3, 0xca], ',x\n1,2\n');
  const r = decodeBytes(b, 'auto');
  assert.deepEqual(r.candidates, ['cp932', 'gb18030']);
  assert.equal(r.encoding, 'gb18030');
  assert.ok(r.text.startsWith('邮箱邮,x'));
});

test('R4 step 3: both decode, headers tie → kana decides (cp932 with kana, gb18030 without)', () => {
  // "name,note" header (ASCII), body has Japanese kana in Shift_JIS: メ = 83 81
  const withKana = decodeBytes(bytes('name,note\nx,', SJIS.mail, '\n'), 'auto');
  assert.deepEqual(withKana.candidates, ['cp932', 'gb18030']);
  assert.equal(withKana.encoding, 'cp932');
  // body bytes without kana in the cp932 reading: 邮箱 (D3 CA CF E4) + D3 CA
  const noKana = decodeBytes(bytes('name,note\nx,', GB.youxiang, [0xd3, 0xca], '\n'), 'auto');
  assert.deepEqual(noKana.candidates, ['cp932', 'gb18030']);
  assert.equal(noKana.encoding, 'gb18030');
});

test('R4: header_row selects which line is scored', () => {
  const b = bytes('Exported by someone\n', SJIS.mail, ',', SJIS.shimei, '\n');
  const r = decodeBytes(b, 'auto', { headerRow: 2 });
  assert.equal(r.encoding, 'cp932');
});

test('R4: nothing decodes → error telling to declare the encoding', () => {
  assert.throws(() => decodeBytes(bytes([0xff, 0xff, 0xff]), 'auto'), /declare the encoding in meta\.md/);
});

test('R4: BOM that contradicts the content is an error', () => {
  assert.throws(() => decodeBytes(bytes([0xef, 0xbb, 0xbf, 0xff, 0xff]), 'auto'), /BOM/);
});
