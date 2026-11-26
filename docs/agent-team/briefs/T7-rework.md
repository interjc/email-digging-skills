# T7 rework (from review R3, 2026-11-26)

Same lease as T7. No signature changes other modules rely on (T8 may read your report types). Decision
D30 in `docs/design/phase-1.md` is new. `sanitizeText` is being extended by T5 in parallel to catch
compatibility forms of @ such as U+FE6B (R3 finding 3): nothing to do on your side except a test once it lands.
For every item, add the reviewer's trigger as a test.

1. (P1, findings 1 + 5) D30: `--source` only with `--dry-run` (otherwise exit 1 with a clear message);
   merges recompute every source. Remove the partial-run code paths and their "approximate" caveats;
   keep a test that removing a consent override (grant over a source denial) restores the denial and
   removes the contact from `v_sendable_strict` on the next run; and that removing a contact from its
   higher-priority source makes name/locale come from the surviving source.
2. (P1, finding 2) `pending-decisions.yaml` must stay inside the workspace: resolve the realpath of
   `output/reports/` and check it is inside the workspace realpath; write to a new temp file in that
   directory with `{flag: 'wx', mode: 0o600}` and `rename` over the target (rename replaces a symlink
   rather than following it). Same treatment for report files.
3. (P2, finding 4) Report publication after commit: order = commit → mark run `ok` → write reports →
   set report_path. If writing reports fails, exit 1 with "merge committed (run <id>); report could not be
   written: <sanitized reason>; run review-report after fixing". A failure while writing the rollback
   report must not prevent marking the run failed.
4. (P2, finding 6) review-report: build the encodings-to-confirm list from all file stats, not from the
   capped samples; in the local pending YAML write the exact (unsanitized) header names, since that file is
   the place for full values; take `withWorkspaceLock(ws, 'review-report', …)` so it cannot interleave with
   a merge; attribute orphans to a run by the run's own timestamp with millisecond precision (or another
   exact link), so two runs in the same second are not mixed.
5. (P2, finding 7) Replace `Math.max(...array)` and similar spreads over row arrays with loops; test with a
   150 000-row group.
6. (P3, finding 8) `overrides_applied.typo` = number of original addresses actually rewritten or kept;
   `overrides_applied.suppressions` = rows newly inserted. (Consent raw whitespace is T6's; ignore.)

Acceptance: tsc; your test files; `pnpm test`. Report each finding → fix → test name.
