# Local Admin Apps (Planned)

This directory is reserved for local browser-based management interfaces (such as a future `apps/admin-web/`) to be added once the CLI pipeline has stabilized in production use.

## Planned scope

- Browse, filter, and search merged contacts and per-source overlap matrices.
- Inspect run reports from `workspace/output/reports/`.
- Step through suspected domain typos, auto-detected encodings, and low-confidence column mappings one item at a time.
- Manage manual suppressions, per-source consent overrides, and test-account exclusions.

## Architecture and privacy constraints

Every app added under `apps/<name>/` must follow the repository's data rules ([`AGENTS.md`](../AGENTS.md)):

1. **Localhost only (`127.0.0.1`)**: bind strictly to `127.0.0.1` for local operation; never bind to `0.0.0.0` or deploy an app holding real workspace data to an external server without authentication and explicit security review.
2. **Reuse `scripts/lib/`**: import database helpers, normalization, consent views, overrides, and masking functions directly from [`scripts/lib/`](../scripts/lib/) instead of duplicating pipeline logic.
3. **Write human decisions to `workspace/overrides/`**: record typo decisions, suppressions, consent overrides, and exclusions in `workspace/overrides/*.yaml` (or `meta.md`) rather than mutating `mail-list.sqlite` directly, so re-running `clean-and-merge` always reproduces the exact same state.
4. **Masked by default, zero extra copies**: render lists and tables masked (`t***@e***e.jp`, `山***`), reveal a single record's full value only on explicit local interaction, and never store a separate copy of personal data outside `workspace/`.
