---
source: zeta-signup
kind: event
label: Zeta Signup
files:
  - name: signup_2025-01-15.csv
    encoding: utf-8-sig
    header_row: 1
  - name: extra_2025-01-15.json
    encoding: utf-8
columns: {}
consent_basis: transactional
exported_at: 2025-01-15
---

## Notes

- Synthetic event signup export combining a UTF-8-with-BOM CSV and a JSON array.
- Leaves columns empty for auto-detection; includes zero-width space, QA test account for exclude.yaml, mixed case, mailto: prefix, and missing-local invalid syntax.
