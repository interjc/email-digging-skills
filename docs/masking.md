# Masking and data handling

Display masking hides values in reports and logs. A masked export creates a separate
copy for sharing or debugging. Neither process changes the original files.

## Personal data

| Field or location | Treat as personal data |
|---|---|
| Email fields | Normalized and raw email addresses, rejected email input and typo suggestions. |
| Profile and contact fields | Names, phone numbers and postal addresses. |
| Raw and evidence fields | Original columns, consent evidence, and free-text notes may contain identifying values even when the field name does not show it. |

Do not read whole lists into an agent's context. Use only the masked summaries and the
few masked examples that scripts print. Inspect any necessary full value locally, not in
an agent conversation.

## Display masking

Apply these rules to script output, samples, and logs. `maskValue` dispatches by substrings
in the field name:

| Field-name match | Rule | Fictional example |
|---|---|---|
| `email`, `mail`, `メール`, `邮箱` | Keep the local part's first character plus `***`. Keep the first and last character of the first domain label with `***` between them. For a one- or two-character label, keep only its first character plus `***`. Keep subsequent labels. Invalid input becomes `***`. | `taro@example.jp` → `t***@e***e.jp` |
| `name`, `氏名`, `名前`, `姓名` | Keep the first grapheme. Add one `*` per remaining grapheme, up to three. Empty stays empty. | `山田太郎` → `山***`; `山田` → `山*` |
| `phone`, `tel`, `電話`, `电话` | Replace every digit except the last two with `*`. Keep separators. | `000-0000-0012` → `***-****-**12` |
| `address`, `住所`, `地址` | Keep the first two characters, followed by `***`. | `Sample Street` → `Sa***` |
| No match | Leave unchanged. This is not a check that the value is safe. | `locale: ja` stays `ja`. |

Reports are masked by default. This includes invalid sample values, typo suspects and
their suggestions in both Markdown and JSON. Treat reports as local files even when the
samples are masked. Do not print raw columns or free text just because the dispatcher
does not recognize the field name.

## Masked exports

`mask-data` writes a separate copy to `workspace/output/masked/`. The export uses
`MASK_HMAC_KEY` from `.env`; `init-workspace` generates the key if it is empty. Never
print or share it. The masking function rejects an empty key.

For each normalized address, compute HMAC-SHA256 over the **full normalized email**.
Use `u` plus the first 16 hex characters as the new local part. With the same key and
address the value is stable, so duplicate and overlap analysis still works. Different
keys give different tokens.

| `masking.keep_domain` | Export domain |
|---|---|
| `true` (default) | Keep the real domain to preserve domain distribution. |
| `false` | Use `d` plus the first eight hex characters of HMAC-SHA256 over `domain:` followed by the original domain, then append `.invalid`. |

Replace other personal data, such as names, phone numbers and addresses, with synthetic
values or blanks. Retain only the shape needed for debugging, such as columns, encoding
and null rates. A stable token and a retained domain can still reveal relationships or
affiliations. Review the export before sharing.

Phase 1 blanks these fields (the column stays, values become empty) instead of inventing
synthetic values; the null rate of the original column is reported alongside.

## Synthetic fixtures

Fixtures may model data shape (headers, encodings, and kinds of anomalies) but must
not derive values from real records or masked exports. Generate synthetic data with
`scripts/make-fixtures.ts`. The deterministic output is committed under `fixtures/`:
source metadata and files in `sources/`, example decisions in `overrides/`, and expected
results in `expected.json`. Use `example.com`, `example.jp`, `example.net`, and
`example.org` for addresses, and example-only typo variants such as `example.con` or
`example.co.jo` to exercise typo detection.

Preserve coverage for the supported formats and encodings: CP932 with Japanese headers
and two dated exports of one source, GB18030 with a four-byte character, UTF-16LE TSV,
UTF-8 with BOM and automatic mapping, XLSX, SQLite, a JSON array, and a file with
`header_row: 3`. Include address cleanup, invalid and empty input, role and typo flags,
legacy dots, dot and plus variants that remain distinct, duplicates, test-account
exclusion, and all three consent statuses with a change between dated exports.

Include one UTF-8-with-BOM form export with a `Submission time` header and English
month-name dates in full and abbreviated forms, with AM, PM and date-only examples.
Add a duplicate CSV with reordered columns and a subdirectory of `.md` pages. List only
the original CSV in `meta.md` to check that the other files are not staged.

## Workspace and sharing

Keep real data in the workspace, outside Git and automatic cloud-sync folders. Encrypt
backups. **Only masked copies in `output/masked/` may leave the machine.** Original
sources, staging, the database, backups, overrides, reports and provider dry-run exports
stay local. Generating a provider export does not authorize transferring it.
