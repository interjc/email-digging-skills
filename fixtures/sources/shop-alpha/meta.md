---
source: shop-alpha
kind: product
label: Shop Alpha Members
files:
  - name: members_2025-03-01.csv
    encoding: cp932
    header_row: 1
  - name: members_2025-09-01.csv
    encoding: cp932
    header_row: 1
columns:
  email: メールアドレス
  name: 氏名
  created_at: 登録日
  consent: メルマガ配信
consent_basis: opt_in
exported_at: 2025-09-01
---

## Notes

- Synthetic CP932 CSV exports from a fictional online shop (two dated snapshots).
- Covers CP932-only characters (①, ㈱, 髙), consent changes across exports, in-file conflicting consent, full-width address, multi-address split, legacy mobile dots, role address, and typos.
