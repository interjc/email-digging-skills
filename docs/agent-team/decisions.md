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
- Status: planned (waiting for the Grok open-source research report)
