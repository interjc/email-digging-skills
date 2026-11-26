// Shared contracts for the pipeline. Owned by the director: change only by agreement,
// and keep docs/design/phase-1.md in sync. Every module imports its types from here.

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type SourceKind = 'product' | 'event' | 'other';
export type ConsentBasis = 'opt_in' | 'transactional' | 'unknown';
export type ConsentStatus = 'granted' | 'denied' | 'unknown';
export type EmailStatus = 'valid' | 'role' | 'typo_suspect';
export type SuppressionReason = 'unsubscribed' | 'bounced' | 'complained' | 'manual';

/** Encodings a meta.md may declare. `auto` = detect (utf-8 → cp932 → gb18030), reported for review. */
export type DeclaredEncoding = 'auto' | 'utf-8' | 'utf-8-sig' | 'cp932' | 'gb18030' | 'utf-16le' | 'utf-16be';
/** Encoding actually used to decode a file. */
export type ResolvedEncoding = Exclude<DeclaredEncoding, 'auto'>;

/** Standard fields a source column can map to. Anything unmapped is kept in raw_fields. */
export type StandardField = 'email' | 'name' | 'created_at' | 'last_seen_at' | 'locale' | 'consent';
export const STANDARD_FIELDS: readonly StandardField[] = [
  'email', 'name', 'created_at', 'last_seen_at', 'locale', 'consent',
];

/** Flags on one address. Stored sorted and de-duplicated in contacts.flags. */
export type Flag =
  | 'role_address'          // local part is info@, support@, noreply@ ...
  | 'typo_suspect'          // domain looks like a known misspelling; see suggestion
  | 'typo_accepted'         // an override accepted the suggestion; normalized email was replaced
  | 'legacy_mobile_dots'    // consecutive dots or a dot before @ (old docomo/au addresses): allowed
  | 'split_from_multi'      // came from a cell holding several addresses
  | 'width_normalized';     // NFKC changed the value (full-width ＠ etc.)

export type RejectReason =
  | 'empty'                 // email cell empty or whitespace only
  | 'invalid_syntax'        // no usable address after normalization
  | 'excluded_by_override'; // matched workspace/overrides/exclude.yaml

// ---------------------------------------------------------------------------
// Email normalization (scripts/lib/email/) - pure, no I/O
// ---------------------------------------------------------------------------

export interface EmailCandidate {
  /** The substring of the cell this candidate came from (after splitting, before normalization). */
  raw: string;
  /** Normalized address, or null when rejected. */
  email: string | null;
  domain: string | null;
  status: EmailStatus | null;        // null when rejected
  flags: Flag[];
  suggestion: string | null;         // full suggested address for typo suspects
  rejectReason: RejectReason | null; // non-null iff email is null
}

/**
 * Normalize one cell. Returns one candidate per address found (a cell may hold several).
 * An empty cell returns a single candidate with rejectReason 'empty'.
 * Signature implemented by scripts/lib/email/normalize.ts:
 *   export function normalizeEmailCell(cell: string | null | undefined): EmailCandidate[];
 */
export type NormalizeEmailCell = (cell: string | null | undefined) => EmailCandidate[];

// ---------------------------------------------------------------------------
// Masking (scripts/lib/mask.ts) - pure except for the key argument
// ---------------------------------------------------------------------------
//   export function maskEmail(email: string): string;            // 't***@g***l.com'
//   export function maskName(name: string): string;              // '山*'
//   export function maskPhone(phone: string): string;            // '*********34'
//   export function hmacLocalPart(email: string, key: string, opts?: { keepDomain?: boolean }): string;
//   export function maskValue(field: string, value: string): string; // dispatch by field name

// ---------------------------------------------------------------------------
// Configuration: config.yaml (user-owned, git-ignored) and meta.md
// ---------------------------------------------------------------------------

