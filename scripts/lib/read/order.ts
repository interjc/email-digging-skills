import path from 'node:path';

/** Sort by name without extension first, so `a.csv` comes before `a (1).csv`. */
export function byNameStem(a: string, b: string): number {
  const sa = a.slice(0, a.length - path.extname(a).length);
  const sb = b.slice(0, b.length - path.extname(b).length);
  if (sa !== sb) return sa < sb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
