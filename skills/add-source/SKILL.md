---
name: add-source
description: Creates or probes a customer data source directory under workspace/resources/<name>/, detects file encodings, headers, column mappings, and duplicate exports, and drafts meta.md. Use this whenever onboarding a new source or adding new export files to an existing source.
---

# add-source

## Purpose

Onboards a source directory `workspace/resources/<name>/` (`<name>` uses lowercase letters, digits, and single hyphens, such as `product-a` or `event-2025-tokyo`). It probes regular data files (`.csv`, `.tsv`/`.txt`, `.xlsx`, `.json`, `.db`/`.sqlite`), detects text encodings and standard column mappings (`email`, `name`, `created_at`, `last_seen_at`, `locale`, `consent`), flags suspected duplicate files, prints up to three masked sample values per mapped column, and writes a metadata draft.

## Preconditions

- The workspace must exist, be initialized, and be git-ignored. If missing or unsafe, the CLI exits `2` — stop and run `init-workspace` first.
- Follow all data rules in [AGENTS.md](../../AGENTS.md) and metadata rules in [docs/meta-template.md](../../docs/meta-template.md).
- Legacy `.xls` spreadsheets must be converted to `.xlsx` by the human before probing.
- If `workspace/resources/<name>/NOTES.txt` is present, read `NOTES.txt` first for human notes on provenance, export dates, or known quirks (never echo any unmasked address if one appears there). `NOTES.txt`, `meta.md`, `meta.draft.md`, `.md` files, dotfiles, and subdirectories are never read as data.

## Commands

```sh
# 1. Create workspace/resources/<name>/ (if missing) or probe files already placed there
node scripts/add-source.ts <name> [--workspace <path>]

# Machine-readable sanitized JSON report
node scripts/add-source.ts <name> [--workspace <path>] --json
```

Behavior on `meta.md`:
- Directory missing: creates `workspace/resources/<name>/` and asks for original export files to be placed there unmodified, then re-run.
- No `meta.md` yet: writes `workspace/resources/<name>/meta.md` with exclusive create.
- `meta.md` already exists: **never overwrites `meta.md`**; keeps valid settings from `meta.md`, probes existing and newly added files, and writes `workspace/resources/<name>/meta.draft.md`.

Exit codes: `0` ok; `1` invalid source name or CLI arguments; `2` workspace precondition or `.lock` failure.

## Reading the output

- Per file: `format`, `encoding` (`meta`, `bom`, `detected`, or `n/a` for XLSX/SQLite, plus `candidates` when multiple encodings decoded), `rows`, `suspected duplicate of <file>` (identical header set and row multiset regardless of column or row order), sanitized `headers`, and mapped fields `[how, confidence]` with masked samples (`t***@e***e.jp`, `山***`).
- `Warnings:` reports ignored subdirectories (`subdirectory ignored: <dir>/`) or unreadable files.
- `Please confirm:` lists every item requiring human confirmation before merging.

## Human decisions and where they live

- **Suspected duplicates** (`meta.md`): duplicate candidates are commented out (`# suspected duplicate of <file>`). Confirm with the human whether to keep them commented out or include them.
- **Auto-detected encodings** (`meta.md`): non-UTF-8 detections (`cp932`, `gb18030`) and multi-candidate detections stay `encoding: auto` in the draft. Confirm with the human and set the explicit `encoding:` in `meta.md`.
- **Columns and file options** (`meta.md`): confirm guesses below `0.8` confidence (written as comments), missing `email` mappings, `header_row` when title rows precede headers, `sheet` (XLSX), `table` or read-only `query` (multi-table SQLite), `delimiter`, and custom `consent_values`.
- **Source provenance** (`meta.md`): confirm `kind` (`product`, `event`, `other`), `label`, `consent_basis` (`opt_in`, `transactional`, `unknown`), and `exported_at` (`YYYY-MM-DD`). When `meta.draft.md` was written, merge confirmed changes into `meta.md` only with human approval.
- **Test accounts** (`workspace/overrides/exclude.yaml`): record test addresses or patterns there instead of editing source files.

## Never do

- Never read raw data files (`.csv`, `.tsv`, `.txt`, `.xlsx`, `.json`, `.db`, `.sqlite`) into context or print full email addresses.
- Never overwrite an existing `meta.md` automatically or modify/delete files in `workspace/resources/`.
- Never write to external providers without human confirmation or delete database content.
