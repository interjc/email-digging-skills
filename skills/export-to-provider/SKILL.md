---
name: export-to-provider
description: Generates a local dry-run subscriber export from the merged database for a downstream sending provider and logs the preview in sync_log. Use this when preparing a sendable contact list for Listmonk or another configured provider.
---

# export-to-provider

## Purpose

Runs a provider adapter under `providers/<name>/` (in Phase 1: `listmonk`) in dry-run mode against `workspace/database/mail-list.sqlite`, writes a local import file to `workspace/output/exports/` (for Listmonk: `listmonk-<list>-<timestamp>.csv` with columns `email,name,attributes` where `attributes` is JSON `{ sources, flags, locale, email_status }`), and appends a `dry_run = 1` record to `sync_log`. Phase 1 performs local CSV generation only and makes no provider API calls.

## Preconditions

- The workspace must exist, be initialized, and be git-ignored (exits `2` otherwise — stop and run `init-workspace` first).
- `clean-and-merge` and `review-report` have been run and pending human decisions (typos, consent basis, exclusions, suppressions) are up to date.
- Follow all rules in [AGENTS.md](../../AGENTS.md) and [docs/consent-policy.md](../../docs/consent-policy.md).

## Commands

```sh
# Default: export the strict opt-in sendable list (v_sendable_strict) as a dry-run CSV
node scripts/export.ts --provider listmonk [--workspace <path>]

# Explicit loose list (v_not_blocked; prints a consent/typo warning to stderr)
node scripts/export.ts --provider listmonk --list not_blocked [--workspace <path>]

# Machine-readable JSON PushPlan output
node scripts/export.ts --provider listmonk [--list strict|not_blocked] [--workspace <path>] --json
```

Phase 1 note: **`--apply` is not available in Phase 1**. Passing `--apply` refuses immediately with exit code `2` (`applying to a provider is not available in phase 1; it will require explicit human confirmation`).

Exit codes: `0` dry-run export written; `1` missing/unknown `--provider` or invalid `--list`; `2` workspace precondition failed, `.lock` held, or `--apply` passed.

## Reading the output

- Prints `<provider> <list> dry run: <N> to add, 0 to update, 0 to remove.`, the CSV path under `output/exports/`, and adapter notes (computing updates and removals requires live API comparison in a future phase).
- When `--list not_blocked` is passed, `stderr` warns that contacts without positive consent and unresolved typo suspects may be included.

## Human decisions and where they live

- **List selection (`strict` vs `not_blocked`)**: `strict` is the default and requires positive consent (`granted` in a source or membership in a source with `counts_as_opt_in = 1`, no `denied`, no suppression, not `typo_suspect`). Use `--list not_blocked` only when explicitly requested by the human after reviewing applicable email regulations.
- **Consent and block configuration**: `consent.opt_in_bases` and `consent.opt_in_sources` in `config.yaml`; `consent_basis` in `meta.md`; row overrides and blocks in `workspace/overrides/{consents,suppressions,typo-decisions,exclude}.yaml`.
- **External upload / verification / sending**: writing a local dry-run CSV does **not** authorize uploading it to Listmonk, sending addresses to an external email verification service, or sending mail. Ask a human for explicit confirmation before any external write or transfer. Provider secrets (`LISTMONK_URL`, `LISTMONK_USERNAME`, `LISTMONK_API_TOKEN`, `LISTMONK_LIST_ID`) live only in `.env`.

## Never do

- Never read the exported CSV in `workspace/output/exports/` into context or print full email addresses.
- Never push to an external provider, upload to a third-party verifier, or send email without explicit human confirmation.
- Never read `.env` secrets, edit `workspace/resources/`, or delete database content.
