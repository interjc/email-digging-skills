# Common rules for every brief (read first)

Repository: /Users/mo/dev/email-digging-skills, branch main @ c444d93. Several agents work in this
checkout at the same time, each on its own file lease. Other files changing under you is expected.

Read before coding: `AGENTS.md`, `docs/design/phase-1.md` (decisions D1–D20, module map, interfaces,
rule details R1–R8), `scripts/lib/types.ts` (contracts, read-only), `docs/init/REQUIREMENTS.md`
(Chinese requirements, intent).

Constraints (with reasons):
- Edit only files in your lease. Shared files (`scripts/lib/types.ts`, `schema/migrations/*`,
  `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `AGENTS.md`, `.gitignore`, templates) belong to
  the director: if you need a change there (a type, a dependency), stop and list it in your report.
- No state-changing git (add, commit, stash, checkout, reset, push): the director reviews and commits.
  Read-only `git status` / `git diff` is fine.
- Do not install packages (dependencies are fixed: `@duckdb/node-api`, `yaml`, `typescript`,
  `@types/node`; Node built-ins are fine).
- Never read `workspace/` (real personal data may be there) or `.env*`. Use `fixtures/` or temp dirs
  under `os.tmpdir()` for tests.
- No real email addresses anywhere: tests and docs use `example.com`, `example.jp`, `example.net`,
  `example.org` (and `example.con`, `example.co.jo` for typo cases). A literal real-provider address
  in a unit test (e.g. `a@gmial.com`) needs a trailing comment `// email-scan:allow`.
- TypeScript runs through Node's type stripping: erasable syntax only (no enum/namespace/parameter
  properties), import local files with `.ts` extensions, `import type` for types.
- No repo-wide formatters or rewrites.
- If anything falls outside your brief or contradicts it, stop and explain it in your final reply;
  do not decide product or design questions yourself.

Acceptance commands (run them, paste real output in your report):
- `./node_modules/.bin/tsc --noEmit -p .` (errors in files outside your lease that others are still
  writing: list them as "not mine", do not fix)
- `node --test <your test files>`

Report format: files changed (one line each) with `wc -l`; real output of every acceptance command;
why you wrote these tests; deviations from the brief and why; open risks; shared-file changes needed.
