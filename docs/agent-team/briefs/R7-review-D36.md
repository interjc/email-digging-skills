# R7 brief: design review of D36 (same address, several user ids inside one source)

You are a reviewer. Give a recommendation; do not edit any file and do not run state-changing git.
Never read `workspace/`, `.env`, `.env.*` or `config.yaml`.

## Context

Read `AGENTS.md`, `docs/design/phase-1.md` (D10–D20, D23, D30), `docs/cleaning-rules.md`,
`scripts/lib/merge.ts` and `git diff scripts/lib/merge.ts` (the uncommitted D36 change).

Contacts are already unique by normalized address across all sources. Inside one source, one address can
appear on several rows: a person registered twice and got two different user ids (same export file or
different dated exports). The maintainer's rule: "these users can be merged; where the data disagrees, the
latest user wins, or the values are stacked".

The uncommitted change does this:
- Rows of one source for one address are ordered most recent first: newest file (meta.md order /
  file date), then latest activity (`last_seen_at`, else `created_at`), then the later row_number, then
  split_index. The first one is the representative (`raw_email`, `raw_fields`).
- `name` and `locale` candidates take the first non-empty value in that order.
- `raw_fields` = representative's fields plus `_merged_rows: [{file, row_number, <fields that differ>}]`
  for the other rows (omitted when nothing differs).
- `contact_sources.first_seen_at` = min `created_at`, `last_seen_at` = max activity (unchanged).

## Questions (answer each with a recommendation and one or two sentences why)

1. Ordering: is "newest file first, then activity, then later row" right, or should activity come before
   the file rank (an older file can hold a row with a later activity than a newer file)? Rows with no dates
   at all: is "later row_number = newer" a safe assumption for typical admin exports?
2. Consent inside one file (D15 today: the newest file decides; inside it `denied` wins; then the first
   row). With "latest user wins", should a later re-registration's `granted` beat an older row's `denied`
   in the same file? Consider that the output feeds marketing email and the strict list.
3. Suppression-like flags that live only in `raw_fields` (for example a blocked or suspended marker on one
   of the user rows): should D36 stacking change anything, or is it enough that the maintainer maps them
   into `overrides/suppressions.yaml`?
4. Is `_merged_rows` inside `raw_fields` a reasonable place for the stacked values (query masking treats
   `raw_fields` as redacted JSON), or would you store them elsewhere? Any size concern with many duplicates?
5. Anything in the diff that is wrong or missing (determinism across re-runs, `representative()` also
   being used for typo suggestions, idempotence of the merge).

## Report

A short list: question number, recommendation, reason. Then any defects in the diff with file:line.
