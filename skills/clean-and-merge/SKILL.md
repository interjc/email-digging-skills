---
name: clean-and-merge
description: Validates source metadata, stages and cleans customer email exports with DuckDB, applies human overrides, backs up and merges contacts into SQLite, and writes a masked report. Use this after sources have confirmed meta.md files or after updating overrides.
---

# clean-and-merge

## Purpose

Runs the core cleaning and merge pipeline across `workspace/resources/*/`: validates every `meta.md`, decodes text inputs, normalizes and splits email cells, flags role addresses and domain typos without rewriting originals, stages Parquet files under `output/staging/<source>/`, applies `workspace/overrides/*.yaml`, backs up `database/mail-list.sqlite` to `database/backups/`, merges all sources in one SQLite transaction, and writes masked reports to `output/reports/<run_id>.{md,json}` and `output/reports/latest.{md,json}`.

## Preconditions

- The workspace must exist, be initialized, and be git-ignored. Otherwise the CLI exits `2` — stop and run `init-workspace` first.
- Follow all data rules in [AGENTS.md](../../AGENTS.md) and [docs/cleaning-rules.md](../../docs/cleaning-rules.md).
- **Before the first run against real data in `workspace/resources/`**: ask the human to confirm that their export files and `meta.md` files are in place and ready.
- **Run `--dry-run` first** whenever adding or updating sources, `meta.md`, or overrides, and inspect the dry-run summary before running a real merge.

## Commands

```sh
# 1. Dry run across all sources with meta.md (stages and writes report; database untouched)
node scripts/clean-and-merge.ts --dry-run [--workspace <path>]

# Dry run for one or more specific sources (--source requires --dry-run)
node scripts/clean-and-merge.ts --dry-run --source <name> [--source <other>] [--workspace <path>]

# 2. Full merge into database/mail-list.sqlite (always processes every source with meta.md)
node scripts/clean-and-merge.ts [--workspace <path>]

# Machine-readable sanitized JSON summary
node scripts/clean-and-merge.ts [--dry-run] [--workspace <path>] --json
```

Note: `--source` is rejected without `--dry-run` so that every real merge recomputes derived memberships and consents consistently across all sources. Invalid `meta.md` or a source missing an email column stops before touching the database.

Exit codes: `0` when status is `ok` or `dry-run`; `1` on invalid `meta.md`, staging error, or rolled-back merge failure; `2` on workspace precondition or `.lock` failure.

## Reading the output

- Prints run ID and status (`dry-run`, `ok`, `failed`), `Sources processed`, skipped directories without `meta.md`, `Rows read` (`empty`, `invalid`, `role`, `typo suspects`), `Staged addresses` (dry run) or `Contacts` (`new`, `newly orphaned`, `in 2+ sources`), `Same address, several rows in one source` (only when there are any: `stacked`, `capped`, `largest`; see D36 in the cleaning rules) with `Overrides applied`, `To review` counts, `Warnings`, `Backup` path, and `Report` path.
- Run `review-report` next to inspect unresolved items. If report writing fails after a merge commit, fix the filesystem cause and re-run `clean-and-merge` (merges are full and idempotent).

## Human decisions and where they live

- **Source metadata** (`workspace/resources/<source>/meta.md`): fix invalid fields, confirm `encoding`, low-confidence `columns`, `consent_basis`, and unlisted files.
- **Overrides** (`workspace/overrides/`): `typo-decisions.yaml` (`accept` or `reject`), `suppressions.yaml` (append-only blocks), `consents.yaml` (per-email, per-source status), `exclude.yaml` (exact email or glob pattern).
- **Merge priority and opt-in config** (`config.yaml`): `sources.priority`, `consent.opt_in_bases`, `consent.opt_in_sources`, `backups.keep`.

## Never do

- Never read raw files in `workspace/resources/`, Parquet files in `output/staging/`, or unmasked SQLite rows into context, and never print full email addresses.
- Never rewrite an original email value or apply typo suggestions without a human entry in `overrides/typo-decisions.yaml`.
- Never edit `workspace/resources/` or `workspace/output/` manually, write to external providers without confirmation, or delete database content (addresses absent from all sources are only marked `orphaned_at`).
