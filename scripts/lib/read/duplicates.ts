// R9: find files with the same headers (order ignored) and the same rows (after reordering columns).

import crypto from 'node:crypto';
import type { FileProbe, MetaFile } from '../types.ts';
import { byNameStem } from './order.ts';
import { readRows } from './index.ts';

/** Content fingerprint independent of column order and row order. */
export async function fingerprintFile(file: string, meta: MetaFile, probe: FileProbe, decodedDir?: string): Promise<string> {
  const headers = [...probe.headers].sort();
  const rowHashes: string[] = [];
  for await (const { cells } of readRows(file, meta, probe, { decodedDir })) {
    const h = crypto.createHash('sha256');
    for (const k of headers) h.update(JSON.stringify(cells[k] ?? null) + '\u0000');
    rowHashes.push(h.digest('hex'));
  }
  rowHashes.sort();
  const all = crypto.createHash('sha256');
  all.update(JSON.stringify(headers));
  for (const r of rowHashes) all.update(r);
  return all.digest('hex');
}

export interface DuplicateInput {
  name: string;
  path: string;
  meta: MetaFile;
  probe: FileProbe;
}

/** Map duplicate file name → the first file (by name) with identical content. */
export async function findDuplicates(files: DuplicateInput[], decodedDir?: string): Promise<Map<string, string>> {
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const fp = await fingerprintFile(f.path, f.meta, f.probe, decodedDir);
    const list = groups.get(fp) ?? [];
    list.push(f.name);
    groups.set(fp, list);
  }
  const dups = new Map<string, string>();
  for (const names of groups.values()) {
    if (names.length < 2) continue;
    const sorted = [...names].sort(byNameStem);
    for (const n of sorted.slice(1)) dups.set(n, sorted[0] as string);
  }
  return dups;
}
