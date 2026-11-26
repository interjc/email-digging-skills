// Merge staged sources into the main SQLite database (D3, D8, D14, D15, D22, D23, D30).
// One transaction per call; the caller makes the backup first (backupDb) and creates the runs row.
// D30: a real merge always gets every source with a meta.md, so contact fields, contact_sources and
// consents are a full recompute from the current inputs. Sources whose directory (or meta.md) is gone
// keep their contact_sources / consents rows unchanged (D23) and do not contribute contact fields.
// Nothing is ever deleted from contacts or suppressions.

import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ConsentBasis, ConsentStatus, EmailStatus, Flag, MergeStats, Overrides, PipelineConfig, RejectReason,
  SourceKind, SourceMeta, SourceStageResult,
} from './types.ts';
import { connect, ensureExtension, sqlStr } from './read/duck.ts';
import { normalizeEmailCell } from './email/normalize.ts';
import { maskEmail } from './mask.ts';
import { countsAsOptIn, fileRanks, resolvePriority } from './priority.ts';

// ---------------------------------------------------------------------------
// Staged data (rows.parquet / rejected.parquet written by stage.ts)
// ---------------------------------------------------------------------------

export interface StagedRecord {
  source: string;
  file: string;
  row_number: number;
  split_index: number;
  raw_email: string;
  email: string;
  email_domain: string;
  email_status: EmailStatus;
  flags: Flag[];
  suggested_email: string | null;
  name: string | null;
  locale: string | null;
  created_at: string | null;
  last_seen_at: string | null;
  consent_raw: string | null;
  consent_status: ConsentStatus;
  /** JSON object text, exactly as staged. */
  raw_fields: string;
}

