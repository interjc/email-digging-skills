# Progress

Back to the [board](README.md). Dates are absolute (YYYY-MM-DD). Acceptance numbers are written once, in the completed log.

## Status snapshot

<!-- newest first: one entry per recently accepted, committed or in-flight task -->
- 2026-11-27: one more real source onboarded (add-source, user answered meta.md questions, blocked/suspended users recorded as suppressions by script without reading addresses, dry-run, merge, check-domains --dns --auto-accept). Masked output only; names and counts stay out of the repo.
- 2026-11-26: T10 done: first real-data merge (sample source first, then all current sources), masked output only. Phase 1 complete. Pending for the user: typo decisions in workspace/overrides/typo-decisions.yaml; new sources go through add-source → meta.md review → dry-run → merge.
- 2026-11-26: T9 accepted (6b128f2, agy-sha gemini-4-carbon). R5 finding 1 fixed by director (b059e4e), 2–7 deferred on the T8 card. Phase 1 code complete; only T10 part 2 (real data) remains, waiting for the user's go-ahead.
- 2026-11-26: T0–T7 accepted and committed; T8 committed (306c43f), review R5 running on Codex gpt-leon; T9 running on agy-sha; T10 demo wiring committed (390d928), real-data run waits for T9 + user confirmation.
- 2026-11-26: T1–T6 dispatched in parallel (T1 OpenCode gpt-6.2-sol, T2 Codex gpt-leon gpt-6.2-sol, T3+T4 agy-sha gemini-4-neon, T5+T6 in-house Sonnet 5.5). T0 contracts committed (3085733, c444d93, 7ebdf26).

## Completed log

| Task | Spec / decision | Commit | Changes and verification |
|---|---|---|---|
| T0 | docs/design/phase-1.md | 3085733, c444d93 | contracts: types.ts, migrations 0001/0002 (applied with sqlite3), templates, AGENTS.md; tsc clean |

## Next-up queue

- Next round (user 2026-11-26): automatic domain-typo check and fix. Domain existence via DNS MX (not ping), known providers one character off, prefer an existing open-source checker. Research on Grok (web-research route). Needs a decision on data rule 5 (auto-accept vs flag only) before implementation.
1. T10 part 2: ask the user to confirm real files + meta.md, then dry-run, then merge (masked output only).

## Session choice

<!-- this session only: external teams allowed, confidentiality levels in use, "for now" preferences.
     The compute plan, quota ledger and usage log live in the local compute files (compute-config.mjs show), not here. -->
- 2026-11-26: global compute plan and T3 harness overlay, no session overrides; preferences review: keep (user: "我想用全局的委派规则").

## User decisions

<!-- numbered summary; the full record is in decisions.md -->
- 2026-11-26: D1–D8 in docs/design/phase-1.md (grill-me round with the user).

## Open questions

<!-- questions only the human can answer; never delete, mark answered -->
- [open] Backups: requirements §12 says backups must be encrypted. Local pre-merge backups in workspace/database/backups/ are unencrypted for now (same protection as the main db). Encrypt them, or only encrypt off-machine copies?
- [open] Paid verification service (requirements §13) — not needed for phase 1.
- [answered 2026-11-26 by the user, via side chat] Real-data run: the first real source is placed in workspace/resources/ (UTF-8-BOM form export). Its meta.md details are being settled with the user in the side chat. Before T10, still check that its meta.md exists and ask whether more sources are coming.

- [answered 2026-11-26: user said go, smallest source first] Real-data run: 4 source folders are in place (3 still without meta.md); the user will keep adding new sources to workspace/resources/ over time (correction 2026-11-26: "那个目录里面以后还会加新的 resources 的"), so each new folder gets add-source → reviewed meta.md → a full clean-and-merge; first run **not yet** approved (user answered "Not yet"). Wait for the user's go-ahead, then init-workspace → add-source ×3 (drafts) → review drafts with the user → clean-and-merge --dry-run → merge.

## Pitfalls

| Location | What it is | Why it is this way | Guidance |
|---|---|---|---|
- 2026-11-26: T5+T6 rework round 3 accepted and committed (ea54dc5). Waiting on T7 round 3 and T8.
