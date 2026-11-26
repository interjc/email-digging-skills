// Offline provider-distance typo suggestions (D34). Pure, deterministic, no network.

import providerRules from '../rules/providers.json' with { type: 'json' };

const MIN_DIFFERING_LABEL_LEN = 5;

const DEFAULT_PROVIDERS: readonly string[] = providerRules.providers.map((d) => d.toLowerCase());
const DEFAULT_KNOWN_REAL: readonly string[] = providerRules.known_real.map((d) => d.toLowerCase());
const DEFAULT_PROVIDER_SET = new Set(DEFAULT_PROVIDERS);
const DEFAULT_KNOWN_REAL_SET = new Set(DEFAULT_KNOWN_REAL);

/**
 * Optimal String Alignment (restricted Damerau-Levenshtein) distance between two strings:
 * single-character insertions, deletions, substitutions, and adjacent transpositions each cost 1.
 */
export function damerauLevenshteinOsa(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const cols = n + 1;
  const dp = new Int32Array((m + 1) * cols);
  for (let i = 0; i <= m; i++) dp[i * cols] = i;
  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    const aChar = a.charCodeAt(i - 1);
    const aPrev = i > 1 ? a.charCodeAt(i - 2) : -1;
    for (let j = 1; j <= n; j++) {
      const bChar = b.charCodeAt(j - 1);
      const cost = aChar === bChar ? 0 : 1;
      let best = Math.min(
        (dp[(i - 1) * cols + j] ?? 0) + 1,
        (dp[i * cols + (j - 1)] ?? 0) + 1,
        (dp[(i - 1) * cols + (j - 1)] ?? 0) + cost,
      );
      if (i > 1 && j > 1 && aChar === b.charCodeAt(j - 2) && aPrev === bChar) {
        const trans = (dp[(i - 2) * cols + (j - 2)] ?? 0) + 1;
        if (trans < best) best = trans;
      }
      dp[i * cols + j] = best;
    }
  }
  return dp[m * cols + n] ?? 0;
}

function findDistance1Neighbors(providers: readonly string[]): Set<string> {
  const crowded = new Set<string>();
  for (let i = 0; i < providers.length; i++) {
    const a = providers[i] as string;
    for (let j = i + 1; j < providers.length; j++) {
      const b = providers[j] as string;
      if (damerauLevenshteinOsa(a, b) === 1) {
        crowded.add(a);
        crowded.add(b);
      }
    }
  }
  return crowded;
}

const DEFAULT_CROWDED_PROVIDERS = findDistance1Neighbors(DEFAULT_PROVIDERS);

export interface ProviderLists {
  providers: readonly string[];
  knownReal?: readonly string[];
}

/** True when `domain` is one of the curated public mailbox providers. */
export function isProviderDomain(domain: string): boolean {
  return DEFAULT_PROVIDER_SET.has(domain.trim().toLowerCase());
}

/**
 * Suggest a well-known provider domain for a suspected typo domain, or null when no unambiguous
 * high-confidence suggestion exists:
 * 1. Domain is on either the provider list or the known-real list -> null.
 * 2. Candidates = providers at OSA distance 1 from the full domain.
 * 3. Must have exactly one candidate.
 * 4. That candidate must not be at OSA distance 1 from any other provider.
 * 5. Same number of labels, and the first differing label in the candidate has >= 5 characters.
 */
export function suggestProvider(domain: string, customLists?: ProviderLists): string | null {
  const input = domain.trim().toLowerCase();
  if (input === '') return null;

  const providers = customLists ? customLists.providers.map((d) => d.toLowerCase()) : DEFAULT_PROVIDERS;
  const providerSet = customLists ? new Set(providers) : DEFAULT_PROVIDER_SET;
  const knownRealSet = customLists
    ? new Set((customLists.knownReal ?? []).map((d) => d.toLowerCase()))
    : DEFAULT_KNOWN_REAL_SET;
  const crowded = customLists ? findDistance1Neighbors(providers) : DEFAULT_CROWDED_PROVIDERS;

  if (providerSet.has(input) || knownRealSet.has(input)) return null;

  const candidates: string[] = [];
  for (const provider of providers) {
    if (damerauLevenshteinOsa(input, provider) === 1) {
      candidates.push(provider);
      if (candidates.length > 1) return null;
    }
  }
  const candidate = candidates[0];
  if (candidate === undefined) return null;
  if (crowded.has(candidate)) return null;

  const inputLabels = input.split('.');
  const candidateLabels = candidate.split('.');
  if (inputLabels.length !== candidateLabels.length) return null;

  const diffIndex = candidateLabels.findIndex((label, i) => label !== inputLabels[i]);
  if (diffIndex === -1) return null;
  const differingLabel = candidateLabels[diffIndex] ?? '';
  if (differingLabel.length < MIN_DIFFERING_LABEL_LEN) return null;

  return candidate;
}
