// Everything printed or thrown goes through sanitizeText (D28): any address-like substring is
// masked, so an error message, a YAML parse error or a sample can never leak a customer address.

import { maskEmail } from './mask.ts';

// Characters that cannot be part of an address in text we print: whitespace, brackets, quotes,
// separators (ASCII and CJK), and ':' so that "mailto:" stays outside the match.
const STOP = String.raw`\s@＠<>"'\x60()\[\]{}:,;|、，；：`;
const ADDRESS = new RegExp(`[^${STOP}]+[@＠][^${STOP}]+`, 'gu');
// Fragments around an '@' that the first pass could not treat as an address ("name@", "@host").
const FRAGMENT = /\S*[@＠]\S*/gu;

/** Mask every address-like substring of `text` (`taro@example.com` → `t***@e***e.com`). */
export function sanitizeText(text: string): string {
  const masked = String(text).replace(ADDRESS, (m) => maskEmail(m.normalize('NFKC')));
  // maskEmail answers '***' for anything it does not accept; leftovers with a bare '@' are blanked too.
  return masked.replace(FRAGMENT, (m) => (m.includes('*') ? m : '***'));
}

/** One-line, sanitized description of any thrown value. */
export function sanitizeError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return sanitizeText(text.split('\n')[0] as string);
}

interface YamlErrorLike {
  code?: string;
  linePos?: Array<{ line: number; col: number }>;
}

/** Describe a YAML parse error without echoing the source excerpt the parser puts in its message. */
export function describeYamlError(err: unknown): string {
  const e = err as YamlErrorLike | null;
  const pos = e?.linePos?.[0];
  const where = pos ? ` at line ${pos.line}, column ${pos.col}` : '';
  return `${e?.code ?? 'parse error'}${where}`;
}
