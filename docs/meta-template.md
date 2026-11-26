# Source metadata (`meta.md`)

Put one `meta.md` beside the original files in `workspace/resources/<source>/`. Use
lowercase letters, digits and hyphens for the directory name. The `source` value must
match it. When the same source has multiple exports, include the export date in each
filename. Convert old `.xls` files to `.xlsx` before adding them.

The script reads the YAML frontmatter between the `---` lines. The body is notes for
humans. List only intended input files and keep them read-only.

## Source directory contents

Data files must be regular files directly in the source directory. Subdirectories are
ignored and reported; the pipeline does not read them recursively. `meta.md`,
`meta.draft.md`, `NOTES.txt` and other `.md` files are never data.

Review the draft from `add-source` before using it. It keeps the first suspected duplicate
by filename in `files:` and comments out the others with `# suspected duplicate of <file>`.
The summary asks you to confirm. Suspected duplicates have the same headers and rows even
if the column or row order differs; see [how files are compared](cleaning-rules.md#source-directory-contents).
The metadata loader warns about unlisted data files. Staging reads only the files listed
in `meta.md`.

## Full template

Replace the sample file and source names. Remove format-specific keys that do not apply.
Leave the `consent_values` block commented out to use built-in values.

```markdown
---
source: fictional-source
kind: product
label: null
files:
  - name: members_2025-03-01.csv
    encoding: auto
    sheet: null
    header_row: 1
    table: null
    query: null
    delimiter: null
columns:
  email: null
  name: null
  created_at: null
  last_seen_at: null
  locale: null
  consent: null
# consent_values:
#   granted: ['yes']
#   denied: ['no']
consent_basis: unknown
exported_at: null
---

## Notes

- Explain how these files were collected and what period they cover.
- Note known test accounts, unclear columns or other data quality issues.
```

## Source fields

| Field | Meaning | Default or omission |
|---|---|---|
| `source` | Source tag, exactly the directory name. | Required. |
| `kind` | `product`, `event` or `other`. | Required. |
| `label` | A label for humans. Use `null` if there is none. | Use explicit `null` for no label. |
| `files` | List of file entries to import. See below. | Supply the input list. |
| `columns` | Map a standard field to its original header. Allowed keys are `email`, `name`, `created_at`, `last_seen_at`, `locale` and `consent`. | Missing or empty mappings use auto-detection. Use `null` for individual keys you want auto-detected. |
| `consent_values` | Optional `granted` and `denied` lists of raw cell strings. Quote strings such as `'1'` and `'true'`. When present, only listed values count. | If omitted, use the [default value table](consent-policy.md#default-value-table). |
| `consent_basis` | Collection basis: `opt_in`, `transactional` or `unknown`. See [source-level consent](consent-policy.md#source-level-basis-and-configuration). | Use explicit `unknown` when you cannot establish the basis. |
| `exported_at` | Source export date, `YYYY-MM-DD`, used in the merge priority for unlisted sources. | Use explicit `null` if unknown. |
| `dir` | Absolute source directory filled by the loader. | Do not write it in frontmatter. |

Omitted `label` and `exported_at` become null; omitted `consent_basis` becomes `unknown`. Unknown
frontmatter keys (for example a `timezone` note) produce a warning, not an error. The template
supplies a value for each field.

## File fields

| Field | Meaning | Default or omission |
|---|---|---|
| `name` | Input filename inside the source directory. | Required per entry. |
| `encoding` | `auto`, `utf-8`, `utf-8-sig`, `cp932`, `gb18030`, `utf-16le` or `utf-16be`. Applies to text decoding. | `auto` (see [encodings](cleaning-rules.md#encodings)). |
| `sheet` | XLSX sheet name. | First sheet if unspecified. |
| `header_row` | One-based header row number. Use `3` if the first two rows precede the header. | `1`. |
| `table` | SQLite source table to read. | Omit when using `query`. |
| `query` | SQLite `SELECT` to read instead of a table. | Omit when using `table`. |
| `delimiter` | Delimiter for CSV or TSV. | Auto-detect if unspecified. |

For SQLite, specify `table` or a read-only `query`. Both is an error. Neither: the loader uses the
only table in the file, and fails with the list of tables when there are several.

## Filled example

Example path: `workspace/resources/paper-garden/meta.md`. The source and data below are
fictional.

```markdown
---
source: paper-garden
kind: product
label: Paper Garden members
files:
  - name: members_2025-03-01.csv
    encoding: utf-8
    header_row: 1
    delimiter: ','
columns:
  email: メールアドレス
  name: 氏名
  created_at: 登録日
  consent: 配信希望
consent_values:
  granted: ['受け取る']
  denied: ['受け取らない']
consent_basis: unknown
exported_at: '2025-03-01'
---

## Notes

- Synthetic member export as of March 1, 2025.
- 配信希望 records the member's newsletter choice. An empty value is unknown.
```

Example `members_2025-03-01.csv`:

```csv
メールアドレス,氏名,登録日,配信希望
reader@example.jp,山田花子,2025/02/01,受け取る
guest@example.jp,鈴木太郎,2025/02/12,受け取らない
```
