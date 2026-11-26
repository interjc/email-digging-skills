// R6 column auto-detection: header synonyms, content sniffing, and meta.md overrides.

import type { ColumnMapping, SourceMeta, StandardField } from '../types.ts';
import { STANDARD_FIELDS } from '../types.ts';

/** Compare headers after NFKC + lowercase, removing spaces, `_` and `-`. */
export function normalizeHeader(h: string): string {
  return h.normalize('NFKC').toLowerCase().replace(/[\s_\-　]+/g, '');
}

export const SYNONYMS: Record<StandardField, string[]> = {
  email: ['email', 'e-mail', 'mail', 'mailaddress', 'emailaddress', 'メール', 'メールアドレス', 'eメール', '邮箱', '电子邮件', '邮件地址', '电邮'],
  name: ['name', 'fullname', 'displayname', 'username', '氏名', '名前', 'お名前', '姓名', '名字', '用户名', '联系人'],
  created_at: ['createdat', 'created', 'registeredat', 'signupdate', 'signedupat', 'joined', 'date', '登録日', '登録日時', '申込日', '申込日時', '作成日', '注册时间', '注册日期', '创建时间', 'submissiontime', 'submittedat', '提交时间'],
  last_seen_at: ['updatedat', 'lastseen', 'lastlogin', 'lastloginat', 'lastactive', '最終ログイン', '最終ログイン日時', '更新日', '更新日時', '最后登录', '最后登录时间'],
  locale: ['locale', 'language', 'lang', '言語', '语言'],
  consent: ['consent', 'newsletter', 'optin', 'subscribe', 'subscribed', 'marketing', 'メルマガ', 'メルマガ配信', 'メールマガジン', '配信希望', 'ニュースレター', '订阅', '订阅邮件', '接收邮件'],
};

const NORMALIZED: Record<StandardField, string[]> = Object.fromEntries(
  STANDARD_FIELDS.map((f) => [f, SYNONYMS[f].map(normalizeHeader)]),
) as Record<StandardField, string[]>;

export const EXACT_CONFIDENCE = 0.9;
export const CONTAINS_CONFIDENCE = 0.7;
export const REVIEW_THRESHOLD = 0.8;

interface Candidate { field: StandardField; col: number; confidence: number; synLen: number }

function synonymCandidates(headers: string[]): Candidate[] {
  const out: Candidate[] = [];
  headers.forEach((h, col) => {
    const n = normalizeHeader(h);
    if (n === '') return;
    for (const field of STANDARD_FIELDS) {
      for (const syn of NORMALIZED[field]) {
        if (n === syn) out.push({ field, col, confidence: EXACT_CONFIDENCE, synLen: syn.length });
        else if (n.includes(syn)) out.push({ field, col, confidence: CONTAINS_CONFIDENCE, synLen: syn.length });
      }
    }
  });
  return out;
}

/** How many header cells look like a known column name; used to choose between encodings (R4). */
export function headerSynonymScore(cells: string[]): number {
  let score = 0;
  for (const c of cells) {
    const best = synonymCandidates([c]).reduce((m, x) => Math.max(m, x.confidence), 0);
    score += best;
  }
  return score;
}

/** Find a header by exact name, then by normalized name (NFKC, lowercase, trimmed). */
export function findHeader(headers: string[], wanted: string): number {
  const exact = headers.indexOf(wanted);
  if (exact >= 0) return exact;
  const norm = (s: string) => s.normalize('NFKC').trim().toLowerCase();
  const w = norm(wanted);
  return headers.findIndex((h) => norm(h) === w);
}

export interface DetectInput {
  headers: string[];
  /** Up to 200 non-empty sample values per column index (for the email content sniff). */
  samples: Array<Array<string | null>>;
  /** `columns` of meta.md. A named column that is not among the headers falls back to auto-detection. */
  metaColumns?: SourceMeta['columns'];
}

/** One mapping per standard field, in STANDARD_FIELDS order (unmapped fields have how 'none'). */
export function detectColumns(input: DetectInput): ColumnMapping[] {
  const { headers, samples, metaColumns = {} } = input;
  const byField = new Map<StandardField, ColumnMapping>();
  const used = new Set<number>();

  // 1. meta.md names win (confidence 1).
  for (const field of STANDARD_FIELDS) {
    const wanted = metaColumns[field];
    if (typeof wanted !== 'string' || wanted.trim() === '') continue;
    const col = findHeader(headers, wanted);
    if (col < 0) continue;
    byField.set(field, { field, column: headers[col] as string, how: 'meta', confidence: 1 });
    used.add(col);
  }

  // 2. Header synonyms: best confidence first, then longest synonym, then field order, then leftmost column.
  const cands = synonymCandidates(headers).sort((a, b) =>
    b.confidence - a.confidence || b.synLen - a.synLen ||
    STANDARD_FIELDS.indexOf(a.field) - STANDARD_FIELDS.indexOf(b.field) || a.col - b.col);
  for (const c of cands) {
    if (byField.has(c.field) || used.has(c.col)) continue;
    byField.set(c.field, { field: c.field, column: headers[c.col] as string, how: 'header_synonym', confidence: c.confidence });
    used.add(c.col);
  }

  // 3. Email fallback: the column whose first 200 non-empty values contain `@` most often, if >= 50%.
  if (!byField.has('email')) {
    let bestCol = -1;
    let bestShare = 0;
    headers.forEach((_, col) => {
      if (used.has(col)) return;
      const vals = (samples[col] ?? []).filter((v): v is string => v !== null && v.trim() !== '').slice(0, 200);
      if (vals.length === 0) return;
      const share = vals.filter((v) => v.normalize('NFKC').includes('@')).length / vals.length;
      if (share > bestShare) { bestShare = share; bestCol = col; }
    });
    if (bestCol >= 0 && bestShare >= 0.5) {
      byField.set('email', { field: 'email', column: headers[bestCol] as string, how: 'content_sniff', confidence: Math.round(bestShare * 100) / 100 });
    }
  }

  return STANDARD_FIELDS.map((f) => byField.get(f) ?? { field: f, column: null, how: 'none' as const, confidence: 0 });
}
