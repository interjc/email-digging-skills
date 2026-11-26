# AGENTS.md

Rules for every agent (and person) working in this repository. `CLAUDE.md` only points here.

This repository is a public, generic toolkit: a self-hosted pipeline that collects customer email
exports (CSV, XLSX, JSON, SQLite), tags them by source, cleans, dedupes and merges them into one
SQLite database, and later pushes sendable lists to a sending platform. The pipeline steps are
agent skills in [`skills/`](skills/); each skill calls CLI scripts in [`scripts/`](scripts/).

## Data rules (non-negotiable)

1. **Real data lives only in the workspace** (`workspace/` by default, or `$MAIL_PIPELINE_WORKSPACE`).
   Never read a whole list into your context. Look only at the masked summaries and the few masked
   samples the scripts print.
2. **Run `init-workspace` first** after cloning. If the workspace does not exist, or sits inside
   the repository without being git-ignored, do not run any other skill.
3. `workspace/resources/` is **read-only**. `workspace/output/` is written **only by scripts**.
   Human decisions go to `workspace/overrides/`.
4. **Ask a human first** before anything that writes to an external system (provider push), sends
   email, or deletes database content.
5. **Never rewrite an original email value.** Typo suggestions are flags until a human accepts
   them in `workspace/overrides/typo-decisions.yaml`. Standing exception approved by the human (D35):
   `check-domains --auto-accept` may append `accept` entries there for suggestions to a curated
   popular provider (`scripts/lib/rules/providers.json`), each with a note; the original stays in
   `raw_email`, and a human can override any entry with `reject`.
6. **Schema changes only through a new migration** in `schema/migrations/` (next number). Never
   edit an applied migration.
7. **Tests use only `fixtures/`** (synthetic data, `example.com` / `example.jp` / `example.net` /
   `example.org` addresses only).
8. **Nothing user-specific in the repository**: no real source names, product names, column
   mappings, email addresses, provider URLs or config. New data files go to the workspace only.
9. Secrets live only in `.env` (git-ignored). Never print a secret; refer to it by name.

## Commands

| Purpose | Command |
|---|---|
| Install | `pnpm install` |
| Type check | `pnpm typecheck` |
| Tests | `pnpm test` |
| Staged-email scan (pre-commit) | `pnpm check:emails` |
| Initialize the workspace | `pnpm init-workspace` (add `--demo` for a fixture run) |

Runtime: Node.js >= 22.18 (TypeScript runs through Node's type stripping, no build step), pnpm.
DuckDB comes bundled with `@duckdb/node-api`.

TypeScript rules: erasable syntax only (no `enum`, `namespace`, parameter properties), import local
files with the `.ts` extension, shared types come from `scripts/lib/types.ts`.

## Where things are

- Requirements (Chinese): [docs/init/REQUIREMENTS.md](docs/init/REQUIREMENTS.md)
- Phase 1 design, decisions and module map: [docs/design/phase-1.md](docs/design/phase-1.md)
- Specs: [docs/schema.md](docs/schema.md), [docs/cleaning-rules.md](docs/cleaning-rules.md),
  [docs/consent-policy.md](docs/consent-policy.md), [docs/masking.md](docs/masking.md),
  [docs/meta-template.md](docs/meta-template.md)

## Subagent team
<!-- Policy for the subagent-team skill. Edit freely; the skill reads it at the start of each task. -->
- Host harness: T3 Code, multi-vendor (confirmed 2026-11-26); Claude Code CLI and Codex CLI also supported, vendor-native
- External route: auto (T3 → host switch per `~/.subagent-team/harness-t3-code.md`; vendor-native hosts → ACP + liaison)
- Model policy: auto; compute, roles and fallbacks follow the user's global plan (user, 2026-11-26: "我想用全局的委派规则")
- Cost preference: see compute plan profile (`compute-config.mjs start`)
- Decided: 2026-11-26, confirmed by the user
- Environment (checked 2026-11-26): Node.js 26.7.0, git 2.55.0, pnpm 12.23.0, Codex CLI 0.172.0, agy 1.5.17, OpenCode 2.4.1; gitleaks not installed locally (CI runs it)
- Team board: [docs/agent-team/README.md](docs/agent-team/README.md) + native task list
- External delegation: roster (global compute plan; no per-session question)
- External confidentiality: global `~/.subagent-team/confidentiality.md` (full for the rostered teams); real workspace data is off-limits to every agent beyond masked script output
- External compute: local compute files (`compute-config.mjs start`; global plus `.agent-team/`, git-ignored)
- Never outsourced: merge logic and consent decisions (`scripts/lib/merge.ts`, `schema/migrations/`, `docs/consent-policy.md` final wording); anything that runs against the real workspace
- Shared files (director only): `scripts/lib/types.ts`, `schema/migrations/*`, `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `AGENTS.md`, `.gitignore`, `config.example.yaml`, `.env.example`
- Acceptance commands: `pnpm typecheck`, `pnpm test`, `pnpm check:emails`
- Commit / push / deploy: commit locally on main after checks pass, one commit per verified unit; never push or add a remote unless asked (user, 2026-11-26)
- Real-data runs: ask the user to confirm their files are in place before the first run against `workspace/resources/` (user, 2026-11-26)
- Lessons and user adjustments: [docs/agent-team/lessons.md](docs/agent-team/lessons.md)
