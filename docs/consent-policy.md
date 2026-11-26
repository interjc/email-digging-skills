# Consent policy

Keep the decision and its evidence for each address and source. Consent is not a single
field on a contact. Source membership, consent, and suppression are separate facts.

## Row statuses and evidence

| Status | Meaning |
|---|---|
| `granted` | A recognized affirmative value or an explicit human decision. |
| `denied` | A recognized negative value or an explicit human decision. |
| `unknown` | No recognized value, no consent column, or a human decision of `unknown`. This is not consent. |

For source evidence, record the original column and value, filename, and one-based data
row number. Human decisions go in `workspace/overrides/consents.yaml`, keyed by normalized
email and source; keep override evidence. Do not infer row-level `granted` from source
membership or a transactional relationship.

## Default value table

Compare values after NFKC, trimming and lowercasing. These defaults apply only when
`meta.md` has no `consent_values` setting.

| Status | Values |
|---|---|
| `granted` | `1`, `true`, `yes`, `y`, `on`, `是`, `配信する`, `配信希望`, `希望する`, `受け取る`, `受信する`, `購読`, `購読する`, `subscribed`, `subscribe`, `opt-in`, `optin`, `○`, `〇`, `◯` |
| `denied` | `0`, `false`, `no`, `n`, `off`, `否`, `配信しない`, `配信停止`, `希望しない`, `受け取らない`, `受信しない`, `購読しない`, `unsubscribed`, `unsubscribe`, `opt-out`, `optout`, `×`, `✕` |
| `unknown` | Empty or anything not recognized. If there is no consent column, every row starts as `unknown`. |

If `consent_values` is supplied, it replaces the defaults. Only listed values count;
omitting one list does not restore defaults for that status.

A value that appears in both custom lists after normalization is a meta.md error: the run stops
and names the value.

## Source-level basis and configuration

`consent_basis` in `meta.md` describes how that source collected its addresses:

| Basis | Meaning |
|---|---|
| `opt_in` | The source collected addresses with opt-in evidence. |
| `transactional` | The source collected addresses for a transaction, not necessarily for marketing. |
| `unknown` | The collection basis is not established. |

The merge sets `sources.counts_as_opt_in` when either the basis or the source name is on
its corresponding list in `config.yaml`:

| Config key | Effect | Default |
|---|---|---|
| `consent.opt_in_bases` | Sources with a listed basis count as opt-in. | `[opt_in]` |
| `consent.opt_in_sources` | Listed sources count as opt-in regardless of basis. | `[]` |

Only mark sources as opt-in when you can justify it. Which real sources qualify is
the user's decision and lives only in their `config.yaml`, never in the repository.

## Conflicts and suppressions

For the same address within one source, use the row from the newest file. When rows in
that file conflict, `denied` wins. Keep each source's resolved status separately. A
`denied` in any source blocks the whole address, even if another source granted consent
or counts as opt-in.

Suppressions always win. A single suppression for the normalized email blocks both lists,
irrespective of its reason or source, or of any grant or opt-in basis. Suppressions are
append-only and remain effective if the contact disappears and later returns.

## The two lists

| View | Eligibility |
|---|---|
| `v_sendable_strict` | Still present in a source, no suppression, no source denial, not a typo suspect, and positive consent: at least one source says `granted` or a current source counts as opt-in. |
| `v_not_blocked` | Still present in a source, no suppression and no source denial. This can include addresses without positive consent and unresolved typo suspects. |

Strict is the export default. Choosing the loose list takes an explicit flag and prints a
warning. Role addresses are not excluded merely for being role addresses; they stay
flagged in exports.

The strict default requires positive evidence rather than treating silence as permission.
Japan's Act on Regulation of Transmission of Specified Electronic Mail generally requires
prior opt-in for marketing email, with exceptions. This is not legal advice. Check the
rules in your own jurisdiction and verify that your evidence covers the planned send.
Passing either view is not, by itself, permission to send.

## Before sending

Run paid email verification on the subset you plan to send to, after screening for
consent and suppressions. This helps control bounces; high bounce rates can lead a sender
such as Amazon SES to review or suspend an account. Verification does not establish consent.

Phase 1 only writes a local dry-run CSV; it does not send email or call a provider API.
Get human approval before any external write or send. Follow the
[workspace sharing boundary](masking.md#workspace-and-sharing).

Open: the paid verification service is not chosen yet. Sending addresses to a verifier is an
external transfer: it needs explicit human approval each time, like a provider push.
