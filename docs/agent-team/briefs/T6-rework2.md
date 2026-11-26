# T6 rework round 2 (from re-review R2, 2026-11-26) — last round

Same lease as before. No signature changes for existing exports. D29 lists what is NOT to be fixed.
For every item, add the reviewer's trigger as a test.

1. Privacy (P1):
   a. YAML errors and warnings in meta.md (incl. `TAG_RESOLVE_FAILED`): code + file + line/column only.
   b. A header row that contains an address is almost certainly a data row: print every header of that
      file as `<col N>` (no text), and add the confirm line about `header_row`.
   c. Errors that name an input file (missing file, read failures in staging) pass file names through
      `sanitizeText`.
2. Path safety (P1): before writing meta.md / meta.draft.md, call `assertPathSafe` from
   `scripts/lib/paths.ts` (T5 is adding it now) on the realpath of the source directory, so a source
   directory symlinked into the checkout is refused.
3. XLSX (P1):
   a. Header naming: literal header names are reserved first; generated suffixes (`_1`, `_2`, …) skip names
      that exist literally. So `z, z, z_1` → `z, z_2, z_1`, and an explicit mapping `z_1` keeps selecting the
      third column. Same rule for csv/json/sqlite (shared `uniqueHeaders`).
   b. When column ZZ has data, warn "columns beyond ZZ are not read" (D29).
4. Staging publication (P1): never delete the live directory before the new one is in place: rename live →
   `_old-<rand>`, rename new → live, then remove old; on failure of the second rename, rename old back and
   remove the new temp dir. Construct writers inside the try so a failure opening the second temp file
   leaves no temp directory.
5. Draft round-trip (P2): keep accepted in-directory symlinks; keep the file order of an existing meta.md
   (append new files after); always quote string scalars that YAML would retype (sheet `"1e2"` stays a
   string; use the yaml library's string type, not hand quoting).
6. (P3) Plain UTF-8 detection: the draft comment must not ask for confirmation (D25); write `encoding:
   utf-8` directly with a `# detected` comment.

Acceptance: tsc; your test files; `pnpm test`. Report each item → fix → test name.
