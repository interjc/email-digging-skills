// Deterministic generator for synthetic fixtures under fixtures/.
// Rewrites fixtures/sources/, fixtures/overrides/, and fixtures/expected.json.
// Usage: node scripts/make-fixtures.ts

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import { stringify as stringifyYaml } from 'yaml';
import type {
  ConsentBasis,
  DeclaredEncoding,
  MetaFile,
  Overrides,
  SourceKind,
  StandardField,
} from './lib/types.ts';

// ---------------------------------------------------------------------------
// Data-driven fixture schema
// ---------------------------------------------------------------------------

export type RowExpect =
  | 'valid'
  | 'empty'
  | 'invalid'
  | 'role'
  | 'typo'
  | 'legacy'
  | 'split:3'
  | 'excluded';

export interface RowAnnotation {
  expect: RowExpect;
  /** Normalized email address(es) produced before overrides (empty for empty/invalid). */
  emails: string[];
  /** Suggested corrected address when expect === 'typo'. */
  suggestion?: string;
}

export interface FixtureRow {
  cells: Record<string, string | number | null>;
  annotation: RowAnnotation;
}

export type FixtureFileKind =
  | 'csv'
  | 'tsv'
  | 'json'
  | 'xlsx'
  | 'sqlite';

export interface FixtureFileSpec {
  name: string;
  kind: FixtureFileKind;
  /** Physical encoding used to write text files (null for xlsx / sqlite). */
  physicalEncoding: 'utf-8' | 'utf-8-sig' | 'cp932' | 'gb18030' | 'utf-16le-bom' | null;
  /** Entry written to meta.md `files:`. Null means intentionally omitted from meta.md (e.g. R9 duplicate). */
  metaFile: MetaFile | null;
  headers: string[];
  /** Optional preamble lines before the header row (for header_row > 1). */
  preambleLines?: string[];
  /** Sheet name for xlsx files. */
  sheet?: string;
  /** Table name for sqlite files. */
  table?: string;
  rows: FixtureRow[];
}

export interface ExtraTextFileSpec {
  /** Path relative to the source directory, e.g. 'pages/welcome-note.md'. */
  relativePath: string;
  content: string;
}

export interface FixtureSourceSpec {
  source: string;
  kind: SourceKind;
  label: string;
  consent_basis: ConsentBasis;
  exported_at: string;
  /** Omit to leave `columns` out of meta.md; pass `{}` for empty `columns: {}`. */
  columns?: Partial<Record<StandardField, string | null>>;
  consent_values?: { granted?: string[]; denied?: string[] };
  notes: string[];
  files: FixtureFileSpec[];
  extraFiles?: ExtraTextFileSpec[];
}

export interface ExpectedFileCounts {
  rows_read: number;
  empty: number;
  invalid: number;
  cells_split: number;
  dup_in_file: number;
  role: number;
  typo_suspect: number;
}

export interface ExpectedJson {
  sources: Record<
    string,
    {
      files: Record<string, ExpectedFileCounts>;
      unique_emails: number;
    }
  >;
  after_overrides: {
    excluded: number;
    typo_accepted: number;
  };
  cross_source_dups: number;
  contacts_total: number;
  overlap: Array<{ a: string; b: string; contacts: number }>;
}

// ---------------------------------------------------------------------------
// Overrides (fixtures/overrides/*.yaml)
// ---------------------------------------------------------------------------

export const FIXTURE_OVERRIDES: Overrides = {
  exclude: [
    {
      email: 'qa-test@example.com',
      note: 'Internal QA test account',
    },
  ],
  typo: [
    {
      email: 'hiroshi.tanaka@example.con',
      action: 'accept',
      suggested: 'hiroshi.tanaka@example.com',
      note: 'Confirmed typo with customer',
    },
    {
      email: 'saki.watanabe@example.co.jo',
      action: 'reject',
      suggested: 'saki.watanabe@example.co.jp',
      note: 'Verified intentional test domain',
    },
  ],
  suppressions: [
    {
      email: 'naoki.saito@example.jp',
      reason: 'manual',
      note: 'Customer requested manual suppression',
    },
  ],
  consents: [],
};

// ---------------------------------------------------------------------------
// Synthetic sources (all names, people, and example.* addresses fictional)
// ---------------------------------------------------------------------------

const FORM_ETA_ROWS: FixtureRow[] = [
  {
    cells: {
      Name: 'Nina Park',
      Email: 'nina.park@example.com',
      'Submission time': 'June 28, 2025 11:46 AM',
      Newsletter: 'yes',
    },
    annotation: { expect: 'valid', emails: ['nina.park@example.com'] },
  },
  {
    cells: {
      Name: 'Leo Morales',
      Email: 'leo.morales@example.org',
      'Submission time': 'June 28, 2025 2:15 PM',
      Newsletter: 'no',
    },
    annotation: { expect: 'valid', emails: ['leo.morales@example.org'] },
  },
  {
    cells: {
      Name: 'Taro Suzuki',
      Email: 'taro.suzuki@example.jp',
      'Submission time': 'Jun 29, 2025 12:05 AM',
      Newsletter: 'yes',
    },
    annotation: { expect: 'valid', emails: ['taro.suzuki@example.jp'] },
  },
  {
    cells: {
      Name: 'Hana Fujimoto',
      Email: 'hana.fujimoto@example.jp',
      'Submission time': 'Jul 1, 2025 12:30 PM',
      Newsletter: '',
    },
    annotation: { expect: 'valid', emails: ['hana.fujimoto@example.jp'] },
  },
  {
    cells: {
      Name: 'Omar Hassan',
      Email: 'omar.hassan@example.net',
      'Submission time': 'June 30, 2025',
      Newsletter: 'yes',
    },
    annotation: { expect: 'valid', emails: ['omar.hassan@example.net'] },
  },
];

