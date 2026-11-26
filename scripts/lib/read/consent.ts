// R3 consent values. Compare after NFKC + trim + lowercase.

import type { ConsentStatus, SourceMeta } from '../types.ts';

export function normalizeConsentToken(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}

export const DEFAULT_GRANTED: readonly string[] = [
  '1', 'true', 'yes', 'y', 'on', '是', '配信する', '配信希望', '希望する', '受け取る', '受信する', '購読', '購読する',
  'subscribed', 'subscribe', 'opt-in', 'optin', '○', '〇', '◯',
];

export const DEFAULT_DENIED: readonly string[] = [
  '0', 'false', 'no', 'n', 'off', '否', '配信しない', '配信停止', '希望しない', '受け取らない', '受信しない', '購読しない',
  'unsubscribed', 'unsubscribe', 'opt-out', 'optout', '×', '✕',
];

export interface ConsentMatcher {
  (raw: string | null | undefined): ConsentStatus;
}

/**
 * Build a matcher. Without `consent_values` the built-in tables apply; with it, only the listed
 * values count (a missing list counts as empty). Anything else, and empty, is unknown.
 */
export function makeConsentMatcher(values?: SourceMeta['consent_values']): ConsentMatcher {
  const granted = new Set((values ? (values.granted ?? []) : DEFAULT_GRANTED).map(normalizeConsentToken));
  const denied = new Set((values ? (values.denied ?? []) : DEFAULT_DENIED).map(normalizeConsentToken));
  return (raw) => {
    if (raw === null || raw === undefined) return 'unknown';
    const t = normalizeConsentToken(raw);
    if (t === '') return 'unknown';
    // A value listed under both: denied wins (the safer reading).
    if (denied.has(t)) return 'denied';
    if (granted.has(t)) return 'granted';
    return 'unknown';
  };
}
