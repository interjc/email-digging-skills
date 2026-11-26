# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`init-workspace` skill and CLI** (`scripts/init-workspace.ts`): verifies Node.js (`>= 22.18`), `pnpm` dependencies, and DuckDB extensions (`excel`, `sqlite`, optional `encodings`), enforces the Git-ignore workspace safety guard (including symlinked paths and non-repository worktrees), initializes workspace directories, copies `config.example.yaml` and `.env.example`, generates `MASK_HMAC_KEY`, applies SQLite migrations, configures `.githooks`, and supports `--demo` to run the full pipeline on synthetic fixtures under `workspace/.demo/`.
- **`add-source` skill and CLI** (`scripts/add-source.ts`): creates or probes `workspace/resources/<name>/`, reads CSV, TSV/TXT, XLSX, JSON/JSONL, and SQLite (`.db`/`.sqlite`/`.sqlite3`) files, detects text encodings and column mappings (`email`, `name`, `created_at`, `last_seen_at`, `locale`, `consent`), flags suspected duplicate files regardless of column or row order, ignores subdirectories, prints masked sample values, and writes `meta.md` (or `meta.draft.md` without overwriting an existing `meta.md`).
- **`clean-and-merge` skill and CLI** (`scripts/clean-and-merge.ts`): validates every `meta.md`, decodes non-UTF-8 text in Node (`cp932`, `gb18030`, `utf-16le`, `utf-16be`), normalizes NFKC widths and splits multi-address cells, flags role addresses and domain typos without modifying `raw_email`, parses Japanese/ISO/Excel/English month-name dates, stages Parquet files via DuckDB, applies YAML overrides (`typo-decisions.yaml`, `suppressions.yaml`, `consents.yaml`, `exclude.yaml`), backs up SQLite, merges idempotently in a single transaction with orphan tracking, and writes masked Markdown/JSON run reports (plus `--dry-run` and `--dry-run --source <name>`).
- **`review-report` skill and CLI** (`scripts/review-report.ts`): prints a masked summary of unresolved typo suspects, auto-detected encodings, low-confidence column mappings, sources missing `meta.md`, sources with `consent_basis: unknown`, newly orphaned contacts, and warnings, while writing ready-to-edit YAML templates locally to `output/reports/pending-decisions.yaml`.
- **Offline provider-distance typo detection and `check-domains` skill/CLI** (`scripts/lib/rules/providers.json`, `scripts/lib/email/providers.ts`, `scripts/lib/email/dns-check.ts`, `scripts/check-domains.ts`, `skills/check-domains/SKILL.md`): falls back to conservative OSA distance-1 matching against a curated list of full provider domains (skipping known-real domains, ties, short differing labels, and label-count mismatches) when exact/suffix typo rules do not match; adds an injected-resolver RFC 5321 §5.1 / RFC 7505 DNS classifier (`accepts` / `refuses` / `unknown`); and provides `check-domains [--dns]` to sort undecided typo suspects into `obvious` (pre-filled `action: accept` with DNS evidence) and `ambiguous` (`action: null` with reason) in `output/reports/domain-check.yaml` without writing to `overrides/`.
- **`query-list` skill and CLI** (`scripts/query.ts`): executes read-only preset (`sources`, `overlap`, `only-in`, `sendable`, `domains`, `status`, `consent`, `orphaned`) and custom `SELECT` / `WITH ... SELECT` queries with fail-closed output masking, plus local `--out` CSV export under `output/exports/`.
- **`mask-data` skill and CLI** (`scripts/mask-data.ts`): generates an HMAC-SHA256 pseudonymized copy (`output/masked/mail-list-masked.sqlite`) with optional domain hashing (`--hash-domain`) and data-shape summary (`--shape` → `output/masked/shape.json`), blanking non-email personal fields.
- **`export-to-provider` skill and CLI** (`scripts/export.ts`, `providers/listmonk/`): provider plugin contract and Listmonk dry-run CSV export defaulting to `v_sendable_strict` (with an explicit warning on `stderr` for `--list not_blocked`) and recording dry runs in `sync_log`; `--apply` is disabled in Phase 1.
- **Pre-commit and CI safety checks**: `scripts/check-staged-emails.ts` (scanning UTF-8, UTF-16, CP932, GB18030, `.xlsx` XML, and binary ASCII runs for non-`example.*` addresses), `.githooks/pre-commit`, `.gitleaks.toml`, deterministic synthetic fixtures (`scripts/make-fixtures.ts`), and GitHub Actions CI.
- **Vendor-neutral skills and specifications**: seven skills under `skills/` (symlinked from `.claude/skills` and `.agents/skills`), specifications under `docs/`, and bilingual documentation (`README.md`, `README.zh-CN.md`).

- **`check-domains --auto-accept`**: standing rule that writes accept decisions for typo suggestions to curated popular providers into `overrides/typo-decisions.yaml` (other suggestions stay for human review).

### Known limitations

- **XLSX column width limit**: Excel spreadsheets with data beyond column `ZZ` are not read past `ZZ` (the probe and staging warn when column `ZZ` is non-empty).
- **Backup retention clock assumption**: Automatic backup pruning (`backups.keep`) orders backups by UTC timestamp and assumes a monotonic system clock.
- **Concurrent `init-workspace` runs**: Running two `init-workspace` invocations simultaneously against the same repository can race when creating `.env` and `config.yaml` (initialization is intended as a one-time setup step).
- **Manual stale-lock cleanup**: If a mutating command crashes and leaves `<workspace>/.lock` behind, subsequent mutating commands refuse to run and report the stale lock so a human can verify workspace integrity and remove `.lock` manually.
- **Duplicate column names in `query`**: Custom SQL queries that return duplicate result column names are refused; provide distinct column aliases (`AS ...`).
- **Phase 1 provider scope & deferred production hardening**: Live provider API pushes (`--apply`), suppression pulls, paid email-verification integration, and the localhost web UI (`apps/`) are not implemented yet. Before using `export` or `mask-data` outputs in production external workflows, several remaining hardening items are tracked for a follow-up release:
  - Recording `export` audit entries in `sync_log` under the same transaction/lock boundary as the database read
  - Validating database symlink targets in read-only `query` and `export` invocations against cross-workspace symlinked files
  - Acquiring a workspace lock or consistent snapshot for `query --out`
  - Publishing `mail-list-masked.sqlite` and `shape.json` together atomically in `mask-data`
  - Attributing `shape.json` null rates, statuses, and flags strictly per source file rather than sharing representative contact rows across all contributing files
  - Supporting non-ASCII (Unicode) CTE names in read-only `WITH ... SELECT` validation
