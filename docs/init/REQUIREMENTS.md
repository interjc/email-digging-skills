# 客户邮件名单流水线：需求与项目结构

> 本地 project，配合 AI agent（skills + AGENTS.md）使用，并作为**开源 skill** 发布，供其他人和其他 agent 使用。2026-11-26 整理。

## 1. 背景与目标

- 过去多个产品和活动积累了大量客户邮箱，分散在不同格式的导出文件里（Excel、CSV、SQLite 等）。
- 目标是把它们集中到一处统一管理：**自托管**，数据存在**自己的数据库**，发信时购买各平台的发送 API。
- **第一步（本项目当前范围）**：数据汇总与清洗。
  1. 导出各来源的名单（格式各不相同）
  2. 按来源打标签
  3. 清洗、去重、合并
  4. 最终得到一个**可查询的邮件名单库**
- 后续步骤（暂不实现，但结构要预留）：通过各平台的 API / MCP / CLI 把数据导入发信系统（初步考虑 Listmonk + Amazon SES）。

## 2. 技术选型

| 用途 | 选择 | 说明 |
|---|---|---|
| 读取与清洗引擎 | DuckDB | 一条 SQL 读整个目录的 CSV / xlsx / JSON，`union_by_name` 按列名对齐，自动带文件名；encodings 扩展可读 shift_jis、gb18030 |
| 主库 | SQLite（单文件） | 方便本地查询和备份；表结构保持可迁移到 Postgres |
| 脚本语言 | TypeScript / Node（或直接 DuckDB SQL） | 与现有技术栈一致 |
| 发信层（后续） | Listmonk + Amazon SES | Listmonk 只作为发信层，不作为主数据源 |

> 注：DuckDB 可通过 sqlite 扩展直接读写 SQLite 文件，所以“DuckDB 清洗 + SQLite 存储”可以并存。也可以直接用 DuckDB 文件作为主库，二选一即可。

## 3. 项目目录结构

```
mail-list-pipeline/
├── AGENTS.md                  # agent 的总规则（见第 10 节），跨 agent 通用
├── CLAUDE.md                  # 可选，只写一行指向 AGENTS.md
├── README.md
├── LICENSE
├── CONTRIBUTING.md
├── config.example.yaml        # 配置模板：workspace 路径、来源优先级等（真实配置不进 git）
├── skills/                    # 流水线各步骤的 skill（见第 9 节），每个一个目录 + SKILL.md
│   ├── init-workspace/
│   ├── mask-data/
│   └── ...
├── docs/                      # 规范与说明
│   ├── schema.md              # 表结构说明
│   ├── cleaning-rules.md      # 清洗规则
│   ├── meta-template.md       # 数据源 meta.md 模板
│   ├── consent-policy.md      # 同意状态的判定规则
│   └── masking.md             # 脱敏规则
├── scripts/                   # 可重复运行的脚本（读取、清洗、合并、报告、导出）
├── schema/
│   └── migrations/            # 建表与变更 SQL，按序号命名，纳入版本管理
├── providers/                 # 外部系统连接（见第 7 节），只放代码和配置模板
│   └── listmonk/
├── apps/                      # 本地启动的可视化管理工具（本地 web），一开始可以为空，见第 8 节
├── fixtures/                  # 合成的样例数据，用于测试，纳入版本管理
├── .env.example               # 各 provider 需要的密钥名（不含值）
├── .gitignore                 # 见第 11 节
└── workspace/                 # 真实数据，不进 git；路径可用 MAIL_PIPELINE_WORKSPACE 改到 repo 外
    ├── resources/             # 原始数据，只读
    │   └── <source>/
    │       ├── meta.md
    │       └── <原始文件>.xlsx / .csv / .db
    ├── overrides/             # 人工决定（见 6.3），重跑时保留
    ├── output/                # 由脚本生成，可随时删除重建
    │   ├── staging/           # 每个来源清洗后的中间结果
    │   ├── reports/           # 清洗报告（默认脱敏）
    │   ├── masked/            # 脱敏副本，可分享
    │   └── exports/           # 给发信平台的导出文件
    └── database/
        ├── mail-list.sqlite   # 主库
        └── backups/
```

## 4. 各目录规范

### 4.1 workspace/resources（原始数据）

- 每个数据源一个子目录，目录名即**来源标签**（如 `product-a`、`event-2023-tokyo`），只用小写字母、数字和连字符。
- 原始文件**放进去后不再修改**。需要修正的内容写进 overrides，或在脚本里处理。
- 同一来源有多次导出时，文件名带导出日期，如 `members_2025-03-01.csv`。
- 老的 `.xls` 先另存为 `.xlsx`。

