# Lessons and user adjustments

Back to the [board](README.md). Newest first. Record a row when the user corrects the process, an escalation reveals a gap in a brief, an outsourced job fails, or a trap costs time. When a row becomes a project-wide rule, write the rule once in AGENTS.md and fill "Promoted to" with a link; do not restate it here.

| Date | Source | Lesson or adjustment | Promoted to |
|---|---|---|---|
| 2026-11-26 | user (relayed from side chat) | Real exports include Notion-style form data: English month-name dates with AM/PM, `Submission time` headers, duplicate CSVs with reordered columns, and per-entry .md subfolders. | Added R5 formats, R6 synonyms, R9 directory rules, fixture `form-eta` ([phase-1.md](../design/phase-1.md)); real column names stay in workspace meta.md only (AGENTS.md rule 8). |
| 2026-11-26 | user | “gpt 和 agy 虽然各有两个，但是不要交替使用，而是等一个的额度用完以后，才开始用下一个” | Global rule, written to ~/.subagent-team/harness-t3-code.md (local config, not in this repo). This session so far used only the primary accounts gpt-leon and agy-sha. |
| 2026-11-26 | user | “GPT 的话永远都是优先使用 gpt-leon，只有这个没有额度了，在恢复之前，使用 gpt-yoko，当 gpt-leon 的额度恢复以后还是用他” | Same rule as above, GPT wording; recorded in ~/.subagent-team/harness-t3-code.md. |
| 2026-11-26 | user | “opencode 渠道只使用其中的 claude 渠道，作为主 session 中 claude 各模型的备胎” | Global: opencode-sol disabled and removed from routing/fallbacks in ~/.subagent-team/compute.json; harness overlay updated. T1 (done) and T8 (running) were dispatched on OpenCode GPT before this rule. |
