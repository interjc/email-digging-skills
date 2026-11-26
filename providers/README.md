# Providers

Add `providers/<name>/index.ts` with a default export implementing `Provider` from
[`scripts/lib/types.ts`](../scripts/lib/types.ts). Its `name` must match the directory.
`export --provider <name>` discovers it without a change to core code.

- Declare only the adapter's environment key names in `envKeys`. Document them in the
  adapter README and ask the maintainer to add them to `.env.example`; real values
  belong only in the git-ignored `.env`.
- Implement the dry run first. `pushContacts` gets the selected list and returns a
  `PushPlan`; `pullSuppressions` returns a `PullResult` once implemented. Use the
  database's consent views and key operations by normalized email, not by name.
- Keep provider logs and plan notes masked. Only a local export under `output/exports/`
  may contain full values. Do not make provider writes or send mail in a dry run.
- The Phase 1 export command records each attempted push in `sync_log`; do not write
  duplicate audit entries in the adapter. `--apply` is intentionally unavailable.
