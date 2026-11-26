# Security Policy

## Supported versions

`email-digging-skills` is pre-1.0 software (Phase 1). Security and privacy fixes are applied to the `main` branch only.

## Reporting a vulnerability privately

Do **not** open a public GitHub issue or pull request for a security or privacy vulnerability.

Instead, open a private report via GitHub: go to the repository's **Security** tab and choose **Report a vulnerability** (GitHub Private Vulnerability Reporting).

## What counts as a security or privacy issue

This toolkit handles customer email lists locally alongside AI agents. Treat any of the following as a security or privacy vulnerability:

- **Unmasked personal data output**: a full email address, personal name, or phone number printed to `stdout` / `stderr` or written into a run report (`output/reports/*.md` or `*.json`).
- **Query masking bypass**: `scripts/query.ts` returning unmasked personal data through SQL expressions, aliases, or JSON columns in default (masked) mode.
- **Workspace safety guard bypass**: `checkWorkspaceSafety` or `assertPathSafe` failing to block an in-repo or symlinked workspace that Git could track or commit.
- **Reversible or leaky masked exports**: `output/masked/mail-list-masked.sqlite` or `shape.json` leaking unredacted personal fields or allowing pseudonyms to be reversed without `MASK_HMAC_KEY`.
- **Secret exposure**: `MASK_HMAC_KEY`, provider tokens, or other `.env` values printed to logs, reports, or JSON output.
- **Pre-commit scan bypass**: `scripts/check-staged-emails.ts` or `.githooks/pre-commit` failing to catch staged non-`example.*` email addresses across supported file formats and encodings.

## Reporter responsibilities (no real customer data)

- **Never attach real customer data** to a vulnerability report, issue, or reproduction script. Do not include real exports, `.env`, `config.yaml`, `pending-decisions.yaml`, `output/exports/`, or real `output/masked/` files.
- Reproduce issues using the synthetic datasets in [`fixtures/`](fixtures/) or newly invented addresses under `example.com`, `example.jp`, `example.net`, or `example.org` only.
