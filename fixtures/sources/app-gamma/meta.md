---
source: app-gamma
kind: product
label: App Gamma Users
files:
  - name: app_2025-08-01.db
    encoding: auto
    table: users
columns:
  email: email
  name: display_name
  created_at: created_at
  consent: newsletter
  locale: locale
consent_values:
  granted:
    - "1"
  denied:
    - "0"
consent_basis: opt_in
exported_at: 2025-08-01
---

## Notes

- Synthetic SQLite export with table `users` and integer newsletter flags (1, 0, NULL).
- Covers mailto:, mixed case, full-width ＠, NULL email cell, and cross-source match with accepted typo from shop-alpha.
