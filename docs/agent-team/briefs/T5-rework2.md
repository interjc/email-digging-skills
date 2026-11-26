# T5 rework round 2 (from re-review R2, 2026-11-26) — last round

Same lease as before (`scripts/lib/{paths,config,env,overrides,db,cli,errors,lock,sanitize}.ts`,
`scripts/init-workspace.ts`, their tests). No signature changes for existing exports. D29 lists what is NOT
to be fixed. Note: the director already made `runCli` sanitize every message (commit c779bf8). For every
item, add the reviewer's trigger as a test.

1. Guard (P1):
   a. `git rev-parse` failing abnormally (git missing, exit 128 while a `.git` exists in an ancestor of the
      repo root) must refuse, not be treated as "not a git repo". Only "no .git anywhere up the tree" is a
      genuine non-git checkout (warning).
   b. The `.gitkeep` exception must check the index too: allowed only when the staged blob is empty
      (`git ls-files -s` mode/hash = the empty blob e69de29…) and the working file is empty.
   c. Export a helper `assertPathSafe(path, opts)` (realpath; if inside the repo, it must be ignored and not
      tracked) and use it in `requireWorkspace` for the database file's realpath (an external workspace
      whose `database/` is a symlink into the checkout must be refused). T6 will call it for source
      directories before writing meta.md.
2. Privacy (P1):
   a. YAML errors and warnings (incl. `TAG_RESOLVE_FAILED` and other `doc.warnings`) in config.yaml and
      override files: report only code, file name and line/column (`describeYamlError`), never the
      message text or source line.
   b. `sanitizeText`: apply NFKC to a copy for matching so small-form `﹫` (U+FE6B), full-width `＠` and
      other compatibility forms of @ are found; mask the original span.
   c. Lock metadata printed in busy/stale errors and unknown-option errors go through `sanitizeText`.
3. Lock (P2): write the lock body in the same exclusive create (`writeFileSync(path, body, {flag: 'wx'})`);
   if the write fails after creation, unlink before rethrowing. (Crash leftovers: D29.)

Acceptance: tsc; your test files; `pnpm test`. Report each item → fix → test name.
