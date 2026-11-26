-- 0001_init.sql: core tables for the mailing-list database.
-- Dialect: SQLite, written to stay portable to Postgres
--   (TEXT timestamps in ISO-8601 UTC, JSON stored as TEXT, no SQLite-only functions in DDL).
--   Postgres port: INTEGER PRIMARY KEY -> BIGINT GENERATED ALWAYS AS IDENTITY, TEXT JSON -> JSONB.
-- Never edit an applied migration. Change the schema by adding a new numbered file.

CREATE TABLE schema_migrations (
  version    TEXT PRIMARY KEY,          -- file name without .sql, e.g. '0001_init'
  applied_at TEXT NOT NULL
);

-- One row per data source (directory under workspace/resources/).
CREATE TABLE sources (
  name              TEXT PRIMARY KEY,   -- source label: lowercase letters, digits, hyphens
  kind              TEXT NOT NULL CHECK (kind IN ('product', 'event', 'other')),
  label             TEXT,
  consent_basis     TEXT NOT NULL DEFAULT 'unknown'
                    CHECK (consent_basis IN ('opt_in', 'transactional', 'unknown')),
  counts_as_opt_in  INTEGER NOT NULL DEFAULT 0 CHECK (counts_as_opt_in IN (0, 1)), -- resolved from config.yaml
  priority          INTEGER NOT NULL,   -- resolved merge order, 1 = highest
  exported_at       TEXT,
  updated_at        TEXT NOT NULL
);

-- One row per normalized email address. Never deleted automatically.
CREATE TABLE contacts (
  id               INTEGER PRIMARY KEY,
  email            TEXT NOT NULL UNIQUE,  -- normalized (see docs/cleaning-rules.md)
  email_domain     TEXT NOT NULL,
  name             TEXT,                  -- first non-empty value by source priority
  locale           TEXT,
  email_status     TEXT NOT NULL CHECK (email_status IN ('valid', 'role', 'typo_suspect')),
  suggested_email  TEXT,                  -- typo suggestion, never applied without an override
  flags            TEXT NOT NULL DEFAULT '[]', -- JSON array of Flag strings, sorted
  first_seen_at    TEXT,
  orphaned_at      TEXT,                  -- set when no source contains the address any more
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX contacts_domain ON contacts (email_domain);

-- One row per (contact, source).
CREATE TABLE contact_sources (
  contact_id     INTEGER NOT NULL REFERENCES contacts (id),
  source         TEXT NOT NULL REFERENCES sources (name),
  raw_email      TEXT NOT NULL,           -- raw cell value of the representative row
  first_seen_at  TEXT,
  last_seen_at   TEXT,
  occurrences    INTEGER NOT NULL DEFAULT 1, -- rows in this source that produced this address
  files          TEXT NOT NULL DEFAULT '[]', -- JSON array of file names
  raw_fields     TEXT NOT NULL DEFAULT '{}', -- JSON object: original columns of the representative row
  PRIMARY KEY (contact_id, source)
);
CREATE INDEX contact_sources_source ON contact_sources (source);

-- Consent per (contact, source). Default unknown; granted/denied only with evidence.
CREATE TABLE consents (
  contact_id   INTEGER NOT NULL REFERENCES contacts (id),
  source       TEXT NOT NULL REFERENCES sources (name),
  status       TEXT NOT NULL CHECK (status IN ('granted', 'denied', 'unknown')),
  evidence     TEXT,                      -- JSON: {"column","value","file","row_number"} or {"override": "..."}
  recorded_at  TEXT,
  PRIMARY KEY (contact_id, source)
);

-- Addresses that must never be sent to. Keyed by email, survives contact deletion. Append-only.
CREATE TABLE suppressions (
  id          INTEGER PRIMARY KEY,
  email       TEXT NOT NULL,              -- normalized
  reason      TEXT NOT NULL CHECK (reason IN ('unsubscribed', 'bounced', 'complained', 'manual')),
  source      TEXT NOT NULL,              -- 'override', a provider name, or a source label
  note        TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (email, reason, source)
);
CREATE INDEX suppressions_email ON suppressions (email);

-- Pipeline runs (clean-and-merge, imports, exports).
CREATE TABLE runs (
  id           TEXT PRIMARY KEY,          -- e.g. '20261126T104500Z'
  command      TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
  report_path  TEXT
);

-- Rows that produced no valid address. Replaced per source on every merge.
CREATE TABLE rejected_rows (
  id          INTEGER PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs (id),
  source      TEXT NOT NULL,
  file        TEXT NOT NULL,
  row_number  INTEGER NOT NULL,           -- 1-based data row (header rows excluded)
  raw_value   TEXT,
  reason      TEXT NOT NULL               -- RejectReason
);
CREATE INDEX rejected_rows_source ON rejected_rows (source);

-- File import history. Append-only.
CREATE TABLE imports (
  id           INTEGER PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs (id),
  source       TEXT NOT NULL,
  file         TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  encoding     TEXT NOT NULL,             -- encoding actually used
  rows_read    INTEGER NOT NULL,
  imported_at  TEXT NOT NULL
);

-- Provider sync history. Append-only.
CREATE TABLE sync_log (
  id           INTEGER PRIMARY KEY,
  provider     TEXT NOT NULL,
  direction    TEXT NOT NULL CHECK (direction IN ('push', 'pull')),
  dry_run      INTEGER NOT NULL CHECK (dry_run IN (0, 1)),
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  counts       TEXT NOT NULL DEFAULT '{}', -- JSON
  status       TEXT NOT NULL CHECK (status IN ('running', 'ok', 'failed'))
);
