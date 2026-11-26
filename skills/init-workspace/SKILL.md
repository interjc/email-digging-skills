---
name: init-workspace
description: Initializes and verifies the local pipeline workspace, configuration files, SQLite database, and Git hooks. Use this first after cloning the repository, when setting up a custom workspace path, or when running the synthetic fixture demo.
---

# init-workspace

## Purpose

Sets up and validates the local environment before any customer data enters the pipeline. It checks Node.js (`>= 22.18`), `pnpm` dependencies, and DuckDB (`excel` and `sqlite` required, `encodings` optional), verifies that the workspace cannot be committed to Git, creates the workspace directories, copies `config.example.yaml` to `config.yaml` and `.env.example` to `.env` if missing, generates a 32-byte hex `MASK_HMAC_KEY` in `.env` when empty, runs `schema/migrations/` on `database/mail-list.sqlite`, configures `.githooks` (`core.hooksPath`), and optionally runs the full pipeline on synthetic fixtures in `<workspace>/.demo/`. The command is idempotent and never overwrites existing files or keys.

## Preconditions

- `pnpm install` has been run.
- Network access is available once if DuckDB has not cached the `excel` and `sqlite` extensions yet.
- Workspace path resolution order: `--workspace <path>` > `MAIL_PIPELINE_WORKSPACE` (process environment, then `.env`) > `workspace` in `config.yaml` > `./workspace`.
- If the workspace (or any symlinked layout directory or database file) sits inside a Git worktree without being git-ignored, or contains tracked files other than an empty `.gitkeep`, initialization stops with exit code `2` before creating anything.
- Follow all data rules in [AGENTS.md](../../AGENTS.md).

## Commands

```sh
# Initialize the default workspace (or MAIL_PIPELINE_WORKSPACE / config.yaml workspace)
pnpm init-workspace

# Initialize and verify the full pipeline on synthetic fixtures in <workspace>/.demo/
pnpm init-workspace --demo

# Initialize a workspace outside the repository
node scripts/init-workspace.ts --workspace /path/to/mail-workspace

# Machine-readable sanitized JSON output
node scripts/init-workspace.ts --workspace /path/to/mail-workspace --json
```

Exit codes: `0` all required checks passed; `1` one or more required checks failed; `2` precondition failed (unsafe workspace location or an active/stale `<workspace>/.lock`).

## Reading the output

- Prints `Workspace: <path>`, a `Check / Result / Fix` table (`ok`, `warn`, `fail`, `skipped`), warnings on `stderr` (for example if the workspace is inside a cloud-synced folder such as iCloud, Dropbox, OneDrive, or Google Drive), and `Next: add-source <name>`.
- With `--demo`, `Demo pipeline run` reports `ok (36 contacts, 6 in 2+ sources, strict list 17, not blocked 29; report output/reports/<run_id>.md)` while leaving the main `database/mail-list.sqlite` empty.
- All printed paths and JSON fields pass through address sanitization; `MASK_HMAC_KEY` is never printed.

## Human decisions and where they live

- **Workspace location**: store real customer exports outside cloud-synced folders. Record a custom path in `.env` (`MAIL_PIPELINE_WORKSPACE=/path/to/workspace`) or `config.yaml` (`workspace: /path/to/workspace`), both git-ignored.
- **Merge priority and opt-in policy**: configure `sources.priority`, `consent.opt_in_bases`, `consent.opt_in_sources`, `masking.keep_domain`, and `backups.keep` in `config.yaml`.
- **Stale workspace lock**: if `<workspace>/.lock` remains after a crash and its PID is no longer running, ask the human to verify and remove `.lock`.

## Never do

- Never read raw files under `workspace/resources/`, the unmasked database, or `.env` into context.
- Never print secrets (`MASK_HMAC_KEY`, provider credentials) or full email addresses.
- Never weaken `.gitignore` or run any other pipeline skill when `init-workspace` fails or reports an unignored workspace.
- Never edit `workspace/resources/`, write to external systems without human confirmation, or delete database content.
