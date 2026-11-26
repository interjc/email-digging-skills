import { createHmac } from 'node:crypto';

const graphemeSegmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

function toGraphemes(value: string): string[] {
  return Array.from(graphemeSegmenter.segment(value), (seg) => seg.segment);
}

/**
 * Mask an email address for logs, reports, and agent-visible summaries (rule R2).
 *
 * Examples:
 * - `'taro@example.com'` -> `'t***@e***e.com'`
 * - `'a@docomo.example.jp'` -> `'a***@d***o.example.jp'`
 * - `'a@me.example'` -> `'a***@m***.example'`
 * - invalid input -> `'***'`
 */
export function maskEmail(email: string): string {
  if (typeof email !== 'string') {
    return '***';
  }
  const trimmed = email.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) {
    return '***';
  }

  const parts = trimmed.split('@');
  if (parts.length !== 2) {
    return '***';
  }
  const local = parts[0] ?? '';
  const domain = parts[1] ?? '';
  if (local.length === 0 || domain.length === 0) {
    return '***';
  }

  const labels = domain.split('.');
  if (labels.length < 2 || labels.some((label) => label.length === 0)) {
    return '***';
  }

  const localGraphemes = toGraphemes(local);
  const firstLocal = localGraphemes[0];
  if (firstLocal === undefined) {
    return '***';
  }
  const maskedLocal = `${firstLocal}***`;

  const firstLabel = labels[0] ?? '';
  const firstLabelGraphemes = toGraphemes(firstLabel);
  const firstLabelStart = firstLabelGraphemes[0];
  if (firstLabelStart === undefined) {
    return '***';
  }
  const maskedFirstLabel =
    firstLabelGraphemes.length <= 2
      ? `${firstLabelStart}***`
      : `${firstLabelStart}***${firstLabelGraphemes[firstLabelGraphemes.length - 1] ?? ''}`;

  const restLabels = labels.slice(1).join('.');
  return `${maskedLocal}@${maskedFirstLabel}.${restLabels}`;
}

/**
 * Mask a personal name (rule R2): first grapheme + one `*` per remaining grapheme,
 * capped at 3 stars. Empty or whitespace-only input returns `''`.
 */
export function maskName(name: string): string {
  if (typeof name !== 'string') {
    return '';
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return '';
  }

  const graphemes = toGraphemes(trimmed);
  const first = graphemes[0] ?? '';
  const remaining = Math.max(0, graphemes.length - 1);
  return `${first}${'*'.repeat(Math.min(remaining, 3))}`;
}

function isPhoneDigit(ch: string): boolean {
  const code = ch.charCodeAt(0);
  // ASCII '0'-'9' or full-width '０'-'９'
  return (code >= 0x30 && code <= 0x39) || (code >= 0xff10 && code <= 0xff19);
}

/**
 * Mask a phone number (rule R2): every digit except the last two becomes `*`,
 * preserving all separators.
 */
export function maskPhone(phone: string): string {
  if (typeof phone !== 'string' || phone.length === 0) {
    return '';
  }

  const chars = Array.from(phone);
  let totalDigits = 0;
  for (const ch of chars) {
    if (isPhoneDigit(ch)) {
      totalDigits += 1;
    }
  }

  const maskCount = Math.max(0, totalDigits - 2);
  let maskedSoFar = 0;
  let out = '';
  for (const ch of chars) {
    if (isPhoneDigit(ch) && maskedSoFar < maskCount) {
      out += '*';
      maskedSoFar += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

function maskAddress(address: string): string {
  const trimmed = address.trim();
  if (trimmed.length === 0) {
    return '';
  }
  const graphemes = toGraphemes(trimmed);
  return `${graphemes.slice(0, 2).join('')}***`;
}

const EMAIL_FIELD_KEYWORDS = ['email', 'mail', 'メール', '邮箱'] as const;
const NAME_FIELD_KEYWORDS = ['name', '氏名', '名前', '姓名'] as const;
const PHONE_FIELD_KEYWORDS = ['phone', 'tel', '電話', '电话'] as const;
const ADDRESS_FIELD_KEYWORDS = ['address', '住所', '地址'] as const;

function matchesAnyKeyword(field: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => field.includes(keyword));
}

/**
 * Mask a field value based on its column/field name (rule R2).
 * Order prioritizes email over address so names like `email_address` are masked as email.
 */
export function maskValue(field: string, value: string): string {
  const normalizedField = field.normalize('NFKC').toLowerCase();

  if (matchesAnyKeyword(normalizedField, EMAIL_FIELD_KEYWORDS)) {
    return maskEmail(value);
  }
  if (matchesAnyKeyword(normalizedField, NAME_FIELD_KEYWORDS)) {
    return maskName(value);
  }
  if (matchesAnyKeyword(normalizedField, PHONE_FIELD_KEYWORDS)) {
    return maskPhone(value);
  }
  if (matchesAnyKeyword(normalizedField, ADDRESS_FIELD_KEYWORDS)) {
    return maskAddress(value);
  }
  return value;
}

/**
 * Pseudonymize an email address using keyed HMAC-SHA256 (rule R2).
 * Throws if `key` is empty or `email` is not a valid `local@domain` string.
 * Never includes the raw email or key in thrown error messages.
 */
export function hmacLocalPart(
  email: string,
  key: string,
  opts?: { keepDomain?: boolean },
): string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('hmacLocalPart: key must be a non-empty string');
  }
  if (typeof email !== 'string') {
    throw new Error('hmacLocalPart: invalid email address');
  }

  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0 || /\s/.test(normalized)) {
    throw new Error('hmacLocalPart: invalid email address');
  }

  const parts = normalized.split('@');
  const local = parts[0] ?? '';
  const domain = parts[1] ?? '';
  if (parts.length !== 2 || local.length === 0 || domain.length === 0) {
    throw new Error('hmacLocalPart: invalid email address');
  }

  const localHex = createHmac('sha256', key)
    .update(normalized)
    .digest('hex')
    .slice(0, 16);

  const keepDomain = opts?.keepDomain ?? true;
  if (keepDomain) {
    return `u${localHex}@${domain}`;
  }

  const domainHex = createHmac('sha256', key)
    .update(`domain:${domain}`)
    .digest('hex')
    .slice(0, 8);
  return `u${localHex}@d${domainHex}.invalid`;
}