### 4.2 meta.md（数据源描述）

上半部分是给脚本读的 YAML frontmatter，下半部分是给人看的说明。

```markdown
---
source: product-a
kind: product            # product / event / other
label: 产品A 会员
files:
  - name: members_2025-03-01.csv
    encoding: cp932      # utf-8 / utf-8-sig / cp932 / gb18030 / utf-16le，未知写 auto
    sheet:               # xlsx 才需要
    header_row: 1
columns:                 # 原始列名 → 标准字段，未写的列由脚本自动识别
  email: メールアドレス
  name: 氏名
  created_at: 登録日
  locale:
  consent: メルマガ配信
consent_basis: unknown   # 收集时的同意依据：opt_in / transactional / unknown
exported_at: 2025-03-01
---

## 说明
- 数据怎么来的、覆盖哪段时间
- 已知问题（例如有测试账号、某列含义不清）
```

### 4.3 workspace/output

- 全部由脚本生成，**不手工修改**。删掉后重跑能得到完全相同的结果。
- `staging/`：每个来源清洗后的标准字段结果（可用 Parquet 或 CSV）。
- `reports/`：每次运行的清洗报告。
- `exports/`：给发信平台的文件（如 Listmonk 导入用的 CSV）。

### 4.4 workspace/database

- 主库 `mail-list.sqlite`，表结构由 `schema/migrations/` 建立。
- 每次合并前自动备份到 `backups/`。

## 5. 数据库表结构

| 表 | 一行代表 | 主要字段 |
|---|---|---|
| `sources` | 一个来源 | name（唯一）、kind、label、consent_basis |
| `contacts` | 一个邮箱 | id、email（规范化后，唯一）、email_domain、name、locale、email_status（valid / role / typo_suspect）、flags、first_seen_at |
| `contact_sources` | 一个邮箱在一个来源 | contact_id、source、raw_email、first_seen_at、last_seen_at、raw_fields（JSON） |
| `consents` | 一个邮箱在一个来源的同意状态 | contact_id、source、status（granted / denied / unknown）、evidence（依据的列和值）、recorded_at |
| `suppressions` | 一条不可发送记录 | email、reason（unsubscribed / bounced / complained / manual）、source、created_at。按邮箱存，删联系人也保留 |
| `rejected_rows` | 一条无效行 | source、file、row_number、raw_value、reason |
| `imports` | 一次文件导入 | source、file、sha256、rows_read、imported_at |
| `sync_log` | 一次与 provider 的同步 | provider、direction（push / pull）、started_at、counts、status |

示例查询需求：
- 来自产品 A 但不在产品 B 的联系人
- 各来源之间的重叠数量
- 可发送名单：未被 suppress、且没有任何来源标记 denied

## 6. 清洗规则

### 6.1 编码
- 日文 Excel 导出的 CSV 按 **CP932** 读（Shift_JIS 的扩展，含 ①、㈱ 等字符）。
- 中文导出多为 GBK / GB18030；Excel 的“Unicode 文本”是 UTF-16LE 的 TSV。
- 优先读 meta.md 指定的编码；写 auto 时先试 UTF-8，再试 CP932、GB18030，并在报告里列出判定结果，供人工确认。

### 6.2 邮箱规范化
- 去首尾空格和不可见字符，全角转半角（NFKC，会碰到全角 ＠），转小写，去掉 `mailto:` 和尖括号。
- 一个单元格有多个邮箱时拆开。
- 原始值保存在 `contact_sources.raw_email`。
- 语法不合格的进 `rejected_rows`，不删除。
- 角色邮箱（info@、support@、noreply@ 等）打标记，不剔除。
- 常见域名拼错（gmial.com、yahoo.co.jo、docomo.ne.jo 等）只标记并给出建议写法，**不自动改写**。
- 旧的 docomo、au 手机邮箱可能含连续的点或 @ 前的点，放行并标记，不判为无效。
- 不合并 Gmail 的点和 `+` 别名。

### 6.3 去重与合并
- 以规范化后的邮箱为唯一键，跨来源合并为一个联系人，保留所有来源标签。
- 每个来源记录 first_seen_at / last_seen_at（来自日期列；没有日期列则为空）。
- 姓名等字段：按来源优先级取第一个非空值，各来源原值保留在 raw_fields。
- 同意状态默认 unknown，只有原表有对应列时才写 granted / denied，并记录依据。
- 人工决定放在 `workspace/overrides/`（如接受某个拼写建议、手动加入 suppression），脚本每次运行都读取，重跑不丢失。

