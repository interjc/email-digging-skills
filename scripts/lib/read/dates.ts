// R5 date parsing. Output is `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm:ss`, never converted between time zones.

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

function validDate(y: number, m: number, d: number): boolean {
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1) return false;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate(); // days in month m (1-based) of year y
  return d <= dim;
}

function validTime(h: number, mi: number, s: number): boolean {
  return h >= 0 && h <= 23 && mi >= 0 && mi <= 59 && s >= 0 && s <= 59;
}

function format(y: number, m: number, d: number, time: [number, number, number] | null): string | null {
  if (!validDate(y, m, d)) return null;
  const date = `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
  if (time === null) return date;
  if (!validTime(...time)) return null;
  return `${date}T${pad(time[0])}:${pad(time[1])}:${pad(time[2])}`;
}

// 2024-03-05, 2024/3/5, 2024.03.05 (same separator twice), optionally followed by ` H:mm[:ss]`
// or an ISO-8601 `T` time with fraction and zone (the zone is dropped, not converted).
const NUMERIC = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?:(?:[ T]+)(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;
const JAPANESE = /^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
// June 28, 2025 11:46 AM / Jun 28, 2025 / june 28 2025 (month names and 3-letter forms, 12-hour clock).
const MONTH_NAME = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])\.?[Mm]\.?)?$/;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function monthNumber(name: string): number | null {
  const n = name.toLowerCase();
  const i = MONTHS.findIndex((full) => full === n || full.slice(0, 3) === n || (n === 'sept' && full === 'september'));
  return i < 0 ? null : i + 1;
}

const SERIAL = /^\d{1,6}(?:\.\d+)?$/;

/** Excel serial number (1900 date system, including its fake 1900-02-29) to ISO text. */
export function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 100000) return null;
  if (serial >= 60 && serial < 61) return null; // the non-existent 1900-02-29
  const totalSeconds = Math.round(serial * 86400);
  const days = Math.floor(totalSeconds / 86400);
  const secs = totalSeconds - days * 86400;
  // Serial 61 = 1900-03-01. Before the fake leap day, serial 1 = 1900-01-01.
  const base = days >= 61 ? Date.UTC(1899, 11, 30) : Date.UTC(1899, 11, 31);
  const dt = new Date(base + days * 86400000);
  const time: [number, number, number] | null =
    secs === 0 ? null : [Math.floor(secs / 3600), Math.floor((secs % 3600) / 60), secs % 60];
  return format(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), time);
}

/**
 * Parse one cell of a date column. Unparseable or empty → null (the raw value stays in raw_fields).
 * Numbers are treated as Excel serials (1–100000), so call this only for date columns.
 */
export function parseDate(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const v = value.normalize('NFKC').trim();
  if (v === '') return null;

  let m = NUMERIC.exec(v);
  if (m) {
    const time: [number, number, number] | null = m[5] === undefined ? null : [Number(m[5]), Number(m[6]), Number(m[7] ?? 0)];
    return format(Number(m[1]), Number(m[3]), Number(m[4]), time);
  }
  m = JAPANESE.exec(v);
  if (m) {
    const time: [number, number, number] | null = m[4] === undefined ? null : [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
    return format(Number(m[1]), Number(m[2]), Number(m[3]), time);
  }
  m = MONTH_NAME.exec(v);
  if (m) {
    const month = monthNumber(m[1] as string);
    if (month === null) return null;
    let time: [number, number, number] | null = null;
    if (m[4] !== undefined) {
      const h12 = Number(m[4]);
      if (h12 < 1 || h12 > 12) return null;
      const pm = (m[7] as string).toLowerCase() === 'p';
      time = [(h12 % 12) + (pm ? 12 : 0), Number(m[5]), Number(m[6] ?? 0)];
    }
    return format(Number(m[3]), month, Number(m[2]), time);
  }
  if (SERIAL.test(v)) return excelSerialToIso(Number(v));
  return null;
}
