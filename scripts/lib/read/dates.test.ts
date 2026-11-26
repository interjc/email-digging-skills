import { test } from 'node:test';
import assert from 'node:assert/strict';
import { excelSerialToIso, parseDate } from './dates.ts';

test('R5 date formats', () => {
  const table: Array<[string, string | null]> = [
    ['2024-03-05', '2024-03-05'],
    ['2024/03/05', '2024-03-05'],
    ['2024/3/5', '2024-03-05'],
    ['2024.03.05', '2024-03-05'],
    ['2024年3月5日', '2024-03-05'],
    ['２０２４年３月５日', '2024-03-05'], // full-width digits (NFKC)
    ['2024-03-05 9:07', '2024-03-05T09:07:00'],
    ['2024/3/5 09:07:08', '2024-03-05T09:07:08'],
    ['2024年3月5日 23:59', '2024-03-05T23:59:00'],
    ['2024-03-05T10:11:12', '2024-03-05T10:11:12'],
    ['2024-03-05T10:11:12Z', '2024-03-05T10:11:12'], // zone dropped, no conversion
    ['2024-03-05T10:11:12.345+09:00', '2024-03-05T10:11:12'],
    ['2024-03-05T10:11', '2024-03-05T10:11:00'],
    ['  2024-03-05  ', '2024-03-05'],
    // invalid
    ['2024-02-30', null],
    ['2023-02-29', null],
    ['2024-13-01', null],
    ['2024-03-05 24:00', null],
    ['0000-00-00', null],
    ['2024-03/05', null], // mixed separators
    ['03/05/2024', null],
    ['yesterday', null],
    ['', null],
    ['   ', null],
    ['20240305', null], // not an Excel serial range, not R5
  ];
  for (const [input, expected] of table) assert.equal(parseDate(input), expected, `parseDate(${JSON.stringify(input)})`);
  assert.equal(parseDate(null), null);
  assert.equal(parseDate(undefined), null);
});

test('R5 leap day', () => {
  assert.equal(parseDate('2024-02-29'), '2024-02-29');
  assert.equal(parseDate('2000/2/29'), '2000-02-29');
  assert.equal(parseDate('1900-02-29'), null);
});

test('R5 English month names (addendum 2026-11-26)', () => {
  const table: Array<[string, string | null]> = [
    ['June 28, 2025 11:46 AM', '2025-06-28T11:46:00'],
    ['June 28, 2025 11:46 PM', '2025-06-28T23:46:00'],
    ['June 28, 2025', '2025-06-28'],
    ['Jun 28, 2025 11:46 AM', '2025-06-28T11:46:00'],
    ['Jun 28, 2025', '2025-06-28'],
    ['jun 8, 2025 9:05 pm', '2025-06-08T21:05:00'], // case-insensitive
    ['DECEMBER 1, 2024 12:00 AM', '2024-12-01T00:00:00'], // 12 AM = 00
    ['December 1, 2024 12:30 PM', '2024-12-01T12:30:00'], // 12 PM = 12
    ['Sept 3, 2024', '2024-09-03'],
    ['March 5, 2025 11:46 AM', '2025-03-05T11:46:00'], // narrow no-break space before AM (NFKC)
    ['May 31, 2025 1:02:03 PM', '2025-05-31T13:02:03'],
    ['Feb 30, 2025', null],
    ['Foo 28, 2025', null],
    ['June 28, 2025 13:00 PM', null], // 12-hour clock only
    ['June 28, 2025 0:10 AM', null],
  ];
  for (const [input, expected] of table) assert.equal(parseDate(input), expected, `parseDate(${JSON.stringify(input)})`);
});

test('R5 Excel serial numbers (1900 date system)', () => {
  assert.equal(parseDate('45356'), '2024-03-05');
  assert.equal(parseDate('45356.0'), '2024-03-05');
  assert.equal(parseDate('45356.42444444445'), '2024-03-05T10:11:12');
  assert.equal(parseDate('1'), '1900-01-01');
  assert.equal(parseDate('59'), '1900-02-28');
  assert.equal(parseDate('60'), null); // Excel's fake 1900-02-29
  assert.equal(parseDate('61'), '1900-03-01');
  assert.equal(parseDate('25569'), '1970-01-01');
  assert.equal(parseDate('0'), null);
  assert.equal(parseDate('100001'), null);
  assert.equal(excelSerialToIso(45356.99999999), '2024-03-06'); // rounds to the next midnight
});
