# Agent team board

Live and durable state of agent work in this project: which task follows which flow, who holds it, what waits for whom. Rules and the team policy live in [AGENTS.md](../../AGENTS.md) (section `## Subagent team`); this directory links to them and never restates them.

The director (L1) maintains this file. Each card under `tasks/` has exactly one writer at a time: its holder.

## Reading order (take-over)

1. This file: tasks and their holders
2. [progress.md](progress.md): status snapshot, completed log, next-up queue, open questions for the human
3. [decisions.md](decisions.md) and [lessons.md](lessons.md) for the area you will touch
4. The cards of the tasks you take over; open escalations: `team-board.mjs status`

## Tasks

| Task | Title | Flow | Holder | Status |
|---|---|---|---|---|
| [T0](tasks/T0.md) | Contracts: types, migrations, config templates, AGENTS.md, design doc | solo | director | committed |
| [T1](tasks/T1.md) | Spec docs: schema, cleaning-rules, consent-policy, masking, meta-template | outsource | director | committed |
| [T2](tasks/T2.md) | Email normalization module + rule tables + tests | outsource | director | in-progress |
| [T3](tasks/T3.md) | Masking module, staged-email scan, git hook, CI | outsource | director | in-progress |
| [T4](tasks/T4.md) | Synthetic fixtures + generator | outsource | director | in-progress |
| [T5](tasks/T5.md) | Workspace, config, env, overrides, db + init-workspace CLI | direct | in-house sonnet-5.5 · high | committed |
| [T6](tasks/T6.md) | Probe, decode, read, column detect, staging + add-source CLI | direct | in-house sonnet-5.5 · high | in-progress |
| [T7](tasks/T7.md) | Merge into SQLite, reports, clean-and-merge + review-report CLIs | designed | director | planned |
| [T8](tasks/T8.md) | query, mask-data, export CLIs + provider interface + listmonk dry-run | direct | director | planned |
| [T9](tasks/T9.md) | Skills SKILL.md, README (en, zh-CN), CONTRIBUTING, apps/providers READMEs | outsource | director | planned |
| [T10](tasks/T10.md) | Demo run, end-to-end on fixtures, then real-data run with user confirmation | direct | director | planned |

## Files

- [progress.md](progress.md): status snapshot, completed log, next-up queue, user decisions, open questions, pitfalls
- [decisions.md](decisions.md): numbered decisions; never rewritten, only marked overturned
- [lessons.md](lessons.md): user adjustments and lessons learned; rules promoted from here live in [AGENTS.md](../../AGENTS.md)
- `tasks/<ID>.md`: one card per task or external job (flow, holder, lease, log, questions, result)
