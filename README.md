# email-digging-skills

English | [简体中文](README.zh-CN.md)

A self-hosted mailing-list data pipeline that collects scattered customer email exports (CSV, TSV, XLSX, JSON, SQLite), tags them by source, cleans, normalizes, deduplicates, and merges them into a single local SQLite database — shipped as portable AI agent skills backed by plain CLI scripts.

## Why this exists

Over years of running products, forms, and events, customer addresses end up scattered across exports with different encodings (`CP932` / Windows-31J, `GB18030`, `UTF-16LE`, `UTF-8` with BOM), messy headers, multiple addresses in one cell, full-width characters, domain typos, and inconsistent consent columns.

Instead of treating a third-party ESP as your system of record, **email-digging-skills** keeps your own SQLite database (`workspace/database/mail-list.sqlite`) as the single source of truth:

- **Own your database**: raw exports stay read-only in `workspace/resources/`; human decisions live in versionable YAML files under `workspace/overrides/`; merges are idempotent and automatically backed up.
- **Sending platforms are downstream**: tools like Listmonk + Amazon SES receive filtered sendable lists from your database rather than owning your contact history or consent evidence.
- **Safe around AI agents**: CLI stdout, error messages, and run reports mask personal data (`t***@e***e.jp`, `山***`) by default so agents can orchestrate the pipeline without ingesting raw mailing lists into context.

## Status (Phase 1)

Phase 1 is complete and covers:

- Environment & workspace safety guard (`init-workspace`, including a one-command `--demo` run on synthetic fixtures).
- Source onboarding, encoding/header probing, and duplicate-file detection (`add-source`).
- Email normalization, multi-address cell splitting, role-address & domain-typo flagging, date & consent parsing, Parquet staging via DuckDB, transactional SQLite merge with backups, and masked Markdown/JSON reports (`clean-and-merge`).
- Pending human-decision extraction (`review-report`), read-only masked SQL & preset queries (`query-list`), and HMAC-SHA256 pseudonymized database copies (`mask-data`).
- Provider plugin interface (`providers/`) with a **Listmonk dry-run CSV export** (`export-to-provider`). Live provider API pushes (`--apply`), suppression pulls, paid bounce-verifier integration, and local web UI (`apps/`) are reserved for subsequent phases.

## Requirements

