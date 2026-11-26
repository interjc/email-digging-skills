// Everything printed or thrown goes through sanitizeText (D28): any address-like substring is
// masked, so an error message, a YAML parse error or a sample can never leak a customer address.

import { parseDocument } from 'yaml';
import { maskEmail } from './mask.ts';

// Characters that cannot be part of an address in text we print: whitespace, brackets, quotes,
// separators (ASCII and CJK), and ':' so that "mailto:" stays outside the match. Matching runs on an
// NFKC copy of the text, so compatibility forms of these characters (full-width, small-form) count too.
const STOP = String.raw`\s@<>"'\x60()\[\]{}:,;|`;
const ADDRESS = new RegExp(`[^${STOP}]+@[^${STOP}]+`, 'gu');
// Fragments around an '@' that the first pass could not treat as an address ("name@", "@host").
const FRAGMENT = /\S*@\S*/gu;

/**
 * Replace every match of `re` found in the NFKC form of `text`. `fn` receives the normalized match and
 * the original span; the original span (not the normalized copy) is what gets replaced, so characters
 * outside the matches are never altered.
 */
function replaceNormalized(text: string, re: RegExp, fn: (normalized: string, original: string) => string): string {
  let norm = '';
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < text.length; ) {
    const ch = String.fromCodePoint(text.codePointAt(i) as number);
    const n = ch.normalize('NFKC');
    for (let k = 0; k < n.length; k++) {
      starts.push(i);
      ends.push(i + ch.length);
    }
    norm += n;
    i += ch.length;
  }
  let out = '';
  let last = 0;
  for (const m of norm.matchAll(re)) {
    const first = m.index as number;
    const from = starts[first] as number;
    const to = ends[first + m[0].length - 1] as number;
    if (from < last) continue;
    out += text.slice(last, from) + fn(m[0], text.slice(from, to));
    last = to;
  }
  return out + text.slice(last);
}

/** Mask every address-like substring of `text` (`taro@example.com` → `t***@e***e.com`). */
export function sanitizeText(text: string): string {
  const masked = replaceNormalized(String(text), ADDRESS, (normalized) => maskEmail(normalized));
  // maskEmail answers '***' for anything it does not accept; leftovers with a bare '@' are blanked too.
  return replaceNormalized(masked, FRAGMENT, (_normalized, original) => (original.includes('*') ? original : '***'));
}

/**
 * True when `text` holds an address-like substring that sanitizeText would mask (same NFKC-aware
 * detection; an already-masked `t***@e***e.com` is not an address).
 */
export function containsAddress(text: string): boolean {
  const t = String(text);
  return sanitizeText(t) !== t;
}

/** One-line, sanitized description of any thrown value. */
export function sanitizeError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return sanitizeText(text.split('\n')[0] as string);
}

interface YamlIssueLike {
  code?: string;
  linePos?: Array<{ line: number; col: number }>;
}

/** Describe a YAML error or warning by code and position only: its message quotes the source line. */
export function describeYamlError(err: unknown): string {
  const e = err as YamlIssueLike | null;
  const pos = e?.linePos?.[0];
  const where = pos ? ` at line ${pos.line}, column ${pos.col}` : '';
  return `${e?.code ?? 'parse error'}${where}`;
}

export interface SafeYaml {
  /** The parsed document (null when there are errors). */
  value: unknown;
  /** Error and warning descriptions (code, line, column), never message text or source. */
  errors: string[];
  warnings: string[];
}

/**
 * Parse YAML without letting the parser print anything: the yaml package reports warnings (such as an
 * unresolved tag) on stderr with the offending source line, so this uses a silent document and returns
 * errors and warnings as code + position.
 */
export function parseYamlSafe(text: string): SafeYaml {
  const doc = parseDocument(text, { logLevel: 'silent' });
  const errors = doc.errors.map(describeYamlError);
  let value: unknown = null;
  if (errors.length === 0) {
    try {
      value = doc.toJS({ maxAliasCount: 100 });
    } catch (err) {
      errors.push(sanitizeError(err));
    }
  }
  return { value, errors, warnings: doc.warnings.map(describeYamlError) };
}

/**
 * Sanitize a JSON-able value value by value (strings and object keys through sanitizeText), keeping the
 * structure. Serialize the result afterwards; never run sanitizeText over serialized JSON, which can turn
 * a quoted string into invalid JSON.
 */
export function sanitizeDeep<T>(value: T): T {
  if (typeof value === 'string') return sanitizeText(value) as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[sanitizeText(k)] = sanitizeDeep(v);
    return out as T;
  }
  return value;
}
