---
source: cn-delta
kind: other
label: CN Delta Users
files:
  - name: users_2024-12-31.csv
    encoding: gb18030
    header_row: 1
columns:
  email: 邮箱
  name: 姓名
  created_at: 注册时间
  consent: 订阅
consent_basis: unknown
exported_at: 2024-12-31
---

## Notes

- Synthetic GB18030 CSV export with Chinese headers and a 4-byte GB18030 character (U+20000).
- Covers rejected typo override, Gmail no-dot variant, in-file duplicate with mixed case, double-@ invalid syntax, and whitespace-only empty cell.
