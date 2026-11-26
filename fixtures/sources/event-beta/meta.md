---
source: event-beta
kind: event
label: Event Beta Attendees
files:
  - name: attendees_2023-11-03.xlsx
    encoding: auto
    sheet: attendees
    header_row: 1
  - name: walkin_2023-11-03.csv
    encoding: utf-8
    header_row: 3
columns:
  email: Email
  name: Name
  created_at: Registered
  locale: Locale
consent_basis: unknown
exported_at: 2023-11-03
---

## Notes

- Synthetic event export with an Excel workbook (sheet `attendees`) and a walk-in CSV with two title lines before the header (header_row: 3).
- Covers Name <addr>, in-file duplicate in xlsx, numeric-TLD invalid syntax, and support@ role address.
