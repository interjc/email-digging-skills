import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { migrate, openDb } from './db.ts';
import { normalizeEmailCell } from './email/normalize.ts';
import { writeFileInWorkspace } from './fsafe.ts';
import { hmacLocalPart } from './mask.ts';
import type { WorkspaceLayout } from './paths.ts';
import { requireOutputDir } from './query.ts';
import { makeConsentMatcher } from './read/consent.ts';
import { sanitizeText } from './sanitize.ts';
import { MERGED_ROWS_KEY, MERGED_ROWS_OMITTED_KEY } from './types.ts';

// Foreign-key order. A migration adding a table or field must classify it before we can share it.
const COLUMNS = {
  schema_migrations: 'version applied_at',
  sources: 'name kind label consent_basis counts_as_opt_in priority exported_at updated_at',
  contacts: 'id email email_domain name locale email_status suggested_email flags first_seen_at orphaned_at created_at updated_at',
  contact_sources: 'contact_id source raw_email first_seen_at last_seen_at occurrences files raw_fields',
  consents: 'contact_id source status evidence recorded_at',
  suppressions: 'id email reason source note created_at',
  runs: 'id command started_at finished_at status report_path',
  rejected_rows: 'id run_id source file row_number raw_value reason',
  imports: 'id run_id source file sha256 encoding rows_read imported_at',
  sync_log: 'id provider direction dry_run started_at finished_at counts status',
};
type Table = keyof typeof COLUMNS;
type Row = Record<string, SQLOutputValue>;
const R3_CONSENT = makeConsentMatcher();

function parseJson(value: SQLOutputValue | undefined): unknown {
  try {
    return JSON.parse(String(value)) as unknown;
  } catch {
    throw new Error('Cannot mask the database: a stored JSON field is invalid.');
  }
}

function jsonObject(value: SQLOutputValue | undefined): Record<string, unknown> {
  const parsed = parseJson(value);
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function jsonStrings(value: SQLOutputValue | undefined): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
}

function maskedCopyRow(
  table: Table, row: Row, pseudonym: (email: string) => string, keepDomain: boolean,
): Row {
  function rawEmails(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    const tokens = normalizeEmailCell(raw).flatMap((candidate) => candidate.email === null ? [] : [pseudonym(candidate.email)]);
    return [...new Set(tokens)].join(', ');
  }
  const result: Row = {};
  function fields(...names: string[]): void {
    for (const name of names) {
      const value = row[name] ?? null;
      result[name] = typeof value === 'string' ? sanitizeText(value) : value;
    }
  }
  switch (table) {
    case 'sources':
      fields('name', 'kind', 'consent_basis', 'counts_as_opt_in', 'priority', 'exported_at', 'updated_at');
      break;
    case 'contacts':
      fields('id', 'email_status', 'first_seen_at', 'orphaned_at', 'created_at', 'updated_at');
      result.flags = JSON.stringify(jsonStrings(row.flags).map(sanitizeText));
      result.email = pseudonym(String(row.email));
      result.email_domain = keepDomain ? String(row.email_domain) : pseudonym(`x@${String(row.email_domain)}`).split('@')[1]!;
      result.suggested_email = row.suggested_email === null ? null : pseudonym(String(row.suggested_email));
      break;
    case 'contact_sources': {
      fields('contact_id', 'source', 'first_seen_at', 'last_seen_at', 'occurrences');
      result.raw_email = rawEmails(row.raw_email);
      const rawFields = new Map<string, string | null>();
      for (const [key, value] of Object.entries(jsonObject(row.raw_fields))) {
        if (key === MERGED_ROWS_KEY || key === MERGED_ROWS_OMITTED_KEY) continue; // D36 stacking is not a source column
        const safe = sanitizeText(key);
        let label = safe;
        for (let n = 2; rawFields.has(label); n++) label = `${safe}:${n}`;
        rawFields.set(label, value === null ? null : rawEmails(value));
      }
      result.raw_fields = JSON.stringify(Object.fromEntries(rawFields));
      result.files = JSON.stringify(jsonStrings(row.files).map(sanitizeText));
      break;
    }
    case 'consents':
      fields('contact_id', 'source', 'status', 'recorded_at');
      if (row.evidence !== null) {
        result.evidence = JSON.stringify(Object.fromEntries(Object.entries(jsonObject(row.evidence)).map(([key, value]) => {
          let safe: unknown = '';
          if ((key === 'column' || key === 'file') && typeof value === 'string') safe = sanitizeText(value);
          if (key === 'row_number' && typeof value === 'number') safe = value;
          if (key === 'override' && (value === 'granted' || value === 'denied' || value === 'unknown')) safe = value;
          if (key === 'value' && typeof value === 'string' && R3_CONSENT(value) !== 'unknown') safe = value;
          return [sanitizeText(key), safe];
        })));
      }
      break;
    case 'suppressions':
      fields('id', 'reason', 'source', 'created_at');
      result.email = pseudonym(String(row.email));
      result.note = row.note === null ? null : '';
      break;
    case 'runs':
      fields('id', 'command', 'started_at', 'finished_at', 'status');
      break;
    case 'rejected_rows':
      fields('id', 'run_id', 'source', 'file', 'row_number', 'reason');
      result.raw_value = row.raw_value === null ? null : `<redacted len=${Array.from(String(row.raw_value)).length}>`;
      break;
    case 'imports':
      fields('id', 'run_id', 'source', 'file', 'sha256', 'encoding', 'rows_read', 'imported_at');
      break;
    case 'sync_log':
      fields('id', 'provider', 'direction', 'dry_run', 'started_at', 'finished_at', 'status');
      result.counts = JSON.stringify(Object.fromEntries(Object.entries(jsonObject(row.counts))
        .map(([key, value]) => [sanitizeText(key), typeof value === 'number' ? value : ''])));
      break;
  }
  return result;
}

