# Documentation

Specifications, design decisions, and requirements for `email-digging-skills`.

## Specifications

- [schema.md](schema.md) — SQLite tables, views (`v_sendable_strict`, `v_not_blocked`, `v_source_overlap`), merge lifecycle, and Postgres porting notes.
- [cleaning-rules.md](cleaning-rules.md) — Source directory rules, encoding detection, email normalization, date parsing, column synonyms, deduplication/merge, and YAML overrides.
- [meta-template.md](meta-template.md) — `meta.md` frontmatter schema, per-file options, defaults, and synthetic example.
- [consent-policy.md](consent-policy.md) — Per-source consent statuses, default value table, conflict/suppression precedence, and strict vs. loose sendable lists.
- [masking.md](masking.md) — Display masking rules, HMAC-SHA256 masked database copies, synthetic fixture requirements, and the sharing boundary.

## Design and requirements

- [design/phase-1.md](design/phase-1.md) — Phase 1 architecture, recorded design decisions, module map, interfaces, and rule details.
- [init/REQUIREMENTS.md](init/REQUIREMENTS.md) — Original project requirements and pipeline intent (Chinese).

## Maintainer work log

- [agent-team/](agent-team/README.md) — Maintainers' internal agent-team coordination board, task briefs, and work log.