export interface RejectedRecord {
  source: string;
  file: string;
  row_number: number;
  raw_value: string | null;
  reason: RejectReason;
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

async function readParquet(file: string): Promise<Array<Record<string, unknown>>> {
  if (!fs.existsSync(file)) throw new Error(`staged file not found: ${file} (stage the source first)`);
  await ensureExtension('parquet');
  const conn = await connect();
  try {
    const reader = await conn.runAndReadAll(`SELECT * FROM read_parquet(${sqlStr(file)})`);
    return reader.getRowObjectsJson() as Array<Record<string, unknown>>;
  } finally {
    conn.closeSync();
  }
}

/** All rows of `<stagingDir>/rows.parquet`, ordered by file, row_number, split_index. */
export async function readStagedRows(stagingDir: string): Promise<StagedRecord[]> {
  const rows = (await readParquet(path.join(stagingDir, 'rows.parquet'))).map((r): StagedRecord => ({
    source: String(r.source),
    file: String(r.file),
    row_number: Number(r.row_number),
    split_index: Number(r.split_index ?? 0),
    raw_email: String(r.raw_email ?? ''),
    email: String(r.email),
    email_domain: String(r.email_domain),
    email_status: String(r.email_status) as EmailStatus,
    flags: (Array.isArray(r.flags) ? r.flags.map(String) : []) as Flag[],
    suggested_email: str(r.suggested_email),
    name: str(r.name),
    locale: str(r.locale),
    created_at: str(r.created_at),
    last_seen_at: str(r.last_seen_at),
    consent_raw: str(r.consent_raw),
    consent_status: (str(r.consent_status) ?? 'unknown') as ConsentStatus,
    raw_fields: str(r.raw_fields) ?? '{}',
  }));
  return rows.sort((a, b) => cmp(a.file, b.file) || a.row_number - b.row_number || a.split_index - b.split_index);
}

/** All rows of `<stagingDir>/rejected.parquet`, ordered by file and row_number. */
export async function readRejectedRows(stagingDir: string): Promise<RejectedRecord[]> {
  const rows = (await readParquet(path.join(stagingDir, 'rejected.parquet'))).map((r): RejectedRecord => ({
    source: String(r.source),
    file: String(r.file),
    row_number: Number(r.row_number),
    raw_value: str(r.raw_value),
    reason: String(r.reason) as RejectReason,
  }));
  return rows.sort((a, b) => cmp(a.file, b.file) || a.row_number - b.row_number);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// runs bookkeeping (the merge's rejected_rows / imports reference runs.id)
// ---------------------------------------------------------------------------

/** Insert a `runs` row with status running. */
export function startRun(db: DatabaseSync, runId: string, command: string, startedAt: string): void {
  db.prepare("INSERT INTO runs (id, command, started_at, finished_at, status, report_path) VALUES (?, ?, ?, NULL, 'running', NULL)")
    .run(runId, command, startedAt);
}

/** Mark a run ok or failed. */
export function finishRun(db: DatabaseSync, runId: string, status: 'ok' | 'failed', finishedAt: string, reportPath: string | null): void {
  db.prepare('UPDATE runs SET status = ?, finished_at = ?, report_path = ? WHERE id = ?').run(status, finishedAt, reportPath, runId);
}

/** Record the report of a run (set after the report files were written). */
export function setRunReportPath(db: DatabaseSync, runId: string, reportPath: string): void {
  db.prepare('UPDATE runs SET report_path = ? WHERE id = ?').run(reportPath, runId);
}

/** `base`, or `base-1`, `base-2` ... when a run with that id already exists. */
export function uniqueRunId(db: DatabaseSync, base: string): string {
  const exists = db.prepare('SELECT 1 AS x FROM runs WHERE id = ?');
  let id = base;
  for (let n = 1; exists.get(id) !== undefined; n++) id = `${base}-${n}`;
  return id;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export interface MergeOptions {
  db: DatabaseSync;
  config: PipelineConfig;
  /** meta.md of every source in `results` (others are ignored). */
  metas: SourceMeta[];
  overrides: Overrides;
  runId: string;
  /** ISO-8601 timestamp used for created_at / updated_at / orphaned_at / imported_at. */
  now: string;
  /** Put into MergeStats.backup_path (the caller made the backup). */
  backupPath?: string | null;
  /**
   * Source directory names currently under resources/ (with or without meta.md). Used only for the
   * wording of the warning about database sources that are not merged (their rows are kept, D23).
   */
  resourceSources?: string[];
  /** Receives warnings for the report (already masked). */
  onWarning?: (message: string) => void;
}

interface StagedSource {
  result: SourceStageResult;
  meta: SourceMeta;
  rows: StagedRecord[];
  rejected: RejectedRecord[];
  ranks: Map<string, number>;
  /** file → original consent column name (null when the file had none). */
  consentColumn: Map<string, string | null>;
}

interface SourceRow {
  name: string;
  kind: SourceKind;
  label: string | null;
  consent_basis: ConsentBasis;
  counts_as_opt_in: number;
  priority: number;
  exported_at: string | null;
  updated_at: string;
}

interface ContactRow {
  id: number;
  email: string;
  email_domain: string;
  name: string | null;
  locale: string | null;
  email_status: EmailStatus;
  suggested_email: string | null;
  flags: string;
  first_seen_at: string | null;
  orphaned_at: string | null;
}

interface ConsentRow {
  contact_id: number;
  source: string;
  status: ConsentStatus;
  evidence: string | null;
  recorded_at: string | null;
}

/** Normalized form of an address written by a human in an override file. */
export function normalizeOverrideEmail(email: string): string {
  const c = normalizeEmailCell(email)[0];
  return c?.email ?? email.trim().toLowerCase();
}

const isEmpty = (v: string | null | undefined): boolean => v === null || v === undefined || v.trim() === '';

function rank(src: StagedSource, file: string): number {
  return src.ranks.get(file) ?? -1;
}

/** Representative row: newest file, then lowest row_number (then split_index). */
function representative(src: StagedSource, rows: StagedRecord[]): StagedRecord {
  let best = rows[0] as StagedRecord;
  for (const r of rows) {
    const d = rank(src, r.file) - rank(src, best.file);
    if (d > 0 || (d === 0 && (r.row_number < best.row_number || (r.row_number === best.row_number && r.split_index < best.split_index)))) {
      best = r;
    }
  }
  return best;
}

function minStr(values: Array<string | null>): string | null {
  let out: string | null = null;
  for (const v of values) if (v !== null && (out === null || v < out)) out = v;
  return out;
}

function maxStr(values: Array<string | null>): string | null {
  let out: string | null = null;
  for (const v of values) if (v !== null && (out === null || v > out)) out = v;
  return out;
}

function statusFromFlags(flags: readonly string[]): EmailStatus {
  if (flags.includes('typo_suspect')) return 'typo_suspect';
  if (flags.includes('role_address')) return 'role';
  return 'valid';
}

/** D22: last entry per key wins; a key given more than once gets one warning. */
function dedupeLast<T>(entries: T[], key: (e: T) => string, warnDup: (e: T) => void): T[] {
  const map = new Map<string, T>();
  const counts = new Map<string, number>();
  for (const e of entries) {
    const k = key(e);
    map.delete(k); // keep insertion order of the last occurrence
    map.set(k, e);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const [k, n] of counts) if (n > 1) warnDup(map.get(k) as T);
  return [...map.values()];
}

/**
 * Merge every staged source in `results` into the database. See docs/agent-team/briefs/T7.md for the
 * rules. Reads the Parquet files first, then writes in a single transaction (rolled back on error).
 */
export async function mergeStaged(results: SourceStageResult[], opts: MergeOptions): Promise<MergeStats> {
  const metaByName = new Map(opts.metas.map((m) => [m.source, m]));
  const seen = new Set<string>();
  const staged: StagedSource[] = [];
  for (const result of results) {
    if (seen.has(result.source)) throw new Error(`source "${result.source}" was staged twice`);
    seen.add(result.source);
    const meta = metaByName.get(result.source);
    if (!meta) throw new Error(`no meta.md loaded for staged source "${result.source}"`);
    const consentColumn = new Map<string, string | null>();
    for (const f of result.files) consentColumn.set(f.file, f.mappings.find((m) => m.field === 'consent')?.column ?? null);
    staged.push({
      result, meta,
      rows: await readStagedRows(result.dir),
      rejected: await readRejectedRows(result.dir),
      ranks: fileRanks(meta.files.map((f) => f.name)),
      consentColumn,
    });
  }

  const { db } = opts;
  db.exec('BEGIN');
  try {
    const stats = mergeInTransaction(staged, opts);
    db.exec('COMMIT');
    return stats;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // nothing to roll back
    }
    throw err;
  }
}

function mergeInTransaction(staged: StagedSource[], opts: MergeOptions): MergeStats {
  const { db, config, now, runId } = opts;
  const warn = (m: string) => opts.onWarning?.(m);
  const processed = new Set(staged.map((s) => s.meta.source));
  const bySource = new Map(staged.map((s) => [s.meta.source, s]));

  // 1. sources ------------------------------------------------------------------------------------
  const dbSources = new Map(
    (db.prepare('SELECT name, kind, label, consent_basis, counts_as_opt_in, priority, exported_at, updated_at FROM sources').all() as unknown as SourceRow[])
      .map((r) => [r.name, r]),
  );
  const priorityInput = [
    ...[...dbSources.values()].filter((r) => !processed.has(r.name)).map((r) => ({ name: r.name, exported_at: r.exported_at })),
    ...staged.map((s) => ({ name: s.meta.source, exported_at: s.meta.exported_at })),
  ];
  const order = resolvePriority(priorityInput, config.sources.priority);
  for (const name of config.sources.priority) {
    if (!order.includes(name)) warn(`config.yaml sources.priority lists "${name}", which is not a known source`);
  }
  const prio = new Map(order.map((n, i) => [n, i + 1]));
  const resources = new Set(opts.resourceSources ?? []);
  for (const name of dbSources.keys()) {
    if (processed.has(name)) continue;
    warn(resources.has(name)
      ? `source "${name}" is in the database but resources/${name}/ has no meta.md any more; its rows are kept`
      : `source "${name}" is in the database but no longer in resources/; its rows are kept`);
  }

  const upsertSource = db.prepare(`
    INSERT INTO sources (name, kind, label, consent_basis, counts_as_opt_in, priority, exported_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (name) DO UPDATE SET kind = excluded.kind, label = excluded.label,
      consent_basis = excluded.consent_basis, counts_as_opt_in = excluded.counts_as_opt_in,
      priority = excluded.priority, exported_at = excluded.exported_at, updated_at = excluded.updated_at`);
  for (const name of order) {
    const old = dbSources.get(name);
    const meta = bySource.get(name)?.meta;
    const want = meta
      ? { kind: meta.kind, label: meta.label, consent_basis: meta.consent_basis, exported_at: meta.exported_at }
      : { kind: (old as SourceRow).kind, label: (old as SourceRow).label, consent_basis: (old as SourceRow).consent_basis, exported_at: (old as SourceRow).exported_at };
    const optIn = countsAsOptIn(name, want.consent_basis, config) ? 1 : 0;
    const p = prio.get(name) as number;
    const same = old !== undefined && old.kind === want.kind && old.label === want.label && old.consent_basis === want.consent_basis &&
      Number(old.counts_as_opt_in) === optIn && Number(old.priority) === p && old.exported_at === want.exported_at;
    if (!same) upsertSource.run(name, want.kind, want.label, want.consent_basis, optIn, p, want.exported_at, now);
  }

  // 2. group staged rows by address and source ----------------------------------------------------
  const byEmail = new Map<string, Map<string, StagedRecord[]>>();
  for (const s of staged) {
    for (const r of s.rows) {
      let perSource = byEmail.get(r.email);
      if (!perSource) byEmail.set(r.email, (perSource = new Map()));
      let list = perSource.get(s.meta.source);
      if (!list) perSource.set(s.meta.source, (list = []));
      list.push(r);
    }
  }

  // 3. contacts -----------------------------------------------------------------------------------
  const existing = new Map(
    (db.prepare('SELECT id, email, email_domain, name, locale, email_status, suggested_email, flags, first_seen_at, orphaned_at FROM contacts').all() as unknown as ContactRow[])
      .map((c) => [c.email, { ...c, id: Number(c.id) }]),
  );

  const insertContact = db.prepare(`
    INSERT INTO contacts (email, email_domain, name, locale, email_status, suggested_email, flags, first_seen_at, orphaned_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`);
  const updateContact = db.prepare(`
    UPDATE contacts SET email_domain = ?, name = ?, locale = ?, email_status = ?, suggested_email = ?, flags = ?,
      orphaned_at = NULL, updated_at = ? WHERE id = ?`);

  const contactId = new Map<string, number>();
  let contactsNew = 0;
  const emails = [...byEmail.keys()].sort(cmp);
  for (const email of emails) {
    const perSource = byEmail.get(email) as Map<string, StagedRecord[]>;
    const old = existing.get(email);

    interface Candidate { prio: number; name: string | null; locale: string | null; suggestion: string | null }
    const candidates: Candidate[] = [];
    const flagSet = new Set<string>();
    let domain = '';
    for (const [source, rows] of perSource) {
      const src = bySource.get(source) as StagedSource;
      const rep = representative(src, rows);
      const typoRows = rows.filter((r) => r.suggested_email !== null);
      candidates.push({
        prio: prio.get(source) as number,
        name: rep.name,
        locale: rep.locale,
        suggestion: typoRows.length > 0 ? representative(src, typoRows).suggested_email : null,
      });
      for (const r of rows) for (const f of r.flags) flagSet.add(f);
      domain = rep.email_domain;
    }
    candidates.sort((a, b) => a.prio - b.prio);
    const name = candidates.find((c) => !isEmpty(c.name))?.name ?? null;
    const locale = candidates.find((c) => !isEmpty(c.locale))?.locale ?? null;
    const flags = [...flagSet].sort();
    const status = statusFromFlags(flags);
    const suggested = status === 'typo_suspect' ? (candidates.find((c) => c.suggestion !== null)?.suggestion ?? null) : null;
    const flagsJson = JSON.stringify(flags);

    if (!old) {
      const res = insertContact.run(email, domain, name, locale, status, suggested, flagsJson, now, now);
      contactId.set(email, Number(res.lastInsertRowid));
      contactsNew++;
    } else {
      contactId.set(email, old.id);
      const changed = old.email_domain !== domain || old.name !== name || old.locale !== locale || old.email_status !== status ||
        old.suggested_email !== suggested || old.flags !== flagsJson || old.orphaned_at !== null;
      if (changed) updateContact.run(domain, name, locale, status, suggested, flagsJson, now, old.id);
    }
  }

  // 4. contact_sources ----------------------------------------------------------------------------
  const delCs = db.prepare('DELETE FROM contact_sources WHERE source = ?');
  for (const s of processed) delCs.run(s);
  const insCs = db.prepare(`
    INSERT INTO contact_sources (contact_id, source, raw_email, first_seen_at, last_seen_at, occurrences, files, raw_fields)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const email of emails) {
    const id = contactId.get(email) as number;
    for (const [source, rows] of byEmail.get(email) as Map<string, StagedRecord[]>) {
      const rep = representative(bySource.get(source) as StagedSource, rows);
      const files = [...new Set(rows.map((r) => r.file))].sort(cmp);
      insCs.run(
        id, source, rep.raw_email,
        minStr(rows.map((r) => r.created_at)),
        maxStr(rows.map((r) => r.last_seen_at ?? r.created_at)),
        rows.length, JSON.stringify(files), rep.raw_fields,
      );
    }
  }

  // 5. consents -----------------------------------------------------------------------------------
  const oldConsents = new Map(
    (db.prepare('SELECT contact_id, source, status, evidence, recorded_at FROM consents').all() as unknown as ConsentRow[])
      .map((c) => [`${Number(c.contact_id)}|${c.source}`, c]),
  );
  const delConsent = db.prepare('DELETE FROM consents WHERE source = ?');
  for (const s of processed) delConsent.run(s);
  const upsertConsent = db.prepare(`
    INSERT INTO consents (contact_id, source, status, evidence, recorded_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (contact_id, source) DO UPDATE SET status = excluded.status, evidence = excluded.evidence, recorded_at = excluded.recorded_at`);
  for (const email of emails) {
    const id = contactId.get(email) as number;
    for (const [source, rows] of byEmail.get(email) as Map<string, StagedRecord[]>) {
      const src = bySource.get(source) as StagedSource;
      const decisive = rows.filter((r) => r.consent_status !== 'unknown');
      if (decisive.length === 0) {
        upsertConsent.run(id, source, 'unknown', null, null);
        continue;
      }
      // D15: the newest file decides; inside that file `denied` wins; then the first row.
      let newest = -Infinity;
      for (const r of decisive) newest = Math.max(newest, rank(src, r.file));
      const inFile = decisive
        .filter((r) => rank(src, r.file) === newest)
        .sort((a, b) => a.row_number - b.row_number || a.split_index - b.split_index);
      const pick = inFile.find((r) => r.consent_status === 'denied') ?? (inFile[0] as StagedRecord);
      const evidence = JSON.stringify({
        column: src.consentColumn.get(pick.file) ?? null,
        value: pick.consent_raw,
        file: pick.file,
        row_number: pick.row_number,
      });
      upsertConsent.run(id, source, pick.consent_status, evidence, pick.last_seen_at ?? pick.created_at ?? src.meta.exported_at);
    }
  }

  // consent overrides (applied last, so they win over source rows)
  const consentOverrides = dedupeLast(
    opts.overrides.consents.map((c) => ({ ...c, email: normalizeOverrideEmail(c.email) })),
    (c) => `${c.email}|${c.source}`,
    (c) => warn(`consents.yaml: several entries for ${maskEmail(c.email)} / ${c.source}; the last one is used`),
  );
  const findContact = db.prepare('SELECT id FROM contacts WHERE email = ?');
  const hasCs = db.prepare('SELECT 1 AS x FROM contact_sources WHERE contact_id = ? AND source = ?');
  let consentsApplied = 0;
  for (const o of consentOverrides) {
    if (!processed.has(o.source)) {
      warn(`consents.yaml: source "${o.source}" is not merged (no directory with meta.md); override for ${maskEmail(o.email)} ignored`);
      continue;
    }
    const row = findContact.get(o.email) as { id: number } | undefined;
    const id = row ? Number(row.id) : null;
    if (id === null || hasCs.get(id, o.source) === undefined) {
      warn(`consents.yaml: no contact ${maskEmail(o.email)} in source "${o.source}"; override ignored`);
      continue;
    }
    const evidence = JSON.stringify({ override: o.note ?? null });
    const prev = oldConsents.get(`${id}|${o.source}`);
    const recordedAt = prev && prev.status === o.status && prev.evidence === evidence ? prev.recorded_at : now;
    upsertConsent.run(id, o.source, o.status, evidence, recordedAt);
    consentsApplied++;
  }

  // 6. orphans and first_seen_at ------------------------------------------------------------------
  const orphaned = db.prepare(`
    UPDATE contacts SET orphaned_at = ?, updated_at = ?
    WHERE orphaned_at IS NULL AND NOT EXISTS (SELECT 1 FROM contact_sources cs WHERE cs.contact_id = contacts.id)`).run(now, now);
  db.prepare(`
    UPDATE contacts SET first_seen_at = (SELECT MIN(cs.first_seen_at) FROM contact_sources cs WHERE cs.contact_id = contacts.id), updated_at = ?
    WHERE EXISTS (SELECT 1 FROM contact_sources cs WHERE cs.contact_id = contacts.id)
      AND first_seen_at IS NOT (SELECT MIN(cs.first_seen_at) FROM contact_sources cs WHERE cs.contact_id = contacts.id)`).run(now);

  // 7. rejected_rows, imports, suppressions -------------------------------------------------------
  const delRej = db.prepare('DELETE FROM rejected_rows WHERE source = ?');
  const insRej = db.prepare('INSERT INTO rejected_rows (run_id, source, file, row_number, raw_value, reason) VALUES (?, ?, ?, ?, ?, ?)');
  const insImport = db.prepare('INSERT INTO imports (run_id, source, file, sha256, encoding, rows_read, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  let excluded = 0;
  for (const s of staged) {
    delRej.run(s.meta.source);
    for (const r of s.rejected) {
      insRej.run(runId, s.meta.source, r.file, r.row_number, r.raw_value, r.reason);
      if (r.reason === 'excluded_by_override') excluded++;
    }
    for (const f of s.result.files) insImport.run(runId, s.meta.source, f.file, f.sha256, f.encoding ?? 'n/a', f.rows_read, now);
  }

  const suppressions = dedupeLast(
    opts.overrides.suppressions.map((s) => ({ ...s, email: normalizeOverrideEmail(s.email) })),
    (s) => `${s.email}|${s.reason}`,
    (s) => warn(`suppressions.yaml: several entries for ${maskEmail(s.email)} (${s.reason}); the last one is used`),
  );
  const insSup = db.prepare("INSERT OR IGNORE INTO suppressions (email, reason, source, note, created_at) VALUES (?, ?, 'override', ?, ?)");
  let suppressionsInserted = 0;
  for (const s of suppressions) suppressionsInserted += Number(insSup.run(s.email, s.reason, s.note ?? null, now).changes);

  // Typo decisions are applied during staging. Count the original addresses they actually changed:
  // accepted = staged rows carrying typo_accepted (the original is the normalized raw value),
  // rejected = the suspect address is present and kept as it is.
  const typoDecisions = dedupeLast(
    opts.overrides.typo.map((t) => ({ ...t, email: normalizeOverrideEmail(t.email) })),
    (t) => t.email,
    (t) => warn(`typo-decisions.yaml: several entries for ${maskEmail(t.email)}; the last one is used`),
  );
  const acceptedOriginals = new Set<string>();
  for (const s of staged) {
    for (const r of s.rows) {
      if (!r.flags.includes('typo_accepted')) continue;
      const original = normalizeEmailCell(r.raw_email)[0]?.email;
      if (original) acceptedOriginals.add(original);
    }
  }
  let typoApplied = 0;
  for (const t of typoDecisions) {
    const hit = t.action === 'accept' ? acceptedOriginals.has(t.email) : byEmail.has(t.email);
    if (hit) typoApplied++;
    else warn(`typo-decisions.yaml: ${maskEmail(t.email)} (${t.action}) matched no address in the merged sources`);
  }

  // 8. stats --------------------------------------------------------------------------------------
  const one = (sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);
  const overlap = (db.prepare(`
    SELECT source_a AS a, source_b AS b, contacts FROM v_source_overlap WHERE source_a < source_b ORDER BY source_a, source_b`)
    .all() as Array<{ a: string; b: string; contacts: number }>)
    .map((r) => ({ a: r.a, b: r.b, contacts: Number(r.contacts) }));

  return {
    run_id: runId,
    backup_path: opts.backupPath ?? null,
    sources: staged.map((s) => s.meta.source),
    priority_order: order,
    contacts_total: one('SELECT COUNT(*) AS n FROM contacts WHERE orphaned_at IS NULL'),
    contacts_new: contactsNew,
    contacts_orphaned: Number(orphaned.changes),
    cross_source_dups: one('SELECT COUNT(*) AS n FROM (SELECT contact_id FROM contact_sources GROUP BY contact_id HAVING COUNT(DISTINCT source) >= 2)'),
    overlap,
    overrides_applied: { typo: typoApplied, suppressions: suppressionsInserted, consents: consentsApplied, exclude: excluded },
  };
}