- **Node.js `>= 22.18`** — executes TypeScript directly via built-in type stripping and uses built-in `node:sqlite` (no build step).
- **`pnpm`** (`pnpm@12.23.0` configured in `package.json`).
- **DuckDB** — bundled via `@duckdb/node-api` (`2.0.1-r.1`); no external `duckdb` binary required.
- **One-time network access** on the first `pnpm init-workspace` run so DuckDB can install and cache the `excel` and `sqlite` extensions (`encodings` is optional; text decoding uses Node's `TextDecoder`).

## Quick start

Install dependencies and run the self-contained synthetic fixture demo (writes demo output under `workspace/.demo/` without touching your main `workspace/database/mail-list.sqlite`):

```sh
pnpm install
pnpm init-workspace --demo
```

Expected output:

```text
Workspace: /path/to/email-digging-skills/workspace

Check                                  Result                                                                                                        Fix
-------------------------------------  ------------------------------------------------------------------------------------------------------------  ---
Node.js >= 22.18                       ok (v26.7.0)
pnpm dependencies                      ok (installed)
DuckDB loads                           ok (v2.0.1)
DuckDB extension excel                 ok (loaded)
DuckDB extension sqlite                ok (loaded)
DuckDB extension encodings (optional)  ok (loaded)
Workspace location                     ok (inside the repository, git-ignored)
Workspace layout                       ok (created 9 directories)
config.yaml                            ok (created from config.example.yaml)
.env                                   ok (created from .env.example)
MASK_HMAC_KEY                          ok (generated (stored in .env, not shown))
Database                               ok (applied 0001_init, 0002_views)
git hooks                              ok (core.hooksPath set to .githooks)
Demo workspace layout                  ok (created 10 directories)
Demo fixtures                          ok (copied 24 file(s))
Demo database                          ok (applied 0001_init, 0002_views)
Demo pipeline run                      ok (36 contacts, 6 in 2+ sources, strict list 17, not blocked 29; report output/reports/20261126T122718Z.md)

Next: add-source <name>
```

Inspect the demo workspace right away:

```sh
node scripts/review-report.ts --workspace workspace/.demo
node scripts/query.ts --workspace workspace/.demo --preset domains
node scripts/export.ts --workspace workspace/.demo --provider listmonk
```

## Pipeline steps and skills

Every step is documented as an agent skill in [`skills/`](skills/README.md) and backed by a CLI in [`scripts/`](scripts/):

| Step | Skill | CLI command | What it does |
|---|---|---|---|
| 1 | [`init-workspace`](skills/init-workspace/SKILL.md) | `pnpm init-workspace [--demo]` | Checks runtime & git-ignore safety, creates workspace layout, `config.yaml`, `.env` (`MASK_HMAC_KEY`), SQLite schema, and Git hooks. |
| 2 | [`add-source`](skills/add-source/SKILL.md) | `node scripts/add-source.ts <name>` | Creates or probes `workspace/resources/<name>/`, detects encodings, columns, and duplicate files, and drafts `meta.md` (never overwriting an existing `meta.md`). |
| 3 | [`clean-and-merge`](skills/clean-and-merge/SKILL.md) | `node scripts/clean-and-merge.ts [--dry-run]` | Stages sources to Parquet, applies `workspace/overrides/*.yaml`, backs up SQLite, merges contacts/consents, and writes masked reports. |
| 4 | [`review-report`](skills/review-report/SKILL.md) | `node scripts/review-report.ts` | Prints masked pending decisions (typos, auto encodings, low-confidence mappings, `unknown` consent basis) and writes local `output/reports/pending-decisions.yaml`. |
| 5 | [`query-list`](skills/query-list/SKILL.md) | `node scripts/query.ts --preset <name>` / `--sql "<SELECT …>"` | Runs read-only masked queries (`sources`, `overlap`, `only-in`, `sendable`, `domains`, `status`, `consent`, `orphaned`, or custom `SELECT`), with optional `--out` CSV export. |
| 6 | [`mask-data`](skills/mask-data/SKILL.md) | `node scripts/mask-data.ts [--hash-domain] [--shape]` | Writes an HMAC-pseudonymized SQLite copy (`mail-list-masked.sqlite`) and optional `shape.json` to `workspace/output/masked/`. |
| 7 | [`export-to-provider`](skills/export-to-provider/SKILL.md) | `node scripts/export.ts --provider listmonk` | Writes a local Listmonk dry-run CSV (`strict` list by default) to `workspace/output/exports/` and records `sync_log`. |

Detailed specifications live in [`docs/`](docs/README.md):
- [Database schema & views](docs/schema.md)
- [Cleaning, encoding, date & merge rules](docs/cleaning-rules.md)
- [Source metadata (`meta.md`) template](docs/meta-template.md)
- [Consent policy & sendable lists](docs/consent-policy.md)
- [Masking & sharing boundary](docs/masking.md)

## Directory layout

```text
email-digging-skills/
├── AGENTS.md                  # Non-negotiable data and workflow rules for agents & humans
├── CLAUDE.md                  # Pointer to AGENTS.md
├── config.example.yaml        # Template copied to config.yaml (git-ignored) by init-workspace
├── .env.example               # Secret variable names copied to .env (git-ignored) by init-workspace
├── .githooks/pre-commit       # Staged-email scanner + optional gitleaks hook
├── .agents/skills -> ../skills
├── .claude/skills -> ../skills
├── skills/                    # Seven vendor-neutral agent skills (one SKILL.md per step)
├── docs/                      # Schema, cleaning, consent, masking, and meta.md specifications
├── scripts/                   # TypeScript CLI entry points, shared library (scripts/lib/), and tests
├── schema/migrations/         # Numbered SQLite DDL migrations (0001_init.sql, 0002_views.sql)
├── providers/                 # Downstream provider plugins (Phase 1: listmonk dry-run CSV)
├── apps/                      # Placeholder for future localhost (127.0.0.1) admin UI
├── fixtures/                  # Deterministic synthetic test sources, overrides, and expected counts
└── workspace/                 # Real data lives ONLY here (git-ignored; or set MAIL_PIPELINE_WORKSPACE)
    ├── resources/<source>/    # Read-only customer export files + meta.md (+ optional NOTES.txt)
    ├── overrides/             # Human YAML decisions: typo-decisions, suppressions, consents, exclude
    ├── output/                # Script-generated artifacts (safe to rebuild)
    │   ├── staging/           # Per-source Parquet rows, rejections, and stats.json
    │   ├── reports/           # Masked run reports (.md/.json) + local pending-decisions.yaml
    │   ├── masked/            # Pseudonymized SQLite copy & shape.json (only folder safe to share)
    │   └── exports/           # Local query & provider dry-run CSVs (contains full addresses)
    └── database/
        ├── mail-list.sqlite   # Canonical merged SQLite database
        └── backups/           # Automatic pre-merge database snapshots
```

## Data safety

1. **Workspace isolation & Git guard**: `workspace/*`, `config.yaml`, `.env*`, and data-file extensions (`*.sqlite`, `*.csv`, `*.xlsx`, `*.parquet`, etc. outside `fixtures/`) are git-ignored. Every CLI runs `checkWorkspaceSafety` first and exits `2` if the workspace (or any symlinked subdirectory) could be tracked by Git. You can place the workspace outside the repository via `MAIL_PIPELINE_WORKSPACE` or `config.yaml` (avoid cloud-synced folders like iCloud, Dropbox, OneDrive, or Google Drive).
2. **Read-only originals & no silent rewrites**: files in `workspace/resources/` are never modified. Suspected domain typos (such as `member@example.con` → `member@example.com`) are only flagged until a human explicitly accepts them in `workspace/overrides/typo-decisions.yaml`, and `raw_email` is always preserved.
3. **Default output masking (fail-closed queries)**: CLI summaries, error traces, JSON output, query stdout, and run reports sanitize and mask personal fields (`t***@e***e.jp`, `山***`, `***-****-**12`). Query stdout masking is fail-closed: only known non-personal columns or preset-safe columns pass as-is (address-sanitized), while computed expressions, unknown columns, and unredacted JSON values are masked.
4. **Pre-commit & CI scanning**: `.githooks/pre-commit` runs `node scripts/check-staged-emails.ts` (scanning UTF-8, UTF-16, CP932, GB18030, `.xlsx` XML, and binaries for non-`example.*` addresses) plus `gitleaks` when installed; GitHub Actions CI enforces both on every push and pull request.
5. **Strict sharing boundary**: **only files inside `workspace/output/masked/` may leave your machine** (after human review), and `MASK_HMAC_KEY` in `.env` must never be shared.

## Using with AI agents

- **Claude Code & Codex**: `.claude/skills` and `.agents/skills` are symlinks to [`skills/`](skills/), so both tools discover all seven pipeline skills automatically.
- **Any other agent**: point the agent at [`AGENTS.md`](AGENTS.md) and [`skills/`](skills/). Every `SKILL.md` uses agent-neutral instructions and plain `node` / `pnpm` shell commands with no vendor-specific tool dependencies.

## Consent and compliance note

Consent is recorded per `(contact, source)` along with original column/value evidence, and `suppressions` are append-only and override every grant. Exports default to `v_sendable_strict`, which requires positive consent (`granted` in a source or membership in a source configured to count as opt-in), no `denied` status in any source, no suppression, and no unresolved `typo_suspect`. Requesting the looser `v_not_blocked` view requires `--list not_blocked` and prints an explicit warning to `stderr`.

Anti-spam and privacy laws (including Japan's Act on Regulation of Transmission of Specified Electronic Mail / 特定電子メール法, GDPR, and CAN-SPAM) impose strict opt-in and evidence requirements for marketing mail. **This software and documentation do not constitute legal advice.** Always verify compliance for your jurisdiction, obtain explicit human approval before any external upload or send, and run bounce verification on your planned send list to protect sender reputation.

## Contributing, security, and changelog

- **Contributing**: see [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, TypeScript conventions, synthetic fixture regeneration, pre-commit checks, and how to add a provider adapter.
- **Code of Conduct**: see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- **Security & privacy reporting**: see [SECURITY.md](SECURITY.md) before reporting any leak, masking bypass, or vulnerability (never attach real customer data).
- **Changelog**: see [CHANGELOG.md](CHANGELOG.md) for Phase 1 features and known limitations.

## License

[MIT](LICENSE)
