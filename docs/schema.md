# Database schema

The main database is `workspace/database/mail-list.sqlite` (paths are relative to the
configured workspace). DuckDB reads and stages source files. `node:sqlite` writes the main
database. The numbered [migrations](../schema/migrations/) define the actual schema.

Migration and pipeline timestamps are stored as ISO-8601 UTC text. Dates taken from source rows
follow the [date cleaning rules](cleaning-rules.md#dates); they are not converted to UTC.
JSON values are stored as text.

## Tables

### `schema_migrations`

One row per applied migration. The migration runner appends a row when it applies a migration.
Merges do not change this table.

| Column | Meaning |
|---|---|
| `version` | Primary key. Migration filename without `.sql`, such as `0001_init`. |
| `applied_at` | When the migration was applied. |

### `sources`

One row per source directory. The merge upserts metadata and resolved settings by source name.

| Column | Meaning |
|---|---|
| `name` | Primary key. Source directory name, using lowercase letters, digits and hyphens. |
| `kind` | `product`, `event` or `other`. |
| `label` | Optional human-readable label. |
| `consent_basis` | `opt_in`, `transactional` or `unknown` (database default). |
| `counts_as_opt_in` | `0` or `1`. Resolved from the source basis and configured source names; database default `0`. |
| `priority` | Resolved merge order, with `1` first. |
| `exported_at` | Source export date from metadata, if known. |
| `updated_at` | When the stored source settings were updated. |

### `contacts`

One row per normalized address. The merge upserts by `email` and keeps the same `id` for the
same address. Contacts are not rebuilt or automatically deleted.

| Column | Meaning |
|---|---|
| `id` | Stable integer primary key. |
| `email` | Unique normalized address. |
| `email_domain` | Domain part of the normalized address. |
| `name` | First non-empty name by source priority. |
| `locale` | First non-empty locale by source priority. |
| `email_status` | `valid`, `role` or `typo_suspect`. |
| `suggested_email` | Suggested correction, if any. Not applied without an override. |
| `flags` | Sorted, deduplicated JSON array of flags. Defaults to `[]`. |
| `first_seen_at` | Contact-level first-seen date, if known. |
| `orphaned_at` | Set when the address is no longer in any source; null when present. |
| `created_at` | When the contact row was created. |
| `updated_at` | When the contact row was updated. |

### `contact_sources`

One row per `(contact_id, source)` (the composite primary key). The merge rebuilds the current
source memberships from staged data. This table is not an import history.

| Column | Meaning |
|---|---|
| `contact_id` | References `contacts.id`. |
| `source` | References `sources.name`. |
| `raw_email` | Uncorrected email input from the representative source row. |
| `first_seen_at` | First-seen date from source data, or null if unavailable. |
| `last_seen_at` | Last-seen date from source data, or null if unavailable. |
| `occurrences` | Number of rows in the source that produced the address. Defaults to `1`. |
| `files` | JSON array of contributing filenames. Defaults to `[]`. |
| `raw_fields` | JSON object of original columns from the representative row. Defaults to `{}`. When the address has several rows in the source (for example two user ids), `_merged_rows` lists the other rows, most recent first, as `{file, row_number, fields}` with only the differing values, capped at 20; `_merged_rows_omitted` counts the rest (D36). |

### `consents`

One row per `(contact_id, source)` (the composite primary key). The merge rebuilds the current
per-source decision from rows and overrides. It is not a history of consent changes.

| Column | Meaning |
|---|---|
| `contact_id` | References `contacts.id`. |
| `source` | References `sources.name`. |
| `status` | `granted`, `denied` or `unknown`. |
| `evidence` | Nullable JSON. Source evidence has `column`, `value`, `file` and `row_number`; override evidence has `override`. |
| `recorded_at` | When the consent was recorded, if available. |

### `suppressions`

One row per distinct `(email, reason, source)`. The merge appends entries from human overrides
once; duplicates are not reinserted. A future provider pull can append entries. Suppressions
have no contact foreign key and survive contact deletion.

| Column | Meaning |
|---|---|
| `id` | Integer primary key. |
| `email` | Normalized address to block. |
| `reason` | `unsubscribed`, `bounced`, `complained` or `manual`. |
| `source` | `override`, a provider name or a source label. |
| `note` | Optional explanation. |
| `created_at` | When the suppression was added. |

### `runs`

One row per recorded pipeline run. The running command records and finishes its own row.
Past runs are not rebuilt. A failure before the command touches the database does not
change the table.

| Column | Meaning |
|---|---|
| `id` | Text primary key, for example `20261126T104500Z`. |
| `command` | Pipeline command, such as `clean-and-merge`. |
| `started_at` | Run start time. |
| `finished_at` | Run finish time, or null while running. |
| `status` | `running`, `ok` or `failed`. |
| `report_path` | Path to the run report, if available. |

### `rejected_rows`

One row per recorded rejection. The merge replaces the rejection rows for each processed
source; this is not a rejection history.

| Column | Meaning |
|---|---|
| `id` | Integer primary key. |
| `run_id` | References `runs.id`. |
| `source` | Source label. |
| `file` | Input filename. |
| `row_number` | One-based data row number, excluding headers. |
| `raw_value` | Original value, if present. |
| `reason` | `empty`, `invalid_syntax` or `excluded_by_override`. |

### `imports`

One row per imported file per run. The merge appends entries even when the file did not change.

| Column | Meaning |
|---|---|
| `id` | Integer primary key. |
| `run_id` | References `runs.id`. |
| `source` | Source label. |
| `file` | Input filename. |
| `sha256` | SHA-256 digest of the input file. |
| `encoding` | Resolved text encoding. The column is not nullable. |
| `rows_read` | Number of input data rows read. |
| `imported_at` | When the file was imported. |

### `sync_log`

One row per provider operation, written by provider tooling, not by the merge. This is an
append-only log. Phase 1 has a Listmonk dry-run CSV export only; it makes no provider API calls.

| Column | Meaning |
|---|---|
| `id` | Integer primary key. |
| `provider` | Provider name. |
| `direction` | `push` or `pull`. |
| `dry_run` | `1` for a dry run, `0` otherwise. |
| `started_at` | Operation start time. |
| `finished_at` | Operation finish time, if available. |
| `counts` | JSON object of operation counts. Defaults to `{}`. |
| `status` | `running`, `ok` or `failed`. |

## Merge lifecycle

Back up the existing database to `workspace/database/backups/` before every merge. The changes
to merged data are made in one transaction. If the merge fails, roll back the transaction and
keep the backup. Upsert `sources` and `contacts`, rebuild the derived memberships and consents,
and replace current rejects for processed sources. Append new suppression and import entries.
Record the run in `runs`; do not touch `schema_migrations` or `sync_log` as part of the merge.

Set `orphaned_at` when an address disappears from all sources, rather than deleting its
contact. Clear it if the address returns. Neither sendable view includes orphaned contacts.
Rerunning unchanged inputs preserves contact IDs and the merged contact, membership and
consent results, while adding import and run history. Deleting contacts needs separate human
confirmation and is not part of Phase 1.

`imports.encoding` is `n/a` for XLSX and SQLite files. When a source directory is removed
entirely, its `sources`, `contact_sources`, `consents` and `rejected_rows` rows stay and the
report warns; removing them is a separate, confirmed operation (not in Phase 1).

## Views

Views read the tables at query time. The migration creates them; merges do not write or
rebuild them.

| View | Columns and filter |
|---|---|
| `v_not_blocked` | All `contacts` columns. Excludes orphaned and suppressed addresses and contacts with any `denied` consent. Does not require positive consent or filter out typo suspects. |
| `v_sendable_strict` | All `contacts` columns. Requires membership in `v_not_blocked`, excludes `typo_suspect`, and requires either a `granted` consent or a membership in a source with `counts_as_opt_in = 1`. Default for export. |
| `v_source_overlap` | `source_a`, `source_b`, `contacts` (the count). Counts shared contact IDs per ordered pair with a match. The diagonal gives each represented source's size; pairs with no shared contacts have no row. |

The loose export needs an explicit flag and prints a warning. See the
[consent policy](consent-policy.md) for the difference between the two lists.

## Example queries

Run these read-only queries locally. Display only masked values and limited samples, not
whole contact lists.

**Contacts from Product A but not Product B** (`product-a` and `product-b` are example source names):

```sql
SELECT c.id, c.email
FROM contacts AS c
JOIN contact_sources AS a ON a.contact_id = c.id
WHERE a.source = 'product-a'
  AND NOT EXISTS (
    SELECT 1
    FROM contact_sources AS b
    WHERE b.contact_id = c.id AND b.source = 'product-b'
  )
ORDER BY c.id;
```

**Pairwise overlap** (one row per unordered pair, including zero counts):

```sql
SELECT a.name AS source_a, b.name AS source_b, COALESCE(o.contacts, 0) AS contacts
FROM sources AS a
JOIN sources AS b ON a.name < b.name
LEFT JOIN v_source_overlap AS o ON o.source_a = a.name AND o.source_b = b.name
ORDER BY a.name, b.name;
```

**Sendable lists** (strict default first; the second query is the broader requirements list):

```sql
SELECT id, email FROM v_sendable_strict ORDER BY id;
SELECT id, email FROM v_not_blocked ORDER BY id;
```

## Changing the schema and porting to Postgres

Never edit an applied migration. Add the next numbered `.sql` file to
[`schema/migrations/`](../schema/migrations/) for every schema change.

The core DDL avoids SQLite-only functions. It uses ISO-8601 UTC text timestamps and stores
JSON as `TEXT`. For a Postgres port, the `0001_init.sql` header calls for replacing
`INTEGER PRIMARY KEY` with `BIGINT GENERATED ALWAYS AS IDENTITY` for integer IDs and
changing JSON `TEXT` columns to `JSONB`.