export interface PipelineConfig {
  /** Absolute path, resolved from MAIL_PIPELINE_WORKSPACE, config.workspace, or <repo>/workspace. */
  workspace: string;
  sources: {
    /** Highest priority first. Unlisted sources follow, newest exported_at first, then by name. */
    priority: string[];
  };
  consent: {
    /** Consent bases whose sources count as opt-in for v_sendable_strict. Default ['opt_in']. */
    opt_in_bases: ConsentBasis[];
    /** Extra source names that count as opt-in regardless of basis. Default []. */
    opt_in_sources: string[];
  };
  masking: {
    /** Keep the real domain in masked exports (domain distribution stays visible). Default true. */
    keep_domain: boolean;
  };
  backups: {
    /** Number of database backups to keep in database/backups/. Default 20. */
    keep: number;
  };
}

export interface MetaFile {
  name: string;                  // file name inside resources/<source>/
  encoding: DeclaredEncoding;    // default 'auto'
  sheet?: string | null;         // xlsx only; default first sheet
  header_row?: number;           // 1-based; default 1
  table?: string | null;         // sqlite only: table to read
  query?: string | null;         // sqlite only: SELECT to run instead of table
  delimiter?: string | null;     // csv/tsv only; default auto
}

export interface SourceMeta {
  source: string;                // must equal the directory name
  kind: SourceKind;
  label: string | null;
  files: MetaFile[];
  /** Standard field -> original column name. Missing or empty = auto-detect. */
  columns: Partial<Record<StandardField, string | null>>;
  /** Raw consent cell values -> status. Missing = built-in defaults (docs/cleaning-rules.md). */
  consent_values?: { granted?: string[]; denied?: string[] };
  consent_basis: ConsentBasis;
  exported_at: string | null;    // YYYY-MM-DD
  /** Absolute path of the source directory (filled by the loader, not written in meta.md). */
  dir: string;
}

// ---------------------------------------------------------------------------
// Overrides: workspace/overrides/*.yaml (human decisions, read on every run)
// ---------------------------------------------------------------------------

export interface Overrides {
  /** typo-decisions.yaml */
  typo: Array<{ email: string; action: 'accept' | 'reject'; suggested?: string; note?: string }>;
  /** suppressions.yaml */
  suppressions: Array<{ email: string; reason: SuppressionReason; note?: string }>;
  /** consents.yaml */
  consents: Array<{ email: string; source: string; status: ConsentStatus; note?: string }>;
  /** exclude.yaml: test accounts etc. `email` exact match or `pattern` (glob on normalized email). */
  exclude: Array<{ email?: string; pattern?: string; note?: string }>;
}

// ---------------------------------------------------------------------------
// Reading and staging (scripts/lib/read/, scripts/lib/stage.ts)
// ---------------------------------------------------------------------------

export type FileFormat = 'csv' | 'tsv' | 'xlsx' | 'json' | 'sqlite';

export interface ColumnMapping {
  field: StandardField;
  column: string | null;
  how: 'meta' | 'header_synonym' | 'content_sniff' | 'none';
  confidence: number;            // 0..1; meta = 1
}

export interface FileProbe {
  file: string;
  format: FileFormat;
  encoding: ResolvedEncoding | null;      // null for xlsx / sqlite
  encodingHow: 'meta' | 'bom' | 'detected' | 'n/a';
  encodingCandidates: ResolvedEncoding[]; // encodings that decoded without error, in try order
  headers: string[];
  rowCount: number;
  mappings: ColumnMapping[];
}

/** One staged row = one address candidate (a split cell yields several rows). */
export interface StagedRow {
  source: string;
  file: string;
  row_number: number;            // 1-based data row
  split_index: number;           // 0 unless split_from_multi
  raw_email: string;
  email: string;                 // normalized
  email_domain: string;
  email_status: EmailStatus;
  flags: Flag[];
  suggested_email: string | null;
  name: string | null;
  locale: string | null;
  created_at: string | null;     // ISO date or datetime
  last_seen_at: string | null;
  consent_raw: string | null;
  consent_status: ConsentStatus;
  raw_fields: Record<string, string | null>;
}

export interface RejectedRow {
  source: string;
  file: string;
  row_number: number;
  raw_value: string | null;
  reason: RejectReason;
}

