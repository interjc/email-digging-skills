# Decisions

Back to the [board](README.md). Append new decisions at the end. Never rewrite one: when it is overturned, add an "Overturned (YYYY-MM-DD)" note under its heading.

<!--
### D-01: <title> (<YYYY-MM-DD>)
- Decision: <...>
- Decided by: <user / director / L2 expert>; user's words: "<verbatim quote>"
- Motivation and evidence: <...>
- Rejected options: <...>
- Overturn if: <...>
- Status: <planned | landed in <commit>>
-->

## 2026-11-26 · Automatic domain-typo check: classify, never auto-fix

- Decision: the next-round typo checker runs automatically and sorts suspects into two lists: obvious
  (e.g. the domain has no MX, a well-known provider is one edit or one transposition away, and that provider
  has MX) and ambiguous (everything else, such as a real domain that resembles a provider). Obvious items come
  first. A human still decides every fix in `workspace/overrides/typo-decisions.yaml`, so AGENTS.md data rule 5
  stays unchanged. The checker may pre-fill a suggested action for obvious items, but nothing applies until the
  human writes the decision.
- Decided by: the user ("可以，先自动检查 标记 显而易见的问题，和比较模糊的先后列出来，人工决定怎么 fix 是可以的")
- Motivation and evidence: two typo suspects in the first real-data merge; the user wants less manual triage
  without silent rewrites.
- Rejected options: auto-accept high-confidence suggestions (would relax data rule 5).
- Overturn if: the user asks for auto-apply.
- Research (Grok, 2026-11-26): no library implements this rule. mailcheck on npm is the 2015 release, and the
  forks (@zootools/email-spell-checker, email-misspelled) use loose distance-2 matching with Western provider
  lists. deep-email-validator turns DNS timeouts into "no MX". Plan: our own module with no dependency, using
  `node:dns/promises` `Resolver` (timeout and tries set; host resolver, never a public one). It classifies each
  domain as accepts / refuses / unknown per RFC 5321 §5.1 (MX, else A/AAAA) and RFC 7505 (null MX); ENOTFOUND
  is refuses, ENODATA means try A/AAAA, a timeout or SERVFAIL is unknown. Only the domain is queried, deduped,
  cached and concurrency-capped, with no SMTP probes. A curated list of full provider domains includes
  163/126/yeah.net/foxmail/sina.com/sina.cn/189.cn/139.com and docomo/ezweb/softbank.ne.jp.
  "Obvious" = the typed domain refuses and is not on the list; exactly one provider is at Damerau-Levenshtein
  distance 1 and is not distance 1 from another provider; that candidate accepts; the label count is equal;
  and the differing label is at least 5 characters. Everything else is "ambiguous": distance 2, ties, a
  typed domain that accepts mail, or any DNS failure. Traps to test: gmail.co, mail.com, 126.com vs 163.com,
  sina.cn, q.com, yahoo.co.jp, a registered typo domain with its own MX. DNS lookups run only behind an
  explicit flag, because they reveal the list's domains to the resolver.
- Status: planned (design ready; implement next round when the user says go)

## 2026-11-27: same address, several user ids (D36)

- User: "有一些用户 id 不一样，但是 email 一样，这样的用户可以合并，不一致的数据以最后的用户为主或者叠加"; for open
  points: "你拿不准的可以用 opencode 的 fable 5.2 帮你评估就行了，以他的推荐为准".
- Fable 5.2 review (brief `briefs/R7-review-D36.md`), adopted: file rank before activity; row order is only a
  tiebreak; activity (`last_seen_at` else `created_at`) defines "latest user"; consent keeps D15 (denied in the
  newest file wins); suppression markers are mapped by the maintainer, not derived; `_merged_rows` stays inside
  `raw_fields`, nested `{file, row_number, fields}`, collapsed and capped (20); reserved-key guard; consent
  evidence follows recency order; `query` passes `file`/`column` only for evidence and stacking metadata;
  `mask-data` drops the stacking keys.
- Merge-stats counter (Fable defect 9) adopted on the user's go ("可以按 fable 建议来"): `MergeStats.same_address_rows`,
  printed by clean-and-merge and in the run report (counts only).