export const FIXTURE_SOURCES: FixtureSourceSpec[] = [
  // 1. shop-alpha: two CP932 CSVs with Japanese headers, consent change, CP932-only chars
  {
    source: 'shop-alpha',
    kind: 'product',
    label: 'Shop Alpha Members',
    consent_basis: 'opt_in',
    exported_at: '2025-09-01',
    columns: {
      email: 'メールアドレス',
      name: '氏名',
      created_at: '登録日',
      consent: 'メルマガ配信',
    },
    notes: [
      'Synthetic CP932 CSV exports from a fictional online shop (two dated snapshots).',
      'Covers CP932-only characters (①, ㈱, 髙), consent changes across exports, in-file conflicting consent, full-width address, multi-address split, legacy mobile dots, role address, and typos.',
    ],
    files: [
      {
        name: 'members_2025-03-01.csv',
        kind: 'csv',
        physicalEncoding: 'cp932',
        metaFile: {
          name: 'members_2025-03-01.csv',
          encoding: 'cp932',
          header_row: 1,
        },
        headers: ['会員ID', 'メールアドレス', '氏名', '登録日', 'メルマガ配信'],
        rows: [
          {
            cells: {
              会員ID: 'SA001',
              メールアドレス: 'taro.suzuki@example.jp',
              氏名: '鈴木 太郎',
              登録日: '2025/01/10',
              メルマガ配信: '配信する',
            },
            annotation: { expect: 'valid', emails: ['taro.suzuki@example.jp'] },
          },
          {
            cells: {
              会員ID: 'SA002',
              メールアドレス: 'yuki.takahashi@example.jp',
              氏名: '髙橋 由紀',
              登録日: '2025/01/15',
              メルマガ配信: '配信しない',
            },
            annotation: { expect: 'valid', emails: ['yuki.takahashi@example.jp'] },
          },
          {
            cells: {
              会員ID: 'SA003',
              メールアドレス: 'hanako.sato@example.com',
              氏名: '佐藤 花子',
              登録日: '2025/02/01',
              メルマガ配信: '配信する',
            },
            annotation: { expect: 'valid', emails: ['hanako.sato@example.com'] },
          },
          {
            cells: {
              会員ID: 'SA004',
              メールアドレス: 'naoki.saito@example.jp',
              氏名: '斉藤 直樹',
              登録日: '2025/02/05',
              メルマガ配信: '配信する',
            },
            annotation: { expect: 'valid', emails: ['naoki.saito@example.jp'] },
          },
          {
            cells: {
              会員ID: 'SA005',
              メールアドレス: 'taro..yamada.@example.jp',
              氏名: '山田 太郎',
              登録日: '2025/02/10',
              メルマガ配信: '配信する',
            },
            annotation: { expect: 'legacy', emails: ['taro..yamada.@example.jp'] },
          },
          {
            cells: {
              会員ID: 'SA006',
              メールアドレス: 'info@example.com',
              氏名: '㈱アルファ ①号店',
              登録日: '2025/02/14',
              メルマガ配信: '',
            },
            annotation: { expect: 'role', emails: ['info@example.com'] },
          },
          {
            cells: {
              会員ID: 'SA007',
              メールアドレス: 'hiroshi.tanaka@example.con',
              氏名: '田中 博',
              登録日: '2025/02/20',
              メルマガ配信: '配信する',
            },
            annotation: {
              expect: 'typo',
              emails: ['hiroshi.tanaka@example.con'],
              suggestion: 'hiroshi.tanaka@example.com',
            },
          },
          {
            cells: {
              会員ID: 'SA008',
              メールアドレス: '',
              氏名: '空メール 顧客',
              登録日: '2025/02/22',
              メルマガ配信: '配信する',
            },
            annotation: { expect: 'empty', emails: [] },
          },
          {
            cells: {
              会員ID: 'SA009',
              メールアドレス: 'not-an-email',
              氏名: '無効 顧客',
              登録日: '2025/02/25',
              メルマガ配信: '配信しない',
            },
            annotation: { expect: 'invalid', emails: [] },
          },
          {
            cells: {
              会員ID: 'SA010',
              メールアドレス: 'aki.morita@example.jp',
              氏名: '森田 亜紀',
              登録日: '2025/02/28',
              メルマガ配信: '配信する',
            },
            annotation: { expect: 'valid', emails: ['aki.morita@example.jp'] },
          },
        ],
      },
      {
        name: 'members_2025-09-01.csv',
        kind: 'csv',
        physicalEncoding: 'cp932',
        metaFile: {
          name: 'members_2025-09-01.csv',
          encoding: 'cp932',
          header_row: 1,
        },
        headers: ['会員ID', 'メールアドレス', '氏名', '登録日', 'メルマガ配信'],
        rows: [
          {
            cells: {
              会員ID: 'SA001',
              メールアドレス: 'ｔａｒｏ．ｓｕｚｕｋｉ＠ｅｘａｍｐｌｅ．ｊｐ',
              氏名: '鈴木 太郎',
              登録日: '2025/01/10',
              メルマガ配信: '配信しない',
            },
            annotation: { expect: 'valid', emails: ['taro.suzuki@example.jp'] },
          },
          {
            cells: {
              会員ID: 'SA002',
              メールアドレス: 'yuki.takahashi@example.jp',
              氏名: '髙橋 由紀',
              登録日: '2025/01/15',
              メルマガ配信: '配信する',
            },
            annotation: { expect: 'valid', emails: ['yuki.takahashi@example.jp'] },
          },
          {
            cells: {
              会員ID: 'SA011',
              メールアドレス: 'kenji.ito@example.jp',
              氏名: '伊藤 健二',
              登録日: '2025/05/01',
              メルマガ配信: '配信する',
            },
            annotation: { expect: 'valid', emails: ['kenji.ito@example.jp'] },
          },
          {
            cells: {
              会員ID: 'SA012',
              メールアドレス: 'KENJI.ITO@EXAMPLE.JP',
              氏名: '伊藤 健二',
              登録日: '2025/06/01',
              メルマガ配信: '配信しない',
            },
            annotation: { expect: 'valid', emails: ['kenji.ito@example.jp'] },
          },
          {
            cells: {
              会員ID: 'SA013',
              メールアドレス: 'haruka.ito@example.com; daiki.ono@example.com、mio.fujita@example.com',
              氏名: '伊藤 遥',
              登録日: '2025/07/01',
              メルマガ配信: '配信する',
            },
            annotation: {
              expect: 'split:3',
              emails: [
                'haruka.ito@example.com',
                'daiki.ono@example.com',
                'mio.fujita@example.com',
              ],
            },
          },
          {
            cells: {
              会員ID: 'SA014',
              メールアドレス: 'yuta.kobayashi@example.con',
              氏名: '小林 雄太',
              登録日: '2025/08/15',
              メルマガ配信: '配信する',
            },
            annotation: {
              expect: 'typo',
              emails: ['yuta.kobayashi@example.con'],
              suggestion: 'yuta.kobayashi@example.com',
            },
          },
          {
            cells: {
              会員ID: 'SA015',
              メールアドレス: 'ren.nakamura@example.jp',
              氏名: '中村 蓮 ①',
              登録日: '2025/08/20',
              メルマガ配信: '',
            },
            annotation: { expect: 'valid', emails: ['ren.nakamura@example.jp'] },
          },
        ],
      },
    ],
  },

  // 2. cn-delta: GB18030 CSV with Chinese headers and 4-byte character 𠀀 (U+20000)
  {
    source: 'cn-delta',
    kind: 'other',
    label: 'CN Delta Users',
    consent_basis: 'unknown',
    exported_at: '2024-12-31',
    columns: {
      email: '邮箱',
      name: '姓名',
      created_at: '注册时间',
      consent: '订阅',
    },
    notes: [
      'Synthetic GB18030 CSV export with Chinese headers and a 4-byte GB18030 character (U+20000).',
      'Covers rejected typo override, Gmail no-dot variant, in-file duplicate with mixed case, double-@ invalid syntax, and whitespace-only empty cell.',
    ],
    files: [
      {
        name: 'users_2024-12-31.csv',
        kind: 'csv',
        physicalEncoding: 'gb18030',
        metaFile: {
          name: 'users_2024-12-31.csv',
          encoding: 'gb18030',
          header_row: 1,
        },
        headers: ['邮箱', '姓名', '注册时间', '订阅'],
        rows: [
          {
            cells: {
              邮箱: 'mei.lin@example.com',
              姓名: '林梅',
              注册时间: '2024-06-15',
              订阅: '是',
            },
            annotation: { expect: 'valid', emails: ['mei.lin@example.com'] },
          },
          {
            cells: {
              邮箱: 'wei.zhang@example.net',
              姓名: '张\u{20000}伟',
              注册时间: '2024-08-20',
              订阅: '否',
            },
            annotation: { expect: 'valid', emails: ['wei.zhang@example.net'] },
          },
          {
            cells: {
              邮箱: 'hanakosato@example.com',
              姓名: '佐藤花子',
              注册时间: '2024-09-10',
              订阅: '是',
            },
            annotation: { expect: 'valid', emails: ['hanakosato@example.com'] },
          },
          {
            cells: {
              邮箱: 'saki.watanabe@example.co.jo',
              姓名: '渡边早纪',
              注册时间: '2024-10-05',
              订阅: '是',
            },
            annotation: {
              expect: 'typo',
              emails: ['saki.watanabe@example.co.jo'],
              suggestion: 'saki.watanabe@example.co.jp',
            },
          },
          {
            cells: {
              邮箱: 'chen.li@example.org',
              姓名: '李晨',
              注册时间: '2024-11-01',
              订阅: '',
            },
            annotation: { expect: 'valid', emails: ['chen.li@example.org'] },
          },
          {
            cells: {
              邮箱: '  Chen.Li@Example.ORG  ',
              姓名: '李晨',
              注册时间: '2024-11-12',
              订阅: '是',
            },
            annotation: { expect: 'valid', emails: ['chen.li@example.org'] },
          },
          {
            cells: {
              邮箱: 'double@@example.com',
              姓名: '无效测试',
              注册时间: '2024-12-01',
              订阅: '否',
            },
            annotation: { expect: 'invalid', emails: [] },
          },
          {
            cells: {
              邮箱: '   ',
              姓名: '空白邮箱',
              注册时间: '2024-12-15',
              订阅: '',
            },
            annotation: { expect: 'empty', emails: [] },
          },
        ],
      },
    ],
  },

  // 3. export-epsilon: UTF-16LE with BOM TSV, encoding: auto, no columns
  {
    source: 'export-epsilon',
    kind: 'other',
    label: 'Export Epsilon Contacts',
    consent_basis: 'unknown',
    exported_at: '2025-06-30',
    notes: [
      'Synthetic Excel "Unicode text" (UTF-16LE with BOM, tab-separated) export.',
      'Declares encoding: auto and omits columns so BOM detection and header auto-detection are exercised.',
    ],
    files: [
      {
        name: 'contacts_2025-06-30.txt',
        kind: 'tsv',
        physicalEncoding: 'utf-16le-bom',
        metaFile: {
          name: 'contacts_2025-06-30.txt',
          encoding: 'auto',
          header_row: 1,
        },
        headers: ['Email Address', 'Full Name', 'Created'],
        rows: [
          {
            cells: {
              'Email Address': '<TARO.SUZUKI@EXAMPLE.JP>',
              'Full Name': 'Taro Suzuki',
              Created: '2025-03-15',
            },
            annotation: { expect: 'valid', emails: ['taro.suzuki@example.jp'] },
          },
          {
            cells: {
              'Email Address': 'yumi.kato@example.net',
              'Full Name': 'Yumi Kato',
              Created: '2025-04-01',
            },
            annotation: { expect: 'valid', emails: ['yumi.kato@example.net'] },
          },
          {
            cells: {
              'Email Address': 'noreply@example.org',
              'Full Name': 'System Mailer',
              Created: '2025-04-10',
            },
            annotation: { expect: 'role', emails: ['noreply@example.org'] },
          },
          {
            cells: {
              'Email Address': 'hanako.sato+news@example.com',
              'Full Name': 'Hanako Sato',
              Created: '2025-05-01',
            },
            annotation: { expect: 'valid', emails: ['hanako.sato+news@example.com'] },
          },
          {
            cells: {
              'Email Address': 'riko.hayashi@example.co.jo',
              'Full Name': 'Riko Hayashi',
              Created: '2025-06-01',
            },
            annotation: {
              expect: 'typo',
              emails: ['riko.hayashi@example.co.jo'],
              suggestion: 'riko.hayashi@example.co.jp',
            },
          },
          {
            cells: {
              'Email Address': 'missing-tld@example',
              'Full Name': 'Bad Domain',
              Created: '2025-06-15',
            },
            annotation: { expect: 'invalid', emails: [] },
          },
        ],
      },
    ],
  },

  // 4. zeta-signup: UTF-8 with BOM CSV + JSON array, empty columns: {}
  {
    source: 'zeta-signup',
    kind: 'event',
    label: 'Zeta Signup',
    consent_basis: 'transactional',
    exported_at: '2025-01-15',
    columns: {},
    notes: [
      'Synthetic event signup export combining a UTF-8-with-BOM CSV and a JSON array.',
      'Leaves columns empty for auto-detection; includes zero-width space, QA test account for exclude.yaml, mixed case, mailto: prefix, and missing-local invalid syntax.',
    ],
    files: [
      {
        name: 'signup_2025-01-15.csv',
        kind: 'csv',
        physicalEncoding: 'utf-8-sig',
        metaFile: {
          name: 'signup_2025-01-15.csv',
          encoding: 'utf-8-sig',
          header_row: 1,
        },
        headers: ['E-mail', 'Display Name', 'Signed Up At', 'Newsletter'],
        rows: [
          {
            cells: {
              'E-mail': 'mei\u200B.lin@example.com',
              'Display Name': 'Mei Lin',
              'Signed Up At': '2025-01-10',
              Newsletter: 'yes',
            },
            annotation: { expect: 'valid', emails: ['mei.lin@example.com'] },
          },
          {
            cells: {
              'E-mail': 'qa-test@example.com',
              'Display Name': 'QA Tester',
              'Signed Up At': '2025-01-11',
              Newsletter: 'yes',
            },
            annotation: { expect: 'excluded', emails: ['qa-test@example.com'] },
          },
          {
            cells: {
              'E-mail': 'Alice.Wong@Example.COM',
              'Display Name': 'Alice Wong',
              'Signed Up At': '2025-01-12',
              Newsletter: 'no',
            },
            annotation: { expect: 'valid', emails: ['alice.wong@example.com'] },
          },
          {
            cells: {
              'E-mail': 'kenta.mori@example.net',
              'Display Name': 'Kenta Mori',
              'Signed Up At': '2025-01-13',
              Newsletter: '',
            },
            annotation: { expect: 'valid', emails: ['kenta.mori@example.net'] },
          },
          {
            cells: {
              'E-mail': '@example.com',
              'Display Name': 'Missing Local',
              'Signed Up At': '2025-01-14',
              Newsletter: 'no',
            },
            annotation: { expect: 'invalid', emails: [] },
          },
          {
            cells: {
              'E-mail': '',
              'Display Name': 'Blank Row',
              'Signed Up At': '2025-01-15',
              Newsletter: '',
            },
            annotation: { expect: 'empty', emails: [] },
          },
        ],
      },
      {
        name: 'extra_2025-01-15.json',
        kind: 'json',
        physicalEncoding: 'utf-8',
        metaFile: {
          name: 'extra_2025-01-15.json',
          encoding: 'utf-8',
        },
        headers: ['mail', 'name'],
        rows: [
          {
            cells: {
              mail: 'sora.kimura@example.jp',
              name: 'Sora Kimura',
            },
            annotation: { expect: 'valid', emails: ['sora.kimura@example.jp'] },
          },
          {
            cells: {
              mail: 'wei.zhang@example.net',
              name: 'Wei Zhang',
            },
            annotation: { expect: 'valid', emails: ['wei.zhang@example.net'] },
          },
          {
            cells: {
              mail: 'mailto:aiko.noda@example.org',
              name: 'Aiko Noda',
            },
            annotation: { expect: 'valid', emails: ['aiko.noda@example.org'] },
          },
        ],
      },
    ],
  },

  // 5. event-beta: XLSX (sheet attendees) + UTF-8 CSV with header_row: 3
  {
    source: 'event-beta',
    kind: 'event',
    label: 'Event Beta Attendees',
    consent_basis: 'unknown',
    exported_at: '2023-11-03',
    columns: {
      email: 'Email',
      name: 'Name',
      created_at: 'Registered',
      locale: 'Locale',
    },
    notes: [
      'Synthetic event export with an Excel workbook (sheet `attendees`) and a walk-in CSV with two title lines before the header (header_row: 3).',
      'Covers Name <addr>, in-file duplicate in xlsx, numeric-TLD invalid syntax, and support@ role address.',
    ],
    files: [
      {
        name: 'attendees_2023-11-03.xlsx',
        kind: 'xlsx',
        physicalEncoding: null,
        sheet: 'attendees',
        metaFile: {
          name: 'attendees_2023-11-03.xlsx',
          encoding: 'auto',
          sheet: 'attendees',
          header_row: 1,
        },
        headers: ['Email', 'Name', 'Registered', 'Locale'],
        rows: [
          {
            cells: {
              Email: 'Taro Suzuki <Taro.Suzuki@Example.JP>',
              Name: 'Taro Suzuki',
              Registered: '2023-11-01',
              Locale: 'ja',
            },
            annotation: { expect: 'valid', emails: ['taro.suzuki@example.jp'] },
          },
          {
            cells: {
              Email: 'alice.wong@example.com',
              Name: 'Alice Wong',
              Registered: '2023-11-02',
              Locale: 'en',
            },
            annotation: { expect: 'valid', emails: ['alice.wong@example.com'] },
          },
          {
            cells: {
              Email: 'emily.chen@example.org',
              Name: 'Emily Chen',
              Registered: '2023-11-02',
              Locale: 'en',
            },
            annotation: { expect: 'valid', emails: ['emily.chen@example.org'] },
          },
          {
            cells: {
              Email: 'emily.chen@example.org',
              Name: 'Emily Chen',
              Registered: '2023-11-03',
              Locale: 'en',
            },
            annotation: { expect: 'valid', emails: ['emily.chen@example.org'] },
          },
          {
            cells: {
              Email: 'bad@example.123',
              Name: 'Invalid TLD',
              Registered: '2023-11-03',
              Locale: 'en',
            },
            annotation: { expect: 'invalid', emails: [] },
          },
        ],
      },
      {
        name: 'walkin_2023-11-03.csv',
        kind: 'csv',
        physicalEncoding: 'utf-8',
        preambleLines: ['Event Beta Walk-in List', 'Exported 2023-11-03'],
        metaFile: {
          name: 'walkin_2023-11-03.csv',
          encoding: 'utf-8',
          header_row: 3,
        },
        headers: ['Email', 'Name', 'Registered', 'Locale'],
        rows: [
          {
            cells: {
              Email: 'daiki.walkin@example.jp',
              Name: 'Daiki Walkin',
              Registered: '2023-11-03',
              Locale: 'ja',
            },
            annotation: { expect: 'valid', emails: ['daiki.walkin@example.jp'] },
          },
          {
            cells: {
              Email: 'hanako.sato@example.com',
              Name: 'Hanako Sato',
              Registered: '2023-11-03',
              Locale: 'ja',
            },
            annotation: { expect: 'valid', emails: ['hanako.sato@example.com'] },
          },
          {
            cells: {
              Email: 'support@example.net',
              Name: 'Support Desk',
              Registered: '2023-11-03',
              Locale: 'en',
            },
            annotation: { expect: 'role', emails: ['support@example.net'] },
          },
        ],
      },
    ],
  },

  // 6. app-gamma: SQLite database with users table and explicit consent_values
  {
    source: 'app-gamma',
    kind: 'product',
    label: 'App Gamma Users',
    consent_basis: 'opt_in',
    exported_at: '2025-08-01',
    columns: {
      email: 'email',
      name: 'display_name',
      created_at: 'created_at',
      consent: 'newsletter',
      locale: 'locale',
    },
    consent_values: {
      granted: ['1'],
      denied: ['0'],
    },
    notes: [
      'Synthetic SQLite export with table `users` and integer newsletter flags (1, 0, NULL).',
      'Covers mailto:, mixed case, full-width ＠, NULL email cell, and cross-source match with accepted typo from shop-alpha.',
    ],
    files: [
      {
        name: 'app_2025-08-01.db',
        kind: 'sqlite',
        physicalEncoding: null,
        table: 'users',
        metaFile: {
          name: 'app_2025-08-01.db',
          encoding: 'auto',
          table: 'users',
        },
        headers: ['id', 'email', 'display_name', 'created_at', 'newsletter', 'locale'],
        rows: [
          {
            cells: {
              id: 1,
              email: 'mailto:taro.suzuki@example.jp',
              display_name: 'Taro S.',
              created_at: '2025-04-01',
              newsletter: 1,
              locale: 'ja',
            },
            annotation: { expect: 'valid', emails: ['taro.suzuki@example.jp'] },
          },
          {
            cells: {
              id: 2,
              email: 'Mei.Lin@example.com',
              display_name: 'Mei L.',
              created_at: '2025-04-15',
              newsletter: 1,
              locale: 'zh',
            },
            annotation: { expect: 'valid', emails: ['mei.lin@example.com'] },
          },
          {
            cells: {
              id: 3,
              email: 'hiroshi.tanaka@example.com',
              display_name: 'Hiroshi Tanaka',
              created_at: '2025-05-10',
              newsletter: 0,
              locale: 'ja',
            },
            annotation: { expect: 'valid', emails: ['hiroshi.tanaka@example.com'] },
          },
          {
            cells: {
              id: 4,
              email: 'lucas.martin@example.org',
              display_name: 'Lucas Martin',
              created_at: '2025-06-20',
              newsletter: null,
              locale: 'en',
            },
            annotation: { expect: 'valid', emails: ['lucas.martin@example.org'] },
          },
          {
            cells: {
              id: 5,
              email: null,
              display_name: 'No Email User',
              created_at: '2025-07-01',
              newsletter: 1,
              locale: 'en',
            },
            annotation: { expect: 'empty', emails: [] },
          },
          {
            cells: {
              id: 6,
              email: 'kenji＠example.jp',
              display_name: 'Kenji Fullwidth',
              created_at: '2025-07-15',
              newsletter: 1,
              locale: 'ja',
            },
            annotation: { expect: 'valid', emails: ['kenji@example.jp'] },
          },
        ],
      },
    ],
  },

  // 7. form-eta (Addendum 2026-11-26): Notion-style form export with month-name dates,
  // duplicate CSV with reordered columns (omitted from meta.md), and pages/ .md files.
  {
    source: 'form-eta',
    kind: 'event',
    label: 'Form Eta Responses',
    consent_basis: 'unknown',
    exported_at: '2025-07-01',
    columns: {},
    notes: [
      'Synthetic Notion-style form export with English month-name timestamps (full and abbreviated, AM/PM, date-only).',
      'The duplicate file `responses_2025-07-01 (1).csv` has identical rows with reordered columns and is excluded from `files:`.',
      'Subdirectory `pages/` contains Notion markdown exports that are ignored by the pipeline.',
    ],
    files: [
      {
        name: 'responses_2025-07-01.csv',
        kind: 'csv',
        physicalEncoding: 'utf-8-sig',
        metaFile: {
          name: 'responses_2025-07-01.csv',
          encoding: 'utf-8-sig',
          header_row: 1,
        },
        headers: ['Name', 'Email', 'Submission time', 'Newsletter'],
        rows: FORM_ETA_ROWS,
      },
      {
        name: 'responses_2025-07-01 (1).csv',
        kind: 'csv',
        physicalEncoding: 'utf-8-sig',
        metaFile: null, // suspected duplicate: intentionally omitted from meta.md
        headers: ['Email', 'Submission time', 'Name', 'Newsletter'],
        rows: FORM_ETA_ROWS,
      },
    ],
    extraFiles: [
      {
        relativePath: 'pages/welcome-note.md',
        content: '# Form Eta Welcome Note\n\nSynthetic Notion page export for testing subdirectory ignoring (R9).\n',
      },
      {
        relativePath: 'pages/schedule.md',
        content: '# Event Schedule\n\n- 10:00 Registration\n- 11:00 Opening remarks\n',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Text encoders (verified round-trip via TextDecoder(..., { fatal: true }))
// ---------------------------------------------------------------------------

let cp932Table: Map<string, Uint8Array> | null = null;
let gb18030Table: Map<string, Uint8Array> | null = null;

function getCp932Table(): Map<string, Uint8Array> {
  if (cp932Table !== null) return cp932Table;
  const dec = new TextDecoder('shift_jis', { fatal: true });
  const map = new Map<string, Uint8Array>();

  for (let b = 0x00; b <= 0x7f; b++) {
    map.set(String.fromCharCode(b), Uint8Array.of(b));
  }
  for (let b = 0xa1; b <= 0xdf; b++) {
    try {
      const ch = dec.decode(Uint8Array.of(b));
      if (!map.has(ch)) map.set(ch, Uint8Array.of(b));
    } catch {
      // unassigned
    }
  }
  for (let b1 = 0x81; b1 <= 0xfc; b1++) {
    if (b1 >= 0xa0 && b1 <= 0xdf) continue;
    for (let b2 = 0x40; b2 <= 0xfc; b2++) {
      if (b2 === 0x7f) continue;
      const bytes = Uint8Array.of(b1, b2);
      try {
        const ch = dec.decode(bytes);
        if (!map.has(ch)) map.set(ch, bytes);
      } catch {
        // unassigned
      }
    }
  }

  cp932Table = map;
  return map;
}

function getGb18030Table(): Map<string, Uint8Array> {
  if (gb18030Table !== null) return gb18030Table;
  const dec = new TextDecoder('gb18030', { fatal: true });
  const map = new Map<string, Uint8Array>();

  for (let b = 0x00; b <= 0x7f; b++) {
    map.set(String.fromCharCode(b), Uint8Array.of(b));
  }
  for (let b1 = 0x81; b1 <= 0xfe; b1++) {
    for (let b2 = 0x40; b2 <= 0xfe; b2++) {
      if (b2 === 0x7f) continue;
      const bytes = Uint8Array.of(b1, b2);
      try {
        const ch = dec.decode(bytes);
        if (!map.has(ch)) map.set(ch, bytes);
      } catch {
        // unassigned
      }
    }
  }
  // Explicit 4-byte GB18030 sequence for U+20000 (𠀀).
  map.set('\u{20000}', Uint8Array.of(0x95, 0x32, 0x82, 0x36));

  gb18030Table = map;
  return map;
}

function encodeWithTable(text: string, table: Map<string, Uint8Array>, label: string): Buffer {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const ch of text) {
    const bytes = table.get(ch);
    if (bytes === undefined) {
      throw new Error(`Character U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase()} cannot be encoded in ${label}`);
    }
    chunks.push(bytes);
    total += bytes.length;
  }
  const out = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function encodeText(
  text: string,
  encoding: NonNullable<FixtureFileSpec['physicalEncoding']>,
): Buffer {
  let bytes: Buffer;
  let decoderLabel: string;

  switch (encoding) {
    case 'utf-8':
      bytes = Buffer.from(text, 'utf8');
      decoderLabel = 'utf-8';
      break;
    case 'utf-8-sig':
      bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
      decoderLabel = 'utf-8';
      break;
    case 'utf-16le-bom':
      bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
      decoderLabel = 'utf-16le';
      break;
    case 'cp932':
      bytes = encodeWithTable(text, getCp932Table(), 'cp932');
      decoderLabel = 'shift_jis';
      break;
    case 'gb18030':
      bytes = encodeWithTable(text, getGb18030Table(), 'gb18030');
      decoderLabel = 'gb18030';
      break;
  }

  const decoded = new TextDecoder(decoderLabel, { fatal: true }).decode(bytes);
  if (decoded !== text) {
    throw new Error(`Round-trip verification failed for encoding ${encoding}`);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// File serializers
// ---------------------------------------------------------------------------

function formatCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replaceAll('"', '""')}"`;
  }
  return str;
}

function serializeCsv(file: FixtureFileSpec): string {
  const lines: string[] = [];
  if (file.preambleLines) {
    lines.push(...file.preambleLines);
  }
  lines.push(file.headers.map(formatCsvCell).join(','));
  for (const row of file.rows) {
    lines.push(file.headers.map((h) => formatCsvCell(row.cells[h])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function serializeTsv(file: FixtureFileSpec): string {
  const lines: string[] = [];
  lines.push(file.headers.join('\t'));
  for (const row of file.rows) {
    const vals = file.headers.map((h) => {
      const v = row.cells[h];
      const str = v === null || v === undefined ? '' : String(v);
      if (/[\t\r\n]/.test(str)) {
        throw new Error(`TSV cell in ${file.name} cannot contain tab or newline`);
      }
      return str;
    });
    lines.push(vals.join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

function serializeJson(file: FixtureFileSpec): string {
  const records = file.rows.map((row) => {
    const obj: Record<string, string | number | null> = {};
    for (const h of file.headers) {
      obj[h] = row.cells[h] ?? null;
    }
    return obj;
  });
  return `${JSON.stringify(records, null, 2)}\n`;
}

function sqlLiteral(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

async function writeXlsx(outPath: string, file: FixtureFileSpec): Promise<void> {
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  const sheet = file.sheet ?? 'Sheet1';
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  try {
    try {
      await conn.run('LOAD excel;');
    } catch {
      await conn.run('INSTALL excel; LOAD excel;');
    }
    const colsSql = file.headers.map((h) => `${sqlIdent(h)} VARCHAR`).join(', ');
    await conn.run(`CREATE TABLE fixture_sheet (${colsSql});`);
    for (const row of file.rows) {
      const valsSql = file.headers
        .map((h) => {
          const v = row.cells[h];
          return v === null || v === undefined ? 'NULL' : sqlLiteral(String(v));
        })
        .join(', ');
      await conn.run(`INSERT INTO fixture_sheet VALUES (${valsSql});`);
    }
    await conn.run(
      `COPY fixture_sheet TO ${sqlLiteral(outPath)} (FORMAT xlsx, HEADER true, SHEET ${sqlLiteral(sheet)});`,
    );
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}

function writeSqlite(outPath: string, file: FixtureFileSpec): void {
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  const table = file.table ?? 'users';
  const db = new DatabaseSync(outPath);
  try {
    db.exec(
      `CREATE TABLE ${sqlIdent(table)} (id INTEGER PRIMARY KEY, email TEXT, display_name TEXT, created_at TEXT, newsletter INTEGER, locale TEXT);`,
    );
    const colsSql = file.headers.map(sqlIdent).join(', ');
    const placeholders = file.headers.map(() => '?').join(', ');
    const stmt = db.prepare(`INSERT INTO ${sqlIdent(table)} (${colsSql}) VALUES (${placeholders});`);
    for (const row of file.rows) {
      const values = file.headers.map((h) => row.cells[h] ?? null);
      stmt.run(...values);
    }
  } finally {
    db.close();
  }
}

function renderMetaMd(spec: FixtureSourceSpec): string {
  const frontmatter: Record<string, unknown> = {
    source: spec.source,
    kind: spec.kind,
    label: spec.label,
    files: spec.files
      .map((f) => f.metaFile)
      .filter((mf): mf is MetaFile => mf !== null),
  };
  if (spec.columns !== undefined) {
    frontmatter.columns = spec.columns;
  }
  if (spec.consent_values !== undefined) {
    frontmatter.consent_values = spec.consent_values;
  }
  frontmatter.consent_basis = spec.consent_basis;
  frontmatter.exported_at = spec.exported_at;

  const yamlText = stringifyYaml(frontmatter, { lineWidth: 100 }).trimEnd();
  const notesBody = spec.notes.map((line) => `- ${line}`).join('\n');
  return `---\n${yamlText}\n---\n\n## Notes\n\n${notesBody}\n`;
}

// ---------------------------------------------------------------------------
// Expected counts computation (strictly from annotations + overrides)
// ---------------------------------------------------------------------------

export function computeExpected(
  sources: readonly FixtureSourceSpec[],
  overrides: Overrides,
): ExpectedJson {
  const excludeEmails = new Set(
    overrides.exclude
      .map((e) => e.email?.toLowerCase())
      .filter((e): e is string => typeof e === 'string' && e.length > 0),
  );
  const typoDecisions = new Map(
    overrides.typo.map((t) => [t.email.toLowerCase(), t]),
  );

  const sourcesResult: ExpectedJson['sources'] = {};
  const emailToSources = new Map<string, Set<string>>();
  let excludedCount = 0;
  let typoAcceptedCount = 0;

  for (const src of sources) {
    const fileCounts: Record<string, ExpectedFileCounts> = {};
    const sourceUnique = new Set<string>();

    for (const file of src.files) {
      // Only files listed in meta.md are staged and counted (R9).
      if (file.metaFile === null) continue;

      const counts: ExpectedFileCounts = {
        rows_read: file.rows.length,
        empty: 0,
        invalid: 0,
        cells_split: 0,
        dup_in_file: 0,
        role: 0,
        typo_suspect: 0,
      };
      const seenInFile = new Set<string>();

      for (const row of file.rows) {
        const { expect, emails, suggestion } = row.annotation;
        if (expect === 'empty') {
          counts.empty += 1;
          continue;
        }
        if (expect === 'invalid') {
          counts.invalid += 1;
          continue;
        }
        if (expect === 'split:3') {
          counts.cells_split += 1;
        }

        for (const normalized of emails) {
          const lower = normalized.toLowerCase();
          if (excludeEmails.has(lower)) {
            excludedCount += 1;
            continue;
          }

          let finalEmail = lower;
          let isTypoSuspect = expect === 'typo';

          const decision = typoDecisions.get(lower);
          if (decision?.action === 'accept') {
            finalEmail = (decision.suggested ?? suggestion ?? lower).toLowerCase();
            isTypoSuspect = false;
            typoAcceptedCount += 1;
          } else if (decision?.action === 'reject') {
            isTypoSuspect = false;
          }

          if (seenInFile.has(finalEmail)) {
            counts.dup_in_file += 1;
          } else {
            seenInFile.add(finalEmail);
          }

          if (isTypoSuspect) {
            counts.typo_suspect += 1;
          } else if (expect === 'role') {
            counts.role += 1;
          }

          sourceUnique.add(finalEmail);
          let set = emailToSources.get(finalEmail);
          if (set === undefined) {
            set = new Set<string>();
            emailToSources.set(finalEmail, set);
          }
          set.add(src.source);
        }
      }

      fileCounts[file.name] = counts;
    }

    sourcesResult[src.source] = {
      files: fileCounts,
      unique_emails: sourceUnique.size,
    };
  }

  let crossSourceDups = 0;
  for (const srcSet of emailToSources.values()) {
    if (srcSet.size >= 2) crossSourceDups += 1;
  }

  const sortedSourceNames = sources.map((s) => s.source).sort();
  const overlap: Array<{ a: string; b: string; contacts: number }> = [];
  for (let i = 0; i < sortedSourceNames.length; i++) {
    const a = sortedSourceNames[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < sortedSourceNames.length; j++) {
      const b = sortedSourceNames[j];
      if (b === undefined) continue;
      let contacts = 0;
      for (const srcSet of emailToSources.values()) {
        if (srcSet.has(a) && srcSet.has(b)) contacts += 1;
      }
      if (contacts > 0) {
        overlap.push({ a, b, contacts });
      }
    }
  }

  return {
    sources: sourcesResult,
    after_overrides: {
      excluded: excludedCount,
      typo_accepted: typoAcceptedCount,
    },
    cross_source_dups: crossSourceDups,
    contacts_total: emailToSources.size,
    overlap,
  };
}

// ---------------------------------------------------------------------------
// Generator entrypoint
// ---------------------------------------------------------------------------

export function fixturesRootDir(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(thisDir, '..', 'fixtures');
}

export async function generateFixtures(outRoot = fixturesRootDir()): Promise<ExpectedJson> {
  const sourcesDir = path.join(outRoot, 'sources');
  const overridesDir = path.join(outRoot, 'overrides');

  fs.rmSync(sourcesDir, { recursive: true, force: true });
  fs.rmSync(overridesDir, { recursive: true, force: true });
  fs.mkdirSync(sourcesDir, { recursive: true });
  fs.mkdirSync(overridesDir, { recursive: true });

  // Write sources
  for (const spec of FIXTURE_SOURCES) {
    const dir = path.join(sourcesDir, spec.source);
    fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(path.join(dir, 'meta.md'), encodeText(renderMetaMd(spec), 'utf-8'));

    for (const file of spec.files) {
      const filePath = path.join(dir, file.name);
      if (file.kind === 'csv') {
        if (file.physicalEncoding === null) {
          throw new Error(`CSV file ${file.name} requires a physicalEncoding`);
        }
        fs.writeFileSync(filePath, encodeText(serializeCsv(file), file.physicalEncoding));
      } else if (file.kind === 'tsv') {
        if (file.physicalEncoding === null) {
          throw new Error(`TSV file ${file.name} requires a physicalEncoding`);
        }
        fs.writeFileSync(filePath, encodeText(serializeTsv(file), file.physicalEncoding));
      } else if (file.kind === 'json') {
        fs.writeFileSync(filePath, encodeText(serializeJson(file), file.physicalEncoding ?? 'utf-8'));
      } else if (file.kind === 'xlsx') {
        await writeXlsx(filePath, file);
      } else if (file.kind === 'sqlite') {
        writeSqlite(filePath, file);
      }
    }

    if (spec.extraFiles) {
      for (const extra of spec.extraFiles) {
        const extraPath = path.join(dir, extra.relativePath);
        fs.mkdirSync(path.dirname(extraPath), { recursive: true });
        fs.writeFileSync(extraPath, encodeText(extra.content, 'utf-8'));
      }
    }
  }

  // Write overrides/*.yaml (top-level YAML lists matching Overrides in scripts/lib/types.ts)
  const overrideFiles: Array<[string, unknown[]]> = [
    ['exclude.yaml', FIXTURE_OVERRIDES.exclude],
    ['typo-decisions.yaml', FIXTURE_OVERRIDES.typo],
    ['suppressions.yaml', FIXTURE_OVERRIDES.suppressions],
    ['consents.yaml', FIXTURE_OVERRIDES.consents],
  ];
  for (const [name, list] of overrideFiles) {
    const yamlText = list.length === 0 ? '[]\n' : stringifyYaml(list, { lineWidth: 100 });
    fs.writeFileSync(path.join(overridesDir, name), encodeText(yamlText, 'utf-8'));
  }

  // Compute and write expected.json
  const expected = computeExpected(FIXTURE_SOURCES, FIXTURE_OVERRIDES);
  fs.writeFileSync(
    path.join(outRoot, 'expected.json'),
    encodeText(`${JSON.stringify(expected, null, 2)}\n`, 'utf-8'),
  );

  return expected;
}

// Also export DeclaredEncoding helper for tests
export function decoderLabelFor(encoding: DeclaredEncoding, physical: FixtureFileSpec['physicalEncoding']): string {
  if (physical === 'utf-16le-bom') return 'utf-16le';
  if (encoding === 'cp932') return 'shift_jis';
  if (encoding === 'gb18030') return 'gb18030';
  if (encoding === 'utf-16le') return 'utf-16le';
  if (encoding === 'utf-16be') return 'utf-16be';
  return 'utf-8';
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const expected = await generateFixtures();
  console.log(
    `Generated fixtures: ${Object.keys(expected.sources).length} sources, ${expected.contacts_total} contacts (${expected.cross_source_dups} cross-source dups).`,
  );
}
