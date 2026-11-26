---
name: review-report
description: Summarizes pending human decisions from the latest clean-and-merge run and writes ready-to-edit YAML templates to output/reports/pending-decisions.yaml. Use this after clean-and-merge to guide typo, encoding, column-mapping, and consent-basis reviews.
---

# review-report

## Purpose

Reads `output/reports/latest.json`, staging `stats.json`, `workspace/overrides/`, and `database/mail-list.sqlite` to collect every unresolved item from the latest run: undecided typo suspects, auto-detected encodings needing confirmation, column mappings below `0.8` confidence, source directories missing `meta.md`, sources with `consent_basis: unknown`, newly orphaned contacts, and override/run warnings. Prints a masked summary to `stdout` and writes `output/reports/pending-decisions.yaml` with full values and ready-to-edit YAML entries for the human on disk.

## Preconditions

- The workspace must exist, be initialized, and be git-ignored, and `output/reports/latest.json` must exist from a prior `clean-and-merge` run. Otherwise the CLI exits `2` — stop and run `init-workspace` or `clean-and-merge` first.
- If the latest committed merge failed to publish its report, `review-report` exits `2` so stale reports are not reviewed; re-run `clean-and-merge` first.
- Follow all data rules in [AGENTS.md](../../AGENTS.md) and [docs/cleaning-rules.md](../../docs/cleaning-rules.md).

## Commands

```sh
# Masked human-readable summary + writes output/reports/pending-decisions.yaml
node scripts/review-report.ts [--workspace <path>]

# Masked JSON output (addresses in typo_decisions and orphaned are masked)
node scripts/review-report.ts [--workspace <path>] --json
```

Exit codes: `0` ok; `1` unexpected runtime error; `2` missing workspace, missing or stale report, or `.lock` held.

## Reading the output

- `stdout` displays up to 20 masked items per category:
  - `Typo suspects without a decision`: e.g. `y***@e***e.con → y***@e***e.com (shop-alpha)`.
  - `Encodings to confirm`: auto-detected non-UTF-8 encodings or files with multiple candidate encodings (plain single-candidate UTF-8 is not flagged).
  - `Column mappings below 0.8`: header/content guesses with `[how, confidence]`.
  - `Sources without meta.md` and `Sources with consent_basis unknown`.
  - `Contacts orphaned by this run`: informational only; orphaned contacts are excluded from sendable views and never deleted automatically.
  - `Override warnings` and `Other warnings`: duplicate override keys, unlisted files in source directories, etc.
- The last line prints the path to `output/reports/pending-decisions.yaml` so the human can inspect unmasked addresses locally.

## Human decisions and where they live

- **Typo suspects** → optionally run [`check-domains`](../check-domains/SKILL.md) (`node scripts/check-domains.ts --dns`) to sort undecided suspects into `obvious` and `ambiguous` in `output/reports/domain-check.yaml`; the human then reviews `output/reports/pending-decisions.yaml` (or `domain-check.yaml`) locally and moves chosen entries into `workspace/overrides/typo-decisions.yaml` with `action: accept` (replaces normalized email on next merge, preserves `raw_email`, adds `typo_accepted`) or `action: reject`.
- **Encodings, column mappings, and `consent_basis`** → human updates `workspace/resources/<source>/meta.md`.
- **Sources without `meta.md`** → run `add-source <name>`.
- **Suppressions, consent overrides, and exclusions** → `workspace/overrides/{suppressions,consents,exclude}.yaml`.
- Re-run `clean-and-merge` after saving edits so decisions take effect in SQLite.

## Never do

- **Never read `output/reports/pending-decisions.yaml` into agent context** — it contains full, unmasked customer email addresses for local human editing only. Read only the masked `stdout`/`--json` output or masked `output/reports/latest.md`.
- Never decide typo accept/reject, consent status, or opt-in basis on behalf of the human.
- Never read raw `workspace/resources/` files, print full addresses, edit `resources/`, write to external providers without confirmation, or delete database content.
