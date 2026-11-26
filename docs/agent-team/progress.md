# Progress

Back to the [board](README.md). Dates are absolute (YYYY-MM-DD). Acceptance numbers are written once, in the completed log.

## Status snapshot

<!-- newest first: one entry per recently accepted, committed or in-flight task -->
- 2026-11-26: T1–T6 dispatched in parallel (T1 OpenCode gpt-6.2-sol, T2 Codex gpt-leon gpt-6.2-sol, T3+T4 agy-sha gemini-4-neon, T5+T6 in-house Sonnet 5.5). T0 contracts committed (3085733, c444d93, 7ebdf26).

## Completed log

| Task | Spec / decision | Commit | Changes and verification |
|---|---|---|---|
| T0 | docs/design/phase-1.md | 3085733, c444d93 | contracts: types.ts, migrations 0001/0002 (applied with sqlite3), templates, AGENTS.md; tsc clean |

## Next-up queue

1. Accept T1–T6 (independent review per card), commit each.
2. T7 merge + reports (designed flow; in-house Opus implements, Codex reviews read-only).
3. T8 query / mask-data / export; T9 skills + READMEs; T10 demo + real-data run (ask the user first).

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

## Pitfalls

| Location | What it is | Why it is this way | Guidance |
|---|---|---|---|
