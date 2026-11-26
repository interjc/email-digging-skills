# Listmonk

Phase 1 writes a local subscriber import CSV with `email,name,attributes` under
`output/exports/`. Attributes hold the source labels, flags, locale and email status.
The CSV contains full addresses. Keep it on this machine; a dry run is not permission
to send or transfer the list.

```sh
node scripts/export.ts --provider listmonk
```

The default is `strict`, which requires positive consent. Explicit `--list not_blocked`
can include contacts without positive consent and prints a warning. No credentials or
network requests are needed to generate the CSV.

`--apply` and pulling suppressions are unavailable in Phase 1. A future confirmed
apply will use the Listmonk API to match by normalized email and calculate updates
and removals; the preview can only count export rows. The adapter reserves these
environment keys for API access: `LISTMONK_URL`, `LISTMONK_USERNAME`,
`LISTMONK_API_TOKEN`, and `LISTMONK_LIST_ID`. Set them only in the git-ignored `.env`.
