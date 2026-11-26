---
name: mask-data
description: Produces a pseudonymized SQLite copy and optional data-shape summary under workspace/output/masked/ without modifying the main database. Use this before sharing data for debugging, issue reports, or external analysis.
---

# mask-data

## Purpose

Creates `workspace/output/masked/mail-list-masked.sqlite` from `database/mail-list.sqlite` using `MASK_HMAC_KEY` in `.env` without changing the main database. Normalized email local parts become `u<16-hex>` (HMAC-SHA256 over the full normalized address), keeping deduplication and cross-source overlap identical for the same key. Non-email personal fields (`contacts.name`, `contacts.locale`, `sources.label`, `suppressions.note`, non-email values in `raw_fields`, unrecognized values in `consents.evidence`) are blanked, and `rejected_rows.raw_value` is replaced with `<redacted len=N>`. With `--shape`, also writes `workspace/output/masked/shape.json` summarizing encodings, row counts, column null rates, statuses, flags, and rejection counts.

## Preconditions

- The workspace must exist, be initialized, and be git-ignored, `.env` must contain a non-empty `MASK_HMAC_KEY`, and `mail-list.sqlite` must match `schema/migrations/`. Missing workspace or `MASK_HMAC_KEY` exits `2` — stop and run `init-workspace` first.
- Follow all rules in [AGENTS.md](../../AGENTS.md) and [docs/masking.md](../../docs/masking.md).

## Commands

```sh
# Generate masked SQLite copy (uses masking.keep_domain from config.yaml; default true)
node scripts/mask-data.ts [--workspace <path>]

# Also hash domains (d<8-hex>.invalid) and write output/masked/shape.json
node scripts/mask-data.ts --hash-domain --shape [--workspace <path>]

# Machine-readable JSON output
node scripts/mask-data.ts [--hash-domain] [--shape] [--workspace <path>] --json
```

Exit codes: `0` ok; `1` schema mismatch or invalid JSON in database; `2` missing workspace, missing `MASK_HMAC_KEY`, or `.lock` held.

## Reading the output

- Prints `<workspace>/output/masked/mail-list-masked.sqlite (<N> contacts; domains kept|hashed)`, optional `<workspace>/output/masked/shape.json`, and `Only output/masked/ may leave this machine. Review masked files before sharing.`
- `--json` prints `{ masked_db, shape_file, keep_domain, rows, note }` with per-table row counts.

## Human decisions and where they live

- **Domain retention vs hashing**: `masking.keep_domain: true` in `config.yaml` preserves real domains so domain distribution stays visible, but retained corporate or niche domains plus overlap patterns can still reveal affiliations. Ask the human whether to pass `--hash-domain` (or set `masking.keep_domain: false` in `config.yaml`) and have the human review `output/masked/` before sharing.
- **Repository fixtures**: never copy `output/masked/` into `fixtures/`. Synthetic test data in the repository is generated only via `node scripts/make-fixtures.ts` using `example.*` domains.

## Never do

- Never read or print `.env` or `MASK_HMAC_KEY` (leaking the key lets anyone test candidate addresses against the HMAC tokens).
- Never share files outside `workspace/output/masked/` (`resources/`, `staging/`, `reports/`, `exports/`, `database/`, and `overrides/` stay on the machine).
- Never read raw `workspace/resources/` files into context, print full email addresses, edit `resources/`, write to external providers without confirmation, or delete database content.
