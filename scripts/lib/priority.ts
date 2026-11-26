// Ordering rules used by the merge: source priority (D8), opt-in resolution and file recency.

import type { ConsentBasis, PipelineConfig } from './types.ts';

export interface PriorityInput {
  name: string;
  exported_at: string | null;
}

/**
 * D8: sources listed in `config.sources.priority` first (in that order), then the unlisted ones by
 * `exported_at` descending (nulls last), then by name. Names listed in the config but absent from
 * `sources` are skipped. Returns every source name once, highest priority first.
 */
export function resolvePriority(sources: PriorityInput[], configured: readonly string[]): string[] {
  const byName = new Map<string, PriorityInput>();
  for (const s of sources) if (!byName.has(s.name)) byName.set(s.name, s);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of configured) {
    if (byName.has(name) && !seen.has(name)) {
      out.push(name);
      seen.add(name);
    }
  }
  const rest = [...byName.values()].filter((s) => !seen.has(s.name));
  rest.sort((a, b) => {
    if (a.exported_at !== b.exported_at) {
      if (a.exported_at === null) return 1;
      if (b.exported_at === null) return -1;
      return a.exported_at < b.exported_at ? 1 : -1;
    }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  for (const s of rest) out.push(s.name);
  return out;
}

/** `sources.counts_as_opt_in`: the basis is in consent.opt_in_bases or the name in consent.opt_in_sources. */
export function countsAsOptIn(name: string, basis: ConsentBasis, config: Pick<PipelineConfig, 'consent'>): boolean {
  return config.consent.opt_in_bases.includes(basis) || config.consent.opt_in_sources.includes(name);
}

const FILE_DATE = /(\d{4})-(\d{2})-(\d{2})/;

/** `YYYY-MM-DD` found in a file name when it is a real calendar date, else null. */
export function fileNameDate(name: string): string | null {
  const m = FILE_DATE.exec(name);
  if (!m) return null;
  const s = m[0];
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}

/**
 * Recency rank of each file of a source (higher = newer). Files with a date in their name rank above
 * files without one; dated files order by date, ties and undated files by their position in
 * meta.files (later = newer).
 */
export function fileRanks(files: readonly string[]): Map<string, number> {
  const entries = files.map((name, index) => ({ name, index, date: fileNameDate(name) }));
  entries.sort((a, b) => {
    if ((a.date === null) !== (b.date === null)) return a.date === null ? -1 : 1;
    if (a.date !== null && b.date !== null && a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.index - b.index;
  });
  return new Map(entries.map((e, rank) => [e.name, rank]));
}
