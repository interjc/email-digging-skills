// Stage one source: read every listed file, normalize, apply overrides (D14), write Parquet + stats.json (D13).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  EmailCandidate, EmailStatus, FileStats, Flag, Overrides, RejectedRow, SourceMeta, SourceStageResult, StagedRow,
} from './types.ts';
import { normalizeEmailCell } from './email/normalize.ts';
import { makeConsentMatcher } from './read/consent.ts';
import { parseDate } from './read/dates.ts';
import { connect, ensureExtension, sqlStr } from './read/duck.ts';
import { probeFile, readRows } from './read/index.ts';
import { SOURCE_NAME_RE } from './meta.ts';
import { sanitizeText } from './sanitize.ts';

export interface StageOptions {
  /** `output/staging`; the source gets `<stagingDir>/<source>/`, removed and recreated. */
  stagingDir: string;
  overrides: Overrides;
}

function sha256File(file: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

const trimOrNull = (v: string | null | undefined): string | null => {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  return t === '' ? null : t;
};

function globToRegExp(glob: string): RegExp {
  const esc = glob.toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`);
}

interface OverrideIndex {
  excludeEmails: Set<string>;
  excludePatterns: RegExp[];
  typo: Map<string, Overrides['typo'][number]>;
}

function indexOverrides(o: Overrides): OverrideIndex {
  const excludeEmails = new Set<string>();
  const excludePatterns: RegExp[] = [];
  for (const e of o.exclude) {
    if (e.email) excludeEmails.add(e.email.trim().toLowerCase());
    if (e.pattern) excludePatterns.push(globToRegExp(e.pattern.trim()));
  }
  const typo = new Map<string, Overrides['typo'][number]>();
  for (const t of o.typo) typo.set(t.email.trim().toLowerCase(), t);
  return { excludeEmails, excludePatterns, typo };
}

const SORT = (flags: Iterable<Flag>): Flag[] => [...new Set(flags)].sort();

/** Apply typo decisions to one valid candidate (D14). Returns the final status, flags, email and suggestion. */
function applyTypo(c: EmailCandidate, idx: OverrideIndex): { email: string; status: EmailStatus; flags: Flag[]; suggestion: string | null } {
  const email = c.email as string;
  let status = c.status as EmailStatus;
  let flags = c.flags;
  let suggestion = c.suggestion;
  const decision = c.flags.includes('typo_suspect') ? idx.typo.get(email) : undefined;
  if (decision?.action === 'accept') {
    const target = decision.suggested ?? suggestion ?? null;
    const re = target === null ? null : normalizeEmailCell(target)[0];
    if (re && re.email !== null && re.status !== null) {
      // The accepted suggestion replaces the normalized email; status and flags are recomputed from it.
      const keep = c.flags.filter((f) => f !== 'typo_suspect' && f !== 'role_address' && f !== 'legacy_mobile_dots');
      return {
        email: re.email,
        status: re.status,
        flags: SORT([...keep, ...re.flags.filter((f) => f !== 'width_normalized' && f !== 'split_from_multi'), 'typo_accepted']),
        suggestion: re.status === 'typo_suspect' ? re.suggestion : null,
      };
    }
  } else if (decision?.action === 'reject') {
    flags = c.flags.filter((f) => f !== 'typo_suspect');
    suggestion = null;
    status = flags.includes('role_address') ? 'role' : 'valid';
  }
  return { email, status, flags: SORT(flags), suggestion };
}

const ROW_COLUMNS = [
  ['source', 'VARCHAR'], ['file', 'VARCHAR'], ['row_number', 'INTEGER'], ['split_index', 'INTEGER'],
  ['raw_email', 'VARCHAR'], ['email', 'VARCHAR'], ['email_domain', 'VARCHAR'], ['email_status', 'VARCHAR'],
  ['flags', 'VARCHAR[]'], ['suggested_email', 'VARCHAR'], ['name', 'VARCHAR'], ['locale', 'VARCHAR'],
  ['created_at', 'VARCHAR'], ['last_seen_at', 'VARCHAR'], ['consent_raw', 'VARCHAR'], ['consent_status', 'VARCHAR'],
  ['raw_fields', 'VARCHAR'],
] as const;

const REJECT_COLUMNS = [
  ['source', 'VARCHAR'], ['file', 'VARCHAR'], ['row_number', 'INTEGER'], ['raw_value', 'VARCHAR'], ['reason', 'VARCHAR'],
] as const;

class NdjsonWriter {
  count = 0;
  private fd: number;
  private buf: string[] = [];
  readonly file: string;
  constructor(file: string) {
    this.file = file;
    this.fd = fs.openSync(file, 'w');
  }
  write(obj: unknown): void {
    this.buf.push(JSON.stringify(obj));
    this.count++;
    if (this.buf.length >= 2000) this.flush();
  }
  flush(): void {
    if (this.buf.length > 0) fs.writeSync(this.fd, this.buf.join('\n') + '\n');
    this.buf = [];
  }
  close(): void {
    this.flush();
    fs.closeSync(this.fd);
  }
}

async function writeParquet(ndjson: NdjsonWriter, columns: ReadonlyArray<readonly [string, string]>, out: string): Promise<void> {
  await ensureExtension('json');
  await ensureExtension('parquet');
  const conn = await connect();
  try {
    // The instance is shared by every call in this process: use a connection-local table.
    const ddl = columns.map(([n, t]) => `"${n}" ${t}`).join(', ');
    await conn.run(`CREATE OR REPLACE TEMP TABLE stage_out (${ddl})`);
    if (ndjson.count > 0) {
      const cols = columns.map(([n, t]) => `'${n}': '${t}'`).join(', ');
      await conn.run(`INSERT INTO stage_out SELECT * FROM read_json(${sqlStr(ndjson.file)}, format='newline_delimited', columns={${cols}})`);
    }
    await conn.run(`COPY stage_out TO ${sqlStr(out)} (FORMAT parquet)`);
    await conn.run('DROP TABLE stage_out');
  } finally {
    conn.closeSync();
  }
}

/** Swap `tmp` into `final`. Another stage of the same source may win the race; the last rename stands. */
function replaceDir(tmp: string, final: string): void {
  for (let attempt = 0; ; attempt++) {
    fs.rmSync(final, { recursive: true, force: true });
    try {
      fs.renameSync(tmp, final);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'EPERM')) throw err;
    }
  }
}

export async function stageSource(meta: SourceMeta, opts: StageOptions): Promise<SourceStageResult> {
  if (!SOURCE_NAME_RE.test(meta.source)) throw new Error(`invalid source name "${meta.source}"`);
  const stagingRoot = path.resolve(opts.stagingDir);
  const finalDir = path.join(stagingRoot, meta.source);
  // D26: build in a unique temp directory next to the final one and rename it into place, so a
  // reader (or a second stage of the same source) never sees a half-written directory. Source names
  // cannot start with `_`, so the temp name never collides with a source.
  const dir = path.join(stagingRoot, `_tmp-${meta.source}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  const decodedDir = path.join(dir, '_decoded');
  const rowsTmp = new NdjsonWriter(path.join(dir, '_rows.ndjson'));
  const rejectTmp = new NdjsonWriter(path.join(dir, '_rejected.ndjson'));

  const idx = indexOverrides(opts.overrides);
  const consent = makeConsentMatcher(meta.consent_values);
  const fileStats: FileStats[] = [];
  const unique = new Set<string>();

  try {
    for (const mf of meta.files) {
      const filePath = path.join(meta.dir, mf.name);
      const sha256 = sha256File(filePath);
      const probe = await probeFile(filePath, mf, { columns: meta.columns, decodedDir });
      const col = (field: string): string | null => probe.mappings.find((m) => m.field === field)?.column ?? null;
      const emailCol = col('email');
      if (emailCol === null) {
        throw new Error(sanitizeText(`${mf.name}: no email column found. Headers seen: ${probe.headers.map((h) => JSON.stringify(h)).join(', ')}. Set \`columns.email\` in meta.md.`));
      }
      const nameCol = col('name');
      const localeCol = col('locale');
      const createdCol = col('created_at');
      const seenCol = col('last_seen_at');
      const consentCol = col('consent');

      const stats: FileStats = {
        file: mf.name, sha256, encoding: probe.encoding, encodingHow: probe.encodingHow, mappings: probe.mappings,
        rows_read: 0, empty: 0, invalid: 0, cells_split: 0, dup_in_file: 0, role: 0, typo_suspect: 0,
      };
      const seen = new Set<string>();

      for await (const { row_number, cells } of readRows(filePath, mf, probe, { decodedDir })) {
        stats.rows_read++;
        const candidates = normalizeEmailCell(cells[emailCol]);
        if (candidates.length > 1) stats.cells_split++;
        const consentRaw = consentCol ? trimOrNull(cells[consentCol]) : null;
        const common = {
          name: nameCol ? trimOrNull(cells[nameCol]) : null,
          locale: localeCol ? trimOrNull(cells[localeCol]) : null,
          created_at: createdCol ? parseDate(cells[createdCol]) : null,
          last_seen_at: seenCol ? parseDate(cells[seenCol]) : null,
          consent_raw: consentRaw,
          consent_status: consent(consentRaw),
        };

        candidates.forEach((c, split_index) => {
          if (c.email === null || c.status === null || c.domain === null) {
            const reason = c.rejectReason ?? 'invalid_syntax';
            if (reason === 'empty') stats.empty++;
            else stats.invalid++;
            const rejected: RejectedRow = { source: meta.source, file: mf.name, row_number, raw_value: reason === 'empty' ? null : c.raw, reason };
            rejectTmp.write(rejected);
            return;
          }
          const excluded = (email: string) => idx.excludeEmails.has(email) || idx.excludePatterns.some((re) => re.test(email));
          const fin = applyTypo(c, idx);
          // D22: an exclusion matches the address before or after an accepted typo correction.
          if (excluded(c.email) || excluded(fin.email)) {
            const rejected: RejectedRow = { source: meta.source, file: mf.name, row_number, raw_value: c.raw, reason: 'excluded_by_override' };
            rejectTmp.write(rejected);
            return;
          }
          const domain = fin.email.slice(fin.email.lastIndexOf('@') + 1);
          if (seen.has(fin.email)) stats.dup_in_file++;
          seen.add(fin.email);
          unique.add(fin.email);
          if (fin.status === 'role') stats.role++;
          if (fin.status === 'typo_suspect') stats.typo_suspect++;
          const row: StagedRow = {
            source: meta.source, file: mf.name, row_number, split_index,
            raw_email: c.raw, email: fin.email, email_domain: domain,
            email_status: fin.status, flags: fin.flags, suggested_email: fin.suggestion,
            ...common,
            raw_fields: cells,
          };
          rowsTmp.write({ ...row, raw_fields: JSON.stringify(cells) });
        });
      }
      fileStats.push(stats);
    }
    rowsTmp.close();
    rejectTmp.close();

    await writeParquet(rowsTmp, ROW_COLUMNS, path.join(dir, 'rows.parquet'));
    await writeParquet(rejectTmp, REJECT_COLUMNS, path.join(dir, 'rejected.parquet'));

    const result: SourceStageResult = {
      source: meta.source,
      files: fileStats,
      staged_rows: rowsTmp.count,
      rejected_rows: rejectTmp.count,
      unique_emails: unique.size,
      dir: finalDir,
    };
    fs.writeFileSync(path.join(dir, 'stats.json'), JSON.stringify(result, null, 2) + '\n');
    fs.rmSync(decodedDir, { recursive: true, force: true });
    fs.rmSync(rowsTmp.file, { force: true });
    fs.rmSync(rejectTmp.file, { force: true });
    replaceDir(dir, finalDir);
    return result;
  } finally {
    for (const w of [rowsTmp, rejectTmp]) { try { w.close(); } catch { /* already closed */ } }
    fs.rmSync(dir, { recursive: true, force: true }); // no-op after a successful rename
  }
}