export interface FileStats {
  file: string;
  sha256: string;
  encoding: ResolvedEncoding | null;
  encodingHow: FileProbe['encodingHow'];
  mappings: ColumnMapping[];
  rows_read: number;
  empty: number;
  invalid: number;
  cells_split: number;           // cells that held more than one address
  dup_in_file: number;           // extra occurrences of an address already seen in the same file
  role: number;
  typo_suspect: number;
}

/** Written to output/staging/<source>/stats.json next to rows.parquet and rejected.parquet. */
export interface SourceStageResult {
  source: string;
  files: FileStats[];
  staged_rows: number;
  rejected_rows: number;
  unique_emails: number;
  dir: string;                   // absolute staging directory
}

// ---------------------------------------------------------------------------
// Merge and report (scripts/lib/merge.ts, scripts/lib/report.ts)
// ---------------------------------------------------------------------------

export interface MergeStats {
  run_id: string;
  backup_path: string | null;
  sources: string[];
  priority_order: string[];      // resolved order actually used
  contacts_total: number;
  contacts_new: number;
  contacts_orphaned: number;     // newly orphaned in this run
  cross_source_dups: number;     // addresses present in 2+ sources
  overlap: Array<{ a: string; b: string; contacts: number }>;
  overrides_applied: { typo: number; suppressions: number; consents: number; exclude: number };
}

export interface RunReport {
  run_id: string;
  generated_at: string;
  stage: SourceStageResult[];
  merge: MergeStats | null;      // null for --dry-run
  /** Masked samples only. Never full addresses. */
  samples: {
    invalid: Array<{ source: string; file: string; row_number: number; masked: string; reason: RejectReason }>;
    typo: Array<{ masked: string; masked_suggestion: string; sources: string[] }>;
    low_confidence_mappings: Array<{ source: string; file: string; mapping: ColumnMapping }>;
    auto_encodings: Array<{ source: string; file: string; encoding: ResolvedEncoding | null; candidates: ResolvedEncoding[] }>;
  };
}

// ---------------------------------------------------------------------------
// Providers (providers/<name>/index.ts)
// ---------------------------------------------------------------------------

export type ProviderList = 'strict' | 'not_blocked';

export interface ProviderContext {
  workspace: string;
  dbPath: string;
  env: Record<string, string | undefined>;   // provider's own keys from .env only
  dryRun: boolean;                            // true unless the user confirmed --apply
  log: (line: string) => void;                // masked output only
}

export interface PushPlan {
  provider: string;
  list: ProviderList;
  to_add: number;
  to_update: number;
  to_remove: number;
  export_file: string | null;                 // file written under output/exports/
  notes: string[];
}

export interface PullResult {
  provider: string;
  suppressions_found: number;
  suppressions_new: number;
}

export interface Provider {
  name: string;
  /** Env keys this provider needs (documented in .env.example). */
  envKeys: string[];
  pushContacts(ctx: ProviderContext, opts: { list: ProviderList }): Promise<PushPlan>;
  pullSuppressions(ctx: ProviderContext): Promise<PullResult>;
}

// ---------------------------------------------------------------------------
// CLI conventions (every scripts/*.ts entry point)
// ---------------------------------------------------------------------------
// - Flags: --workspace <path> overrides the workspace; --json prints machine-readable output.
// - Every command except init-workspace calls requireWorkspace() first and exits 2 when the
//   workspace is missing, not initialized, or inside the repo but not git-ignored.
// - stdout is masked by default. Full values only go to the database and output/exports/.
// - Exit codes: 0 ok, 1 error, 2 precondition failed (workspace / confirmation missing).
/** D36: keys merge adds to contact_sources.raw_fields for other rows of the same address in one source. */
export const MERGED_ROWS_KEY = '_merged_rows';
export const MERGED_ROWS_OMITTED_KEY = '_merged_rows_omitted';

export const EXIT = { OK: 0, ERROR: 1, PRECONDITION: 2 } as const;