### 6.4 清洗报告
每次运行输出：每个文件读入行数、空邮箱、无效数、单元格拆分数、文件内重复、跨来源重复、角色邮箱数、疑似拼错数、最终唯一联系人数、来源重叠矩阵，以及识别到的编码和列映射。

## 7. Providers（外部系统连接）

- 每个 provider 一个目录，统一接口，例如：
  - `push_contacts`：把可发送名单推到发信平台（Listmonk 用 import API 或 CSV）
  - `pull_suppressions`：把退订、退信、投诉拉回本地 `suppressions` 表
- 连接方式可以是 API、MCP 或 CLI，对上层保持同一接口。
- 默认 **dry-run**，只输出将要做的变更；真正写入需要人工确认参数后再执行。
- 以邮箱为键，可重复执行；每次同步写 `sync_log`。
- 密钥只放 `.env`（不进 git），`providers/` 里只有代码和 `.env.example`。
- 数据流向：本地主库是唯一真实来源，发信平台只是下游；退订和退信要回流到主库。

## 8. Apps（本地可视化管理工具，后期）

- 一开始可以只放一个 `apps/README.md` 占位，等流水线稳定后再做。
- 用途举例：浏览和搜索联系人、看清洗报告和来源重叠、逐条处理疑似拼错和可疑列映射、管理 suppression。
- 每个 app 一个子目录（如 `apps/admin-web/`，可用 Next.js），本地启动，只监听 `127.0.0.1`。
- 读写都复用 `scripts/` 里的同一套逻辑（建议把核心逻辑放在共用的库里，CLI 和 app 都调用它），不另写一套。
- 人工决定通过 app 写进 `workspace/overrides/`，不直接改主库，这样重跑流水线结果一致。
- 界面默认脱敏显示，点开单条才显示完整值；app 自身不保存数据副本。

## 9. Skills（建议）

| skill | 作用 |
|---|---|
| `init-workspace` | 本地数据初始化，见 9.1 |
| `mask-data` | 数据脱敏，见 9.2 |
| `add-source` | 新建 `resources/<source>/`，探测编码和列，生成 meta.md 草稿供确认 |
| `clean-and-merge` | 按 meta.md 读取、清洗、合并进主库，生成报告 |
| `review-report` | 解读清洗报告，列出需要人工决定的项（拼写建议、可疑列映射） |
| `query-list` | 按需求写 SQL 查询名单（只读） |
| `export-to-provider` | 生成可发送名单并以 dry-run 方式推送到 provider |

### 9.1 init-workspace（本地数据初始化）

新用户 clone 之后第一件事，可重复运行，已存在的东西不覆盖：
1. 检查运行环境：Node、DuckDB 版本及所需扩展（excel、encodings、sqlite）。
2. 确定 workspace 位置（默认 repo 下 `workspace/`，或 `MAIL_PIPELINE_WORKSPACE` 指定的 repo 外路径），并确认它被 git 忽略；如果在 repo 内却没被忽略，直接停止并提示。
3. 建好目录：resources/、overrides/、output/{staging,reports,exports}/、database/backups/。
4. 从 `config.example.yaml`、`.env.example` 复制出 `config.yaml`、`.env`（已存在则跳过）。
5. 运行 schema/migrations，建一个空的主库。
6. 可选：用 `--demo` 把 fixtures 导入一个独立的 demo 库，跑一遍完整流程，确认环境正常，不碰真实主库。
7. 输出一份初始化结果：各项检查是否通过、下一步做什么（通常是 `add-source`）。

### 9.2 mask-data（数据脱敏）

脱敏要做到两点：agent 和日志看不到完整个人信息；需要分享数据（提 issue、给别人调试、做 fixtures）时有安全的版本。

- **默认展示即脱敏**：脚本给 agent 看的摘要、样例、报告和日志里，邮箱显示为 `t***@g***l.com`，姓名只留首字（如 `山*`），电话等只留后两位。完整值只在主库和 exports 里。
- **脱敏导出**：`mask-data` 生成一份脱敏副本，放在 `output/masked/`：
  - 邮箱本地部分用带密钥的 HMAC 替换（密钥放 `.env`），同一邮箱脱敏后仍相同，所以去重、重叠统计结果不变；域名可选择保留（便于看域名分布）或一并替换。
  - 姓名、电话、地址等替换为假数据或清空；只保留列结构、编码、空值比例这类“形状”信息。
