---
name: check-domains
description: Sorts undecided domain-typo suspects into obvious and ambiguous buckets using optional DNS checks and writes copy-ready review entries to output/reports/domain-check.yaml. Use this after clean-and-merge or review-report to speed up human typo review without auto-applying fixes.
---

# check-domains

## Purpose

Reads undecided `typo_suspect` contacts (`orphaned_at IS NULL`, not yet in `workspace/overrides/typo-decisions.yaml`) from `database/mail-list.sqlite` and sorts them into two lists:

- **Obvious**: with `--dns`, the typed domain refuses mail (`ENOTFOUND`, null MX per RFC 7505, or non-resolving MX exchanges) **and** the suggested domain accepts mail (MX resolving to A/AAAA, or A/AAAA fallback per RFC 5321 §5.1). Pre-filled with `action: accept` and the DNS evidence in `note`.
- **Ambiguous**: everything else — including when `--dns` is omitted, when the typed domain accepts mail, when the suggested domain refuses mail, or when the final verdict for either domain is `unknown` (for example every lookup timed out or failed with `ESERVFAIL` / `ECONNREFUSED`; one temporary error is not enough when another MX host of the same domain resolves). Written with `action: null` and the reason.

Prints a masked summary to `stdout` (obvious first, then ambiguous) and writes full, copy-ready entries to `output/reports/domain-check.yaml`. Never modifies the database, and writes to `workspace/overrides/` only with `--auto-accept` (D35).

## Preconditions

- The workspace must exist, be initialized, and be git-ignored. Otherwise the CLI exits `2` — stop and run `init-workspace` first.
- Run `clean-and-merge` first so `database/mail-list.sqlite` contains staged contacts.
- DNS lookups are **opt-in (`--dns`)** because querying domains reveals the list's domains to the host's DNS resolver. Only bare domains are ever queried (never local parts, never SMTP, never a hardcoded public resolver).
- Follow all data rules in [AGENTS.md](../../AGENTS.md) and [docs/cleaning-rules.md](../../docs/cleaning-rules.md).

## Commands

```sh
# Offline mode (no network; every undecided suspect is listed as ambiguous)
node scripts/check-domains.ts [--workspace <path>]

# Opt-in DNS check via the host resolver (sorts suspects into obvious and ambiguous)
node scripts/check-domains.ts [--workspace <path>] --dns

# Standing rule approved by the human (D35): write accept decisions for every suggestion to a curated
# popular provider (scripts/lib/rules/providers.json) into overrides/typo-decisions.yaml, then re-merge
node scripts/check-domains.ts [--workspace <path>] --dns --auto-accept
node scripts/clean-and-merge.ts [--workspace <path>]

# Masked JSON output (counts + masked entries)
node scripts/check-domains.ts [--workspace <path>] [--dns] --json
```

Exit codes: `0` ok (including when there are no undecided typo suspects); `1` unexpected runtime error; `2` missing or unsafe workspace, or `.lock` held.

`--auto-accept` is the only path that writes to `overrides/`: it appends entries (with a `note` naming D35) and never edits existing lines; a human can still change any entry to `reject`. Suggestions to domains that are not on the provider list stay in the obvious / ambiguous lists for the human.

## Reading the output

- If nothing needs checking, `stdout` prints `no undecided typo suspects` and exits `0`.
- Otherwise `stdout` shows counts and up to 20 masked entries per bucket, **Obvious** first and **Ambiguous** second:
  - Typed addresses are always masked (`t***@e***e.con`).
  - Suggestions pointing to curated public providers may display the provider domain (`gmail.com`, `outlook.com`, `yahoo.co.jp`, etc.); non-provider suggestions stay masked (`t***@e***e.com`).
  - Each line includes the source name(s) and either the DNS evidence (`Obvious`) or the reason it needs manual review (`Ambiguous`).
- The final line prints the path to `output/reports/domain-check.yaml` for local human inspection.

## Human decisions and where they live

- The human opens `output/reports/domain-check.yaml` locally, reviews `obvious:` (pre-filled `action: accept`) and `ambiguous:` (`action:` blank, with `reason:`), and copies agreed entries into `workspace/overrides/typo-decisions.yaml` (filling `action: accept` or `action: reject` for ambiguous ones).
- Re-run `clean-and-merge` after updating `workspace/overrides/typo-decisions.yaml` so accepted corrections take effect in SQLite (original `raw_email` is always preserved; `typo_accepted` flag is added).

## Never do

- **Never read `output/reports/domain-check.yaml` into agent context** — it contains full, unmasked customer email addresses for local human editing only. Read only the masked `stdout` / `--json` output.
- Never write to `workspace/overrides/typo-decisions.yaml` by hand on behalf of the human, and never auto-apply suggestions to domains outside the curated provider list; `--auto-accept` (D35) is the only automatic path.
- Never run `--dns` against a real workspace without confirming the human wants host DNS lookups for the undecided domains.
- Never read raw `workspace/resources/` files, print full addresses, edit `resources/`, write to external providers without confirmation, or delete database content.