interface Bucket {
  represented_contacts: number;
  non_null: Map<string, number>;
  statuses: Map<string, number>;
  flags: Map<string, number>;
  reject_reasons: Map<string, number>;
}

function bucket(): Bucket {
  return { represented_contacts: 0, non_null: new Map(), statuses: new Map(), flags: new Map(), reject_reasons: new Map() };
}

function group<T>(map: Map<string, T>, key: string, create: () => T): T {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const added = create();
  map.set(key, added);
  return added;
}

function increment(map: Map<string, number>, key: string, count = 1): void {
  map.set(key, (map.get(key) ?? 0) + count);
}

function addContact(bin: Bucket, fields: Record<string, unknown>, status: string, flags: Set<string>): void {
  bin.represented_contacts++;
  increment(bin.statuses, status);
  for (const flag of flags) increment(bin.flags, flag);
  for (const [field, value] of Object.entries(fields)) increment(bin.non_null, field, value === null ? 0 : 1);
}

function namedCounts(map: Map<string, number>, convert = (count: number) => count): Record<string, number> {
  const result = new Map<string, number>();
  for (const [key, count] of [...map].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const safe = sanitizeText(key);
    let label = safe;
    for (let n = 2; result.has(label); n++) label = `${safe}:${n}`;
    result.set(label, convert(count));
  }
  return Object.fromEntries(result);
}

function describe(bin: Bucket) {
  const null_rates = namedCounts(bin.non_null, (n) => (bin.represented_contacts - n) / bin.represented_contacts);
  return {
    represented_contacts: bin.represented_contacts,
    columns: Object.keys(null_rates), null_rates,
    statuses: namedCounts(bin.statuses), flags: namedCounts(bin.flags), reject_reasons: namedCounts(bin.reject_reasons),
  };
}

/** Rows read and encodings come from the latest import; field shape comes from representative contacts. */
export function buildShape(db: DatabaseSync) {
  const sources = new Map<string, Bucket & { files: Map<string, Bucket & { rows_read: number | null; encoding: string | null }> }>();
  const source = (key: SQLOutputValue | undefined) => group(sources, String(key), () => ({ ...bucket(), files: new Map() }));
  const file = (sourceKey: SQLOutputValue | undefined, name: string) =>
    group(source(sourceKey).files, name, () => ({ ...bucket(), rows_read: null, encoding: null }));
  for (const row of db.prepare('SELECT name FROM sources ORDER BY name').iterate()) source(row.name);
  for (const row of db.prepare('SELECT source, file, rows_read, encoding FROM imports ORDER BY id').iterate()) {
    const bin = file(row.source, String(row.file));
    bin.rows_read = Number(row.rows_read);
    bin.encoding = sanitizeText(String(row.encoding));
  }
  for (const row of db.prepare(`
    SELECT cs.source, cs.files, cs.raw_fields, c.email_status, c.flags
    FROM contact_sources cs JOIN contacts c ON c.id = cs.contact_id ORDER BY cs.source, cs.contact_id`).iterate()) {
    const fields = jsonObject(row.raw_fields);
    delete fields[MERGED_ROWS_KEY];
    delete fields[MERGED_ROWS_OMITTED_KEY];
    const flags = new Set(jsonStrings(row.flags));
    const status = String(row.email_status);
    addContact(source(row.source), fields, status, flags);
    for (const name of new Set(jsonStrings(row.files))) addContact(file(row.source, name), fields, status, flags);
  }
  for (const row of db.prepare(`
    SELECT source, file, reason, count(*) AS count FROM rejected_rows
    GROUP BY source, file, reason ORDER BY source, file, reason`).iterate()) {
    increment(source(row.source).reject_reasons, String(row.reason), Number(row.count));
    increment(file(row.source, String(row.file)).reject_reasons, String(row.reason), Number(row.count));
  }
  return {
    note: 'File row counts and encodings use the latest recorded import. Statuses, flags and null rates use representative contact rows, attributed to every contributing file; they do not describe every original row.',
    sources: Array.from(sources, ([name, bin]) => {
      const files = Array.from(bin.files, ([name, entry]) => ({
        file: sanitizeText(name), encoding: entry.encoding, rows_read: entry.rows_read, ...describe(entry),
      }));
      return {
        source: sanitizeText(name),
        encodings: [...new Set(files.flatMap((entry) => entry.encoding === null ? [] : [entry.encoding]))].sort(),
        rows_read: files.length > 0 && files.every((entry) => entry.rows_read !== null)
          ? files.reduce((sum, entry) => sum + (entry.rows_read ?? 0), 0) : null,
        ...describe(bin), files,
      };
    }),
  };
}

