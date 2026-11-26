// R4 encoding resolution for text formats. Non-UTF-8 text is decoded in Node (D11) and written as
// UTF-8 so DuckDB only ever reads UTF-8.

import type { DeclaredEncoding, ResolvedEncoding } from '../types.ts';
import { headerSynonymScore } from './synonyms.ts';

const LABELS: Record<ResolvedEncoding, string> = {
  'utf-8': 'utf-8',
  'utf-8-sig': 'utf-8',
  cp932: 'shift_jis', // WHATWG's shift_jis is Windows-31J: decodes ①, ㈱, 髙
  gb18030: 'gb18030',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
};

export interface DecodeOptions {
  /** 1-based header row, used to compare header synonyms when cp932 and gb18030 both decode. */
  headerRow?: number;
}

export interface DecodeResult {
  encoding: ResolvedEncoding;
  how: 'meta' | 'bom' | 'detected';
  /** Encodings that decoded without error, in try order (just the chosen one for `meta` and `bom`). */
  candidates: ResolvedEncoding[];
  /** Decoded text without a BOM. */
  text: string;
}

/** Strict decode. Throws a plain Error when the bytes are not valid in `encoding`. */
export function decodeStrict(bytes: Uint8Array, encoding: ResolvedEncoding): string {
  try {
    // A leading BOM is consumed by the decoder (ignoreBOM stays false), so the text never starts with U+FEFF.
    return new TextDecoder(LABELS[encoding], { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`the bytes are not valid ${encoding}`);
  }
}

function tryDecode(bytes: Uint8Array, encoding: ResolvedEncoding): string | null {
  try {
    return decodeStrict(bytes, encoding);
  } catch {
    return null;
  }
}

export function detectBom(bytes: Uint8Array): ResolvedEncoding | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8-sig';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return null;
}

const KANA = /[぀-ヿ]/;

/** Header cells of the line `headerRow` (1-based), split on the usual delimiters, quotes removed. */
export function headerCells(text: string, headerRow: number): string[] {
  const lines = text.split(/\r\n|\n|\r/);
  const line = lines[Math.max(0, headerRow - 1)] ?? '';
  return line.split(/[,\t;|]/).map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
}

export function decodeBytes(bytes: Uint8Array, declared: DeclaredEncoding, opts: DecodeOptions = {}): DecodeResult {
  // 1. meta.md names an encoding: use it; a decode error is a hard error.
  if (declared !== 'auto') {
    let text: string;
    try {
      text = decodeStrict(bytes, declared);
    } catch (err) {
      throw new Error(`cannot decode as ${declared} (declared in meta.md): ${(err as Error).message}`);
    }
    return { encoding: declared, how: 'meta', candidates: [declared], text };
  }

  // 2. BOM.
  const bom = detectBom(bytes);
  if (bom) {
    let text: string;
    try {
      text = decodeStrict(bytes, bom);
    } catch (err) {
      throw new Error(`the file starts with a ${bom} BOM but ${(err as Error).message}`);
    }
    return { encoding: bom, how: 'bom', candidates: [bom], text };
  }

  // 3. utf-8, then cp932 / gb18030.
  const utf8 = tryDecode(bytes, 'utf-8');
  if (utf8 !== null) return { encoding: 'utf-8', how: 'detected', candidates: ['utf-8'], text: utf8 };

  const cp932 = tryDecode(bytes, 'cp932');
  const gb = tryDecode(bytes, 'gb18030');
  const candidates: ResolvedEncoding[] = [];
  if (cp932 !== null) candidates.push('cp932');
  if (gb !== null) candidates.push('gb18030');
  if (cp932 !== null && gb !== null) {
    const row = opts.headerRow ?? 1;
    const sCp = headerSynonymScore(headerCells(cp932, row));
    const sGb = headerSynonymScore(headerCells(gb, row));
    let pick: ResolvedEncoding;
    if (sCp !== sGb) pick = sCp > sGb ? 'cp932' : 'gb18030';
    else pick = KANA.test(cp932) ? 'cp932' : 'gb18030';
    return { encoding: pick, how: 'detected', candidates, text: pick === 'cp932' ? cp932 : gb };
  }
  if (cp932 !== null) return { encoding: 'cp932', how: 'detected', candidates, text: cp932 };
  if (gb !== null) return { encoding: 'gb18030', how: 'detected', candidates, text: gb };
  throw new Error('cannot decode the file as utf-8, cp932 or gb18030; declare the encoding in meta.md');
}
