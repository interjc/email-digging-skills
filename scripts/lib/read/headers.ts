// Headers as they may be printed (D28). A header row that contains an address is almost certainly a
// data row (wrong header_row), so none of its text is printed.

import { containsAddress, sanitizeText } from '../sanitize.ts';

export function headerHasAddress(headers: string[]): boolean {
  // containsAddress is NFKC-aware (＠ U+FF20 and ﹫ U+FE6B fold to '@'): the detection sanitizeText uses
  return headers.some(containsAddress);
}

/** `<col N>` (1-based) for every header when one looks like an address; else sanitized and shortened to 60 characters. */
export function printableHeaders(headers: string[]): string[] {
  if (headerHasAddress(headers)) return headers.map((_, i) => `<col ${i + 1}>`);
  return headers.map((h) => {
    const clean = sanitizeText(h);
    return clean.length > 60 ? `${clean.slice(0, 57)}...` : clean;
  });
}