- **生成 fixtures**：从真实数据的形状（列名、编码、异常类型）生成合成样例，邮箱一律用 `example.com`、`example.jp`，不从真实值派生。
- **报告默认脱敏**：清洗报告里的“无效样例”“疑似拼错”列表默认脱敏，需要看完整值时在本地查主库。
- 规则写进 `docs/masking.md`，哪些字段算个人信息、各自怎么处理。

## 10. AGENTS.md 要点

- 真实数据只在 `workspace/`；不要把整份名单读进上下文，只看脚本输出的脱敏摘要和少量脱敏样例。
- clone 后先运行 `init-workspace`；workspace 不存在或没被 git 忽略时，其他 skill 一律不执行。
- `resources/` 只读；`output/` 只由脚本生成。
- 任何写入外部系统（provider 推送）、发送邮件、删除数据库内容的操作都必须先得到人工确认。
- 不改写邮箱原值；拼写建议只标记。
- 改表结构只能通过新增 migration。
- 测试只用 `fixtures/` 里的合成数据。
- 不往 repo 里写任何真实来源名、邮箱或配置；新增的数据文件只能放 workspace/。

## 11. 开源发布要求

这个 repo 会公开，所以 repo 里只能有**通用的工具、流程和规范**，不能有任何属于某个使用者的数据或配置。

### 11.1 什么进 repo，什么不进

| 进 repo | 不进 repo |
|---|---|
| skills/、docs/、scripts/、schema/、providers/、apps/ 的代码 | workspace/ 全部内容（原始数据、主库、输出、overrides） |
| `config.example.yaml`、`.env.example`、meta.md 模板 | `config.yaml`、`.env`、任何密钥 |
| fixtures/ 里的合成数据 | 真实的来源名、产品名、列映射、provider 地址 |
| 域名拼错表、角色邮箱表等通用规则数据 | 清洗报告、导出文件、备份 |

- 使用者自己的东西（来源列表、来源优先级、provider 配置）都放在 `config.yaml` 或 workspace 里。
- `workspace/` 的位置可通过环境变量 `MAIL_PIPELINE_WORKSPACE` 指到 repo 之外，避免误提交；默认仍是 repo 下的 `workspace/`。

### 11.2 .gitignore

```gitignore
# 真实数据和运行产物
workspace/
!workspace/.gitkeep

# 本地配置和密钥
config.yaml
.env
.env.*
!.env.example

# 数据文件兜底：防止被放到 workspace 以外
*.sqlite
*.sqlite3
*.db
*.duckdb
*.duckdb.wal
*.parquet
*.xlsx
*.xls
*.csv
*.tsv
*.jsonl
!fixtures/**

# 依赖和系统文件
node_modules/
.DS_Store
```

> 数据文件后缀做兜底忽略，只对 `fixtures/` 放行，这样即使有人把导出文件丢错目录，也不会被提交。

### 11.3 提交前检查
- 用 pre-commit 钩子跑密钥扫描（如 gitleaks）。
- 再加一个简单检查：fixtures 之外的已暂存文件里出现邮箱地址就拒绝提交；fixtures 里只允许 `example.com`、`example.jp` 等保留域名。
- CI 里跑同样的检查和测试。

### 11.4 让其他 agent 也能用
- 总规则写在 `AGENTS.md`（多数 agent 都会读）；需要时 `CLAUDE.md` 只放一行指向它，不重复内容。
- 每个 skill 用 `skills/<name>/SKILL.md`（frontmatter 写 name 和 description）+ 同目录脚本，不依赖某一家 agent 的专有工具。
- skill 只调用 `scripts/` 里的命令行脚本，命令和参数写清楚，任何 agent 或人都能直接运行。
- 文档写明运行环境（Node 版本、DuckDB 版本）和一条命令跑通 fixtures 的示例。
- providers 做成插件形式，别人可以新增自己的 provider，不改核心代码。

## 12. 安全与合规

- `workspace/` 含个人信息：不进 git，不放进会自动同步到云端的目录，备份需加密。
- 只有 `output/masked/` 里的脱敏副本可以离开本机。
- 按来源保留同意状态和依据。日本的特定電子メール法原则上要求营销邮件事先取得同意（有例外），发信前按 consents 筛选。
- 发信前对准备发送的部分做一次付费邮箱验证，控制退信率（SES 在退信率过高时会审查或暂停账户）。

## 13. 待定事项

- 主库用 SQLite 还是 DuckDB 文件（或将来直接上 Postgres）
- 各来源的优先级（合并姓名等字段时谁优先）
- 哪些来源的同意依据可以视为 opt-in
- 验证服务选哪家
- 开源许可证（如 MIT 或 Apache-2.0）
- repo 名称
