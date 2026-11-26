# T6 rework (from review R1, 2026-11-26)

Same lease as T6. Do not change the exported signatures of `loadMeta`, `probeFile`, `readRows`,
`stageSource` (T7 and T8 build on them). Decisions D25, D26, D28 in `docs/design/phase-1.md` are the spec.
T5 is adding `scripts/lib/sanitize.ts` (`sanitizeText`) and `scripts/lib/lock.ts` (`withWorkspaceLock`) in
parallel; use them once they exist (if not there yet, finish the rest first).
Findings are quoted from the reviewer (file:line at commit 26cdad2).

1. (P1) Raw personal data in output: an address in a Newsletter, date or locale cell was printed verbatim in
   text and JSON; an address and full name in a mistaken header row were exposed (add-source.ts:49, :107,
   :193; mask.ts:142 passes non-PII fields through). Apply D28: headers, every sample, warnings and error
   messages through `sanitizeText`; tests with addresses planted in each place.
2. (P1) XLSX: with a blank first worksheet row, `header_row: 3` and two data rows, only the first record was
   read (row count used as physical end row); a populated column under a trailing blank header was dropped;
   a text cell `0002.0` became `0002`; headers `z`, `z`, `z_1` produced duplicate keys (table.ts:54, :72, :114;
   index.ts:109). Fix all four with tests (build the xlsx with DuckDB or a tiny hand-made zip).
3. (P1) Concurrent staging of the same source left rejected.parquet + stats.json without rows.parquet
   (stage.ts:149, :238): build into a unique temp dir under `output/staging/` and rename into place (D26).
4. (P2) add-source overwrote a meta.md created while probing (add-source.ts:87, :145): create with
   exclusive create (`wx`), fall back to meta.draft.md.
5. (P2) Draft discards settings of an existing meta.md: header_row 3 reset to 1, sheet dropped, sqlite query
   and delimiter dropped (add-source.ts:101, :138; meta.ts:267). When meta.md exists, the draft keeps every
   per-file setting from it.
6. (P2) loadMeta accepts a listed symlink to an external file, a directory named `folder.csv`, and a `.md`
   file (meta.ts:152): only regular files directly in the source dir (realpath inside it), never .md.
7. (P2) add-source decodes into the OS temp dir (add-source.ts:53, :104; index.ts:45): decode into the
   workspace (`output/staging/_probe-<pid>/`), removed afterwards.
8. (P3) `export-2025-13-01.csv` aborts with `Invalid time value` (add-source.ts:41): invalid dates in names
   are ignored. R4 confirmation per D25 (already your behavior; keep a test).
9. Wrap add-source in `withWorkspaceLock` (D26).

Acceptance: tsc; your T6 tests + new ones; `pnpm test`. Report each finding → fix → test name.
