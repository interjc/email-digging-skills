# T5 rework (from review R1, 2026-11-26)

Same lease as T5, plus `scripts/lib/lock.ts` (+ test). Do not change exported signatures that other
modules already use (T6, T7, T8 import paths/config/env/overrides/db/cli). Decisions D26–D28 in
`docs/design/phase-1.md` are the spec. Findings are quoted from the reviewer (file:line at commit 2c1335b).

1. (P1) Guard approves committable workspaces: narrow ignore rules matching only the probe paths pass
   with an unignored JSON input; a tracked file under the workspace passes; an in-repo dir named
   `..private` is classified as external; an external workspace whose `resources` is a symlink into the
   checkout bypasses the guard (paths.ts:147, :183). Implement D27 and test each of these four cases.
2. (P1, part) A malformed override YAML line containing an address appears in the thrown message
   (overrides.ts:24). Never echo file content in errors: name the file and entry number, and pass any
   remaining text through `sanitizeText`. Add `sanitizeText(s)` to `scripts/lib/mask.ts`? No: mask.ts is T3's,
   already committed — put `sanitizeText` in `scripts/lib/sanitize.ts` (new, in your lease) using `maskEmail`.
3. (P2) Backup pruning deletes the backup it just created after 12 same-second backups (db.ts:81): sort by
   timestamp then numeric suffix; test with 12.
4. (P2) `.env` with a non-empty MASK_HMAC_KEY followed by an empty one: init rewrote the first and left the
   effective (last) one empty (env.ts:7, init-workspace.ts:160). Write the same assignment the parser reads
   (the last one); test it.
5. (P2, part) `requireWorkspace` accepted `database/mail-list.sqlite` being a directory (paths.ts:238): it
   must be a regular file.
6. D26 lock: `scripts/lib/lock.ts` exporting `withWorkspaceLock(ws, command, fn)`; use it in init-workspace.
   Other commands adopt it in their own tasks.

Acceptance: tsc; your T5 tests + new ones; `pnpm test` (whole suite). Report like before, with each finding
→ fix → test name.
