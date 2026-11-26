# Rework round 3 (from targeted re-check R4, 2026-11-26) — final round

Decision D32 in `docs/design/phase-1.md` is the spec. Add each reviewer trigger as a test. No new
features, no signature changes beyond what is listed. After this round the director verifies the triggers
directly; there is no further review round, so make each test reproduce the original trigger exactly.

## T5 (paths, init-workspace, sanitize)
1. (P1) Git discovery: a dangling `.git` symlink (rev-parse exit 128) must refuse, not count as "no git".
   Determine the git worktree that contains the workspace from the workspace path itself (nearest existing
   ancestor), so a workspace that is a sibling of this package inside an ancestor git checkout is checked
   (must be ignored there, nothing tracked). Same for `assertPathSafe`. Tests: both triggers.
2. (P1) init-workspace output (text and JSON): every path printed goes through `sanitizeText`.
3. Export `writeFileInWorkspace(dir, name, content, {workspace, mode})` (move/generalize T7's
   `writeFileAtomic` semantics: realpath of dir inside workspace realpath, temp `wx` in the same dir,
   rename over target) from `scripts/lib/paths.ts` or a new `scripts/lib/fsafe.ts` — T6 and T7 will use it.
   Also export `containsAddress(text)` from `sanitize.ts` (NFKC-aware, the same detection sanitizeText uses).

## T6 (add-source, read)
4. (P1) meta.md / meta.draft.md writes: `meta.md` keeps exclusive create; `meta.draft.md` (may exist) is
   written with `writeFileInWorkspace`, so a symlink at the draft path is replaced, never followed. Test:
   draft symlinked to a tracked file in a temp checkout → the tracked file is unchanged.
5. (P1) `files[].probe.file` in JSON output is sanitized; the mistaken-header check uses `containsAddress`
   (U+FE6B etc.) so the `<col N>` rule and the confirm line trigger. Tests: both triggers.
6. (P1→limitation, D32) SQLite `query` with duplicate column names: catch the binder error and refuse with
   "the query returns duplicate column names; give every column a unique alias". Test.

## T7 (clean-and-merge, review-report, merge)
7. (P1) Pass an `onWarning` to `stageSource` in clean-and-merge so reader warnings (e.g. columns beyond ZZ)
   appear in the run warnings, the report and `--json`. Test with the AAA-column xlsx trigger.
8. (P2) Recovery message after a report publication failure: "merge committed (run <id>); the report could
   not be written: <reason>. Fix the cause and run clean-and-merge again (merges are full and idempotent)".
   review-report, when the newest `ok` run in `runs` has no report_path, says so and exits 2 with the same
   advice instead of showing an older report. Test.
9. (P2) `--json` of review-report and clean-and-merge: sanitize values recursively before
   `JSON.stringify`; never sanitize the serialized string. Test with a source dir named `@pending`
   (output must `JSON.parse`).
10. (P3) Typo counter: a reject counts only if its address occurs among the original (pre-override)
    staged addresses. Test.
11. Replace your `writeFileAtomic` with T5's `writeFileInWorkspace` once it exists (keep behavior).

Acceptance (each): tsc; own test files; `pnpm test`.
