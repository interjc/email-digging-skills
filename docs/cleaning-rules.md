# Cleaning and merge rules

Keep original files read-only. The scripts write staging and reports under `workspace/output/`.
Record human decisions in `workspace/overrides/`, not in an input file or the database.

## Source directory contents

Only regular files directly under `resources/<source>/` are candidates. Report and ignore
subdirectories. `meta.md`, `meta.draft.md`, `NOTES.txt` and all `.md` files are never data.

`add-source` flags suspected duplicate files with the same header set and the same multiset
of rows. It ignores column order by aligning columns before hashing rows for comparison.
Row order does not matter; repeated rows still count. Files with the same headers but
different rows are not duplicates.

In each suspected-duplicate group, list the first file by name in the draft. Comment out
the other entries with `# suspected duplicate of <file>` and ask a human to confirm.
The metadata loader warns about unlisted data files, and staging reads only the files
listed in `meta.md`. See [the metadata template](meta-template.md#source-directory-contents).

## Encodings

For text inputs, resolve the encoding in this order:

1. Use the non-`auto` encoding from `meta.md` (`encodingHow: meta`). A decode error is a hard
   error, not a reason to try a different encoding.
2. If there is a byte order mark (BOM), use it (`encodingHow: bom`): `EF BB BF` means
   `utf-8-sig`, `FF FE` means `utf-16le`, and `FE FF` means `utf-16be`.
3. Try `utf-8`, `cp932`, then `gb18030` with fatal decoding (`encodingHow: detected`). If
   UTF-8 fails and both CP932 and GB18030 decode, prefer the better header synonym match.
   If that ties, kana (`U+3040`–`U+30FF`) favors CP932. List every successful candidate in
   try order and ask a human to confirm every detected result.

CP932 is common in Japanese Excel CSV exports. Node's `TextDecoder` uses the WHATWG
`shift_jis` label for Windows-31J, which supports characters such as `①`, `㈱` and `髙`.
GB18030 handles Chinese exports, including four-byte sequences. Excel's “Unicode Text”
export is typically UTF-16LE TSV.

Decode text in Node with `TextDecoder(label, { fatal: true })`. Write decoded text as UTF-8
without a BOM under `output/staging/<source>/_decoded/` for DuckDB to read. Do not rely on
DuckDB to decode non-UTF-8 text: its GB18030 table rejects four-byte sequences. XLSX and
SQLite inputs do not have a resolved text encoding.

## Email normalization

1. A null, missing or whitespace-only cell yields one rejection with reason `empty`.
2. Apply Unicode NFKC to the address and add `width_normalized` if it changes the address
   part. Remove `U+200B`–`U+200D`, `U+2060`, `U+FEFF`, `U+00AD` and control characters.
   Trim whitespace (including `U+3000`). Strip `mailto:` regardless of case and surrounding
   angle brackets, double or single quotes, parentheses and square brackets. For
   `Name <addr>`, keep the address.
3. Split multiple addresses on commas, semicolons, `、`, `，`, `；`, the pipe character,
   newlines and whitespace. Two or more non-empty parts get `split_from_multi`.
   Collapse duplicate parts within the cell.
4. Lowercase the entire address. Keep dots and `+tag` aliases distinct; do not apply
   Gmail-style dot or plus folding.
5. Validate the syntax below. Reject failures as `invalid_syntax` with no normalized
   address. Keep the original input for review.
6. Flag a leading, trailing or consecutive dot in the local part as `legacy_mobile_dots`.
   These addresses still pass syntax validation.
7. Look up the local part before any `+` in
   [`scripts/lib/rules/role-locals.json`](../scripts/lib/rules/role-locals.json). If it
   matches (for example `info` or `support`), flag `role_address` and set status `role`.
   Do not discard role addresses.
8. Look up the domain in
   [`scripts/lib/rules/domain-typos.json`](../scripts/lib/rules/domain-typos.json) and check
   the suffix rules below. A match yields status and flag `typo_suspect` and suggests the
   same local part with the corrected domain. Do not apply the correction automatically.

Syntax: exactly one `@`, total length at most 254 characters, and a local part of 1–64
characters from this set:

```text
A-Za-z0-9.!#$%&'*+/=?^_`{|}~-
```

The domain has at least two non-empty labels containing only lowercase ASCII letters,
digits or hyphens. A label cannot start or end with a hyphen. The final label has at least
two letters and contains letters only.

Suffix suggestions: `.co.jo` → `.co.jp`, `.ne.jo` → `.ne.jp`, `.or.jo` → `.or.jp`,
`.con` / `.cmo` / `.comm` → `.com`, and `.nett` → `.net`. For example, `member@example.con`
suggests `member@example.com`. Status precedence is `typo_suspect`, then `role`, then
`valid`; keep both flags when both rules match.

## Dates

Accept `YYYY-MM-DD`, `YYYY/MM/DD`, `YYYY/M/D`, `YYYY.MM.DD`, and `YYYY年M月D日`.
Each may be followed by ` H:mm[:ss]`. Also accept ISO-8601 datetimes and, in a date column,
Excel serial numbers from 1 to 100000 in the 1900 date system.

Form exports can use `MMMM D, YYYY h:mm A` or `MMMM D, YYYY`, with a full English month name
or a three-letter abbreviation. For example, `June 28, 2025 11:46 AM`, `Jun 28, 2025 11:46 AM`,
`June 28, 2025` and `Jun 28, 2025` are valid. Month names are case-insensitive. On the
12-hour clock, 12 AM becomes hour `00` and 12 PM becomes hour `12`.

Output `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm:ss` without timezone conversion. Unparseable
dates become null; the original field value stays in `raw_fields`.

## Column detection

Use explicit `meta.md` mappings first. Compare headers after NFKC, lowercasing, and removing
spaces, underscores and hyphens.

| Standard field | Header synonyms |
|---|---|
| `email` | email, e-mail, mail, mailaddress, emailaddress, メール, メールアドレス, eメール, 邮箱, 电子邮件, 邮件地址, 电邮 |
| `name` | name, fullname, displayname, username, 氏名, 名前, お名前, 姓名, 名字, 用户名, 联系人 |
| `created_at` | createdat, created, registeredat, signupdate, signedupat, joined, date, 登録日, 登録日時, 申込日, 申込日時, 作成日, 注册时间, 注册日期, 创建时间, submissiontime, submittedat, 提交时间 |
| `last_seen_at` | updatedat, lastseen, lastlogin, lastloginat, lastactive, 最終ログイン, 最終ログイン日時, 更新日, 更新日時, 最后登录, 最后登录时间 |
| `locale` | locale, language, lang, 言語, 语言 |
| `consent` | consent, newsletter, optin, subscribe, subscribed, marketing, メルマガ, メルマガ配信, メールマガジン, 配信希望, ニュースレター, 订阅, 订阅邮件, 接收邮件 |

`Submission time` and `Submitted at` normalize to exact `created_at` synonyms. An explicit
mapping has confidence `1.0`, an exact synonym match `0.9`, and a synonym contained in a
header `0.7`. If the email header cannot be identified, check the first 200 non-empty
values per column after NFKC. Pick the column with the highest share containing `@` if
that share is at least 50%. This is `content_sniff`; confidence is the share.

Use and report mappings below `0.8` for review. If no email column can be found, skip that
file, report an error and fail the run without changing the database. Invalid `meta.md` also
stops the run before database changes.

## Dedupe and merge

Stage each source as `rows.parquet`, `rejected.parquet` and `stats.json`. One staged row
represents one usable address candidate, so a split cell can produce more than one row.
Count extra normalized occurrences within each file. Keep empty, invalid and excluded
entries as rejections for review rather than modifying the inputs.

Upsert one contact per normalized email, across files and sources, preserving its ID and
all current source tags. Keep the raw email and original fields from the representative
row for each contact and source. Keep source first- and last-seen dates from date columns
or null when no usable date is available.

For names and other merged profile fields, take the first non-empty value in the resolved
source order. Listed sources follow `sources.priority` from highest to lowest. Unlisted
sources follow them, newest `exported_at` first, then by name.

Resolve consent separately for each source. Newest file wins; a denial wins a conflict
within the same file. See [consent policy](consent-policy.md) for value matching and evidence.
Back up the existing database before merging. Mark addresses missing from all sources as
orphaned, rather than deleting them. See [merge lifecycle](schema.md#merge-lifecycle) for
which tables are rebuilt and which keep history.

Representative row for each (address, source): the newest file wins, judged by a `YYYY-MM-DD`
date in the file name; files without a date rank below dated ones, in their `meta.md` order
(later = newer); within the file, the lowest row number wins. Contact-level `first_seen_at` is
the earliest `first_seen_at` over all of the contact's sources.

## Human overrides

Put each YAML list in the named file under `workspace/overrides/`. The scripts read the
files on every run. A missing file is an empty list. `note` is optional in every list.

**`typo-decisions.yaml`** — `action` is `accept` or `reject`. On acceptance, replace only the
normalized address, preserve the raw input, and flag `typo_accepted`. Rejection does not
apply the suggestion. `suggested` is optional.

```yaml
- email: member@example.con
  action: accept
  suggested: member@example.com
  note: Confirmed the corrected address.
- email: guest@example.co.jo
  action: reject
```

**`suppressions.yaml`** — `reason` is `unsubscribed`, `bounced`, `complained` or `manual`.
An inserted suppression stays in the database even if its entry is removed from YAML.

```yaml
- email: pause@example.jp
  reason: manual
  note: Do not send to this address.
```

**`consents.yaml`** — a human decision for one email and source. `status` is `granted`,
`denied` or `unknown`. The override is recorded as evidence.

```yaml
- email: reader@example.jp
  source: product-a
  status: denied
  note: Confirmed the recipient withdrew consent.
```

**`exclude.yaml`** — match a test account by exact email or a glob on normalized email.
Matches are rejected as `excluded_by_override`.

```yaml
- email: tester@example.jp
- pattern: 'test-*@example.jp'
  note: Test accounts.
```

Conflicting entries for the same key in one override file: the last entry wins and the report
warns. An exclusion matches either the address before or after an accepted typo correction.

## Cleaning report

The scripts write Markdown and JSON under `output/reports/`. The report includes:

- Per file: rows read, empty email count, invalid count, number of cells split, in-file
  duplicates (extra occurrences), role address count and suspected typo count.
- Per file: encoding and column mappings, including confidence for the mappings. Highlight
  detected encodings and their candidates, and mappings to review.
- Across sources: number of addresses found in two or more sources, final unique contact
  count and the source-overlap matrix.
- Merge details when available: resolved source order, new contacts, newly orphaned
  contacts, backup path and counts of applied overrides.
- Masked samples of invalid entries and suspected typos (including masked suggestions).

A dry run has no merge results. See [masking](masking.md) for what can be displayed or shared.
