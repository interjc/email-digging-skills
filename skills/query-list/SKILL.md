---
name: query-list
description: Runs read-only preset or custom SELECT queries against the merged SQLite mailing-list database with automatic output masking, or exports full query results locally to output/exports/. Use this to inspect counts, overlaps, consent breakdowns, sendable segments, or ad-hoc slices.
---

# query-list

## Purpose

Queries `workspace/database/mail-list.sqlite` in read-only mode (`PRAGMA query_only = ON`, single `SELECT` or `WITH ... SELECT` statement only). Results printed to `stdout` are masked fail-closed (D33): a text value is shown as-is only when SQLite traces its column to a known non-personal column (ids, dates, statuses, source names, flags, file names) or a preset declares it safe; emails get their field mask, `email_domain` is domain-masked outside the `domains` preset, `raw_value`/`note` become `<redacted>`, `raw_fields` and consent `evidence` have their JSON leaf values redacted, and names, computed expressions, and unknown columns are masked as free text. Numbers pass, so counts and aggregates over ids work. Meanwhile `--out` streams full unmasked results to a local CSV in `workspace/output/exports/` without printing personal data.

## Preconditions

- The workspace must exist, be initialized, and be git-ignored (exits `2` otherwise — stop and run `init-workspace` first). Run `clean-and-merge` first so the database has merged data.
- Follow all data rules in [AGENTS.md](../../AGENTS.md) and review table/view definitions in [docs/schema.md](../../docs/schema.md) (`contacts`, `sources`, `contact_sources`, `consents`, `suppressions`, `rejected_rows`, `imports`, `runs`, `sync_log`, `v_sendable_strict`, `v_not_blocked`, `v_source_overlap`).

## Commands

```sh
# Built-in presets: sources | overlap | only-in | sendable | domains | status | consent | orphaned
node scripts/query.ts --preset sources [--workspace <path>]
node scripts/query.ts --preset overlap [--workspace <path>]
node scripts/query.ts --preset only-in --source product-a --not-in product-b [--limit 50] [--workspace <path>]
node scripts/query.ts --preset sendable [--list strict|not_blocked] [--limit 50] [--workspace <path>]
node scripts/query.ts --preset domains [--workspace <path>]
node scripts/query.ts --preset status [--workspace <path>]
node scripts/query.ts --preset consent [--workspace <path>]
node scripts/query.ts --preset orphaned [--limit 50] [--workspace <path>]

# Custom read-only SQL (--limit defaults to 50; give duplicate column names distinct aliases)
node scripts/query.ts --sql "SELECT id, email, name FROM v_sendable_strict ORDER BY id" --limit 20 [--workspace <path>]

# Write full unmasked rows locally to output/exports/query-<timestamp>.csv (prints path and row count only)
node scripts/query.ts --preset sendable --out [--workspace <path>] [--json]
```

Exit codes: `0` ok; `1` invalid flags, non-SELECT SQL, or duplicate column names; `2` workspace precondition failed.

## Reading the output

- Without `--out`: prints sanitized JSON `{ "rows": [...], "count"?: number }` (`--preset sendable` includes total `count` alongside `--limit`-capped `rows`). Select real columns (for example `SELECT cs.source, count(*) ...`) rather than expressions when you need readable values: an expression such as `s.name || ''` or `max(name)` is masked.
- With `--out`: writes `output/exports/query-<timestamp>.csv` (mode `0600`) and prints only `<path> (<N> rows)` (or `{ "export_file", "row_count" }` with `--json`).

## Human decisions and where they live

- **Sendable list choice**: `strict` (`v_sendable_strict`, positive consent required) is the default; `not_blocked` (`v_not_blocked`) includes `unknown` consent and typo suspects and requires deliberate human choice per [docs/consent-policy.md](../../docs/consent-policy.md).
- **Data corrections**: record changes in `workspace/overrides/*.yaml`, `meta.md`, or `config.yaml` and re-run `clean-and-merge` rather than editing the database.

## Never do

- Never query `mail-list.sqlite` directly with `sqlite3` or read CSV files under `workspace/output/exports/` into context (both expose unmasked personal data).
- Never run mutating SQL (`INSERT`, `UPDATE`, `DELETE`, `DROP`), edit `workspace/resources/`, or print full email addresses.
- Never transfer `output/exports/` externally, write to providers, or send email without explicit human confirmation, and never delete database content.
