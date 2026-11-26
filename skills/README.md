# Pipeline Skills

Each pipeline step is packaged as a vendor-neutral agent skill backed by a CLI script in [`scripts/`](../scripts/).

## Pipeline order

1. [`init-workspace`](init-workspace/SKILL.md) — Initializes and verifies the local workspace, configuration files, `MASK_HMAC_KEY`, SQLite migrations, Git hooks, and optional `--demo` fixture run.
2. [`add-source`](add-source/SKILL.md) — Creates or probes `workspace/resources/<name>/`, detects file encodings, column mappings, and duplicate exports, and writes `meta.md` or `meta.draft.md`.
3. [`clean-and-merge`](clean-and-merge/SKILL.md) — Validates `meta.md`, decodes and normalizes exports, stages Parquet via DuckDB, applies YAML overrides, backs up SQLite, and merges contacts and consents.
4. [`review-report`](review-report/SKILL.md) — Prints a masked summary of pending human decisions from the latest run and writes full entries locally to `output/reports/pending-decisions.yaml`.
5. [`check-domains`](check-domains/SKILL.md) — Sorts undecided typo suspects into `obvious` and `ambiguous` (with opt-in `--dns` host-resolver checks) and writes copy-ready entries locally to `output/reports/domain-check.yaml`.
6. [`query-list`](query-list/SKILL.md) — Runs read-only preset or custom `SELECT` queries against `mail-list.sqlite` with fail-closed output masking, or exports full rows locally with `--out`.
7. [`mask-data`](mask-data/SKILL.md) — Generates an HMAC-SHA256 pseudonymized SQLite copy (`mail-list-masked.sqlite`) and optional `shape.json` under `workspace/output/masked/`.
8. [`export-to-provider`](export-to-provider/SKILL.md) — Writes a local dry-run subscriber CSV under `workspace/output/exports/` for a configured provider (Listmonk in Phase 1) and logs `sync_log`.

## Agent discovery

- **Claude Code & Codex**: `.claude/skills` and `.agents/skills` in the repository root are symlinks to `../skills`, so both tools discover all eight skills automatically.
- **Other agents**: point the agent at [`AGENTS.md`](../AGENTS.md) (`CLAUDE.md` also points there) and the `SKILL.md` files in this directory. Every skill uses plain `node` / `pnpm` commands with no vendor-specific tool dependencies.

## Adding a new skill

1. Create `skills/<skill-name>/SKILL.md` where the directory name `<skill-name>` exactly matches the `name:` field in the YAML frontmatter.
2. Write the frontmatter `description:` in the third person, stating both what the skill does and when to use it.
3. Follow the same section structure as existing skills: `Purpose`, `Preconditions`, `Commands`, `Reading the output`, `Human decisions and where they live`, and `Never do`.
4. Document only CLI flags, outputs, and exit codes verified against the script in `scripts/`.
5. Keep all instructions vendor-neutral, use only `example.com` / `example.jp` / `example.net` / `example.org` in examples, and enforce the data safety rules in [`AGENTS.md`](../AGENTS.md).