const ident = (column: string) => `"${column.replaceAll('"', '""')}"`;

export function writeMaskedCopy(
  layout: WorkspaceLayout, migrationsDir: string, opts: { key: string; keepDomain: boolean; shape: boolean },
) {
  if (!opts.key) throw new Error('A non-empty MASK_HMAC_KEY is required');
  const pseudonym = (email: string) => hmacLocalPart(email, opts.key, { keepDomain: opts.keepDomain });
  const dir = requireOutputDir(layout.workspace, layout.masked);
  const temp = fs.mkdtempSync(path.join(dir, '.mask-'));
  const dbTemp = path.join(temp, 'copy.sqlite');
  let shape: ReturnType<typeof buildShape> | undefined;
  const rows: Record<string, number> = {};
  try {
    fs.writeFileSync(dbTemp, '', { flag: 'wx', mode: 0o600 });
    const source = openDb(layout.dbPath, { readonly: true });
    try {
      const target = openDb(dbTemp);
      try {
        source.exec('BEGIN');
        const versions = migrate(target, migrationsDir);
        const applied = source.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);
        if (JSON.stringify(versions) !== JSON.stringify(applied)) {
          throw new Error('The source schema does not match the current migrations; migrate the main database first.');
        }
        const tables = Object.keys(COLUMNS) as Table[];
        const tableNames = (db: DatabaseSync) => db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
          .all().map((r) => r.name);
        if ([source, target].some((db) => JSON.stringify(tableNames(db)) !== JSON.stringify([...tables].sort()))) {
          throw new Error('The masked copy does not support all tables in this schema.');
        }
        const updateVersion = target.prepare('UPDATE schema_migrations SET applied_at = ? WHERE version = ?');
        target.exec('BEGIN');
        for (const table of tables) {
          const read = source.prepare(`SELECT * FROM ${table} ORDER BY rowid`);
          read.setReadBigInts(true);
          const fields = read.columns().map((c) => c.name);
          if (fields.join(' ') !== COLUMNS[table] ||
              target.prepare(`SELECT * FROM ${table}`).columns().map((c) => c.name).join(' ') !== COLUMNS[table]) {
            throw new Error(`Unclassified fields in the masked copy schema for ${table}.`);
          }
          const insert = target.prepare(`INSERT INTO ${table} (${fields.map(ident).join(',')}) VALUES (${fields.map(() => '?').join(',')})`);
          let count = 0;
          for (const row of read.iterate()) {
            if (table === 'schema_migrations') {
              updateVersion.run(sanitizeText(String(row.applied_at)), row.version ?? null);
            } else {
              const masked = maskedCopyRow(table, row, pseudonym, opts.keepDomain);
              insert.run(...fields.map((key) => masked[key] ?? null));
            }
            count++;
          }
          rows[table] = count;
        }
        if (opts.shape) shape = buildShape(source);
        target.exec('COMMIT');
        source.exec('COMMIT');
      } finally {
        target.close();
      }
    } finally {
      source.close();
    }
    const writeOpts = { workspace: layout.workspace };
    const masked_db = writeFileInWorkspace(dir, 'mail-list-masked.sqlite', fs.readFileSync(dbTemp), writeOpts);
    const shape_file = shape ? writeFileInWorkspace(dir, 'shape.json', `${JSON.stringify(shape, null, 2)}\n`, writeOpts) : null;
    return { masked_db, shape_file, keep_domain: opts.keepDomain, rows };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
