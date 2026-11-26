# email-digging-skills

[English](README.md) | 简体中文

自托管的客户邮件名单数据流水线：将分散在不同来源与格式（CSV、TSV、XLSX、JSON、SQLite）中的客户邮箱导出文件按来源打标签、清洗规范化、跨来源去重合并进单个本地 SQLite 主库——以通用 AI Agent Skills 搭配纯命令行脚本的形式发布。

## 项目背景与理念

在长期运营多个产品、表单与线下/线上活动后，客户邮箱往往散落在格式不一的导出文件里：编码各异（日文 Excel 常见的 `CP932` / Windows-31J、中文 `GB18030`、`UTF-16LE`、带 BOM 的 `UTF-8`）、列名不统一、单个单元格混入多个邮箱、全角字符、域名拼写错误，以及各自不同的订阅同意列。

**email-digging-skills** 不把第三方发信平台当作主数据源，而是以你自己的本地 SQLite 数据库（`workspace/database/mail-list.sqlite`）作为唯一真实来源（Single Source of Truth）：

- **数据自主可控**：原始导出文件只读保存在 `workspace/resources/`；人工裁决记录在 `workspace/overrides/` 下的 YAML 文件中；每次合并支持幂等重跑并在写入前自动备份。
- **发信平台仅作为下游**：Listmonk + Amazon SES 等发信工具只接收经本地筛选后的可发送名单，不接管联系人全集与同意证据。
- **面向 AI Agent 默认脱敏**：所有 CLI 标准输出、错误提示与运行报告默认对个人信息脱敏（如 `t***@e***e.jp`、`山***`），让各类 Agent 可以在不读取整份真实名单的前提下安全编排流水线。

## 当前状态（第一阶段 Phase 1）

第一阶段已完成，包含以下能力：

- 运行环境与工作区安全防呆检查（`init-workspace`，含基于合成样例的一键 `--demo` 演练）。
- 数据源接入、编码与表头探测、疑似重复导出文件识别（`add-source`）。
- 邮箱规范化、多邮箱单元格拆分、角色邮箱与域名拼写疑似错误标记、日期与同意词解析、基于 DuckDB 的 Parquet 中间层暂存、带自动备份的 SQLite 单事务合并，以及脱敏 Markdown/JSON 清洗报告（`clean-and-merge`）。
- 待人工裁决项汇总（`review-report`）、只读脱敏 SQL 与预设查询（`query-list`）、基于 HMAC-SHA256 的可分享脱敏副本生成（`mask-data`）。
- 下游发信平台插件接口（`providers/`）及 **Listmonk 本地 dry-run CSV 导出**（`export-to-provider`）。真实 API 推送（`--apply`）、退订/退信回流拉取、付费邮箱有效性验证服务对接及本地可视化管理界面（`apps/`）留待后续阶段实现。

## 运行环境要求

- **Node.js `>= 22.18`** — 通过 Node 内置类型剥离（type stripping）直接运行 TypeScript，并使用内置 `node:sqlite`（无需编译构建步骤）。
- **`pnpm`**（`package.json` 指定 `pnpm@12.23.0`）。
- **DuckDB** — 已通过 `@duckdb/node-api`（`2.0.1-r.1`）内置绑定，无需单独安装 `duckdb` 命令行程序。
- **首次初始化需联网一次** — 首次运行 `pnpm init-workspace` 时，DuckDB 需要联网下载并缓存 `excel` 与 `sqlite` 扩展（`encodings` 为可选扩展；文本解码由 Node `TextDecoder` 完成）。

## 快速开始

安装依赖并用合成样例跑通完整流水线（演示数据写入独立的 `workspace/.demo/`，不会触碰真实主库 `workspace/database/mail-list.sqlite`）：

```sh
pnpm install
pnpm init-workspace --demo
```

预期输出：

```text
Workspace: /path/to/email-digging-skills/workspace

Check                                  Result                                                                                                        Fix
-------------------------------------  ------------------------------------------------------------------------------------------------------------  ---
Node.js >= 22.18                       ok (v26.7.0)
pnpm dependencies                      ok (installed)
DuckDB loads                           ok (v2.0.1)
DuckDB extension excel                 ok (loaded)
DuckDB extension sqlite                ok (loaded)
DuckDB extension encodings (optional)  ok (loaded)
Workspace location                     ok (inside the repository, git-ignored)
Workspace layout                       ok (created 9 directories)
config.yaml                            ok (created from config.example.yaml)
.env                                   ok (created from .env.example)
MASK_HMAC_KEY                          ok (generated (stored in .env, not shown))
Database                               ok (applied 0001_init, 0002_views)
git hooks                              ok (core.hooksPath set to .githooks)
Demo workspace layout                  ok (created 10 directories)
Demo fixtures                          ok (copied 24 file(s))
Demo database                          ok (applied 0001_init, 0002_views)
Demo pipeline run                      ok (36 contacts, 6 in 2+ sources, strict list 17, not blocked 29; report output/reports/20261126T122718Z.md)

Next: add-source <name>
Tip: Recommended: install the subagent-team skill for multi-step agent work (onboarding several sources, reviews, handovers): `npx skills add interjc/subagent-team-skills` (https://github.com/interjc/subagent-team-skills).
```

接着可以直接对演示工作区运行后续命令：

```sh
node scripts/review-report.ts --workspace workspace/.demo
node scripts/query.ts --workspace workspace/.demo --preset domains
node scripts/export.ts --workspace workspace/.demo --provider listmonk
```

## 流水线步骤与 Skills 对照

每个流水线步骤都对应 [`skills/`](skills/README.md) 下的一个标准 Skill，并调用 [`scripts/`](scripts/) 中的命令行脚本：

| 步骤 | Skill | 命令行脚本 | 作用 |
|---|---|---|---|
| 1 | [`init-workspace`](skills/init-workspace/SKILL.md) | `pnpm init-workspace [--demo]` | 检查运行环境与 Git 忽略安全保护，创建工作区目录、`config.yaml`、`.env`（自动生成 `MASK_HMAC_KEY`）、SQLite 表结构及 Git 钩子。 |
| 2 | [`add-source`](skills/add-source/SKILL.md) | `node scripts/add-source.ts <name>` | 创建或探测 `workspace/resources/<name>/`，识别编码、列映射与疑似重复文件，生成 `meta.md` 草稿（绝不覆盖已有 `meta.md`）。 |
| 3 | [`clean-and-merge`](skills/clean-and-merge/SKILL.md) | `node scripts/clean-and-merge.ts [--dry-run]` | 将各来源清洗暂存为 Parquet，应用 `workspace/overrides/*.yaml`，自动备份主库后单事务合并联系人与同意状态，并输出脱敏报告。 |
| 4 | [`review-report`](skills/review-report/SKILL.md) | `node scripts/review-report.ts` | 输出脱敏的待人工确认项（拼写建议、自动检测编码、低置信度列映射、`unknown` 同意依据），并在本地生成 `output/reports/pending-decisions.yaml`。 |
| 4b | [`check-domains`](skills/check-domains/SKILL.md) | `node scripts/check-domains.ts [--dns]` | 将未裁决的疑似拼错域名分类为 `obvious` 与 `ambiguous`（可选 `--dns` 通过本机解析器检查），并在本地生成可直接复制审阅的 `output/reports/domain-check.yaml`（不写入 `overrides/`）。 |
| 5 | [`query-list`](skills/query-list/SKILL.md) | `node scripts/query.ts --preset <name>` / `--sql "<SELECT …>"` | 对主库执行只读脱敏查询（内置 `sources`、`overlap`、`only-in`、`sendable`、`domains`、`status`、`consent`、`orphaned` 或自定义 `SELECT`），支持 `--out` 导出本地 CSV。 |
| 6 | [`mask-data`](skills/mask-data/SKILL.md) | `node scripts/mask-data.ts [--hash-domain] [--shape]` | 在 `workspace/output/masked/` 下生成 HMAC 假名化的 SQLite 副本（`mail-list-masked.sqlite`）及可选的数据形状摘要 `shape.json`。 |
| 7 | [`export-to-provider`](skills/export-to-provider/SKILL.md) | `node scripts/export.ts --provider listmonk` | 在 `workspace/output/exports/` 下生成 Listmonk 本地 dry-run 导入 CSV（默认使用 `strict` 严格名单）并记录 `sync_log`。 |

详细规则文档见 [`docs/`](docs/README.md)（英文）：
- [数据库表结构与视图说明](docs/schema.md)
- [清洗、编码、日期与合并规则](docs/cleaning-rules.md)
- [数据源元数据（`meta.md`）模板](docs/meta-template.md)
- [同意策略与可发送名单定义](docs/consent-policy.md)
- [数据脱敏与外发边界规范](docs/masking.md)

## 目录结构

```text
email-digging-skills/
├── AGENTS.md                  # 面向所有 Agent 与协作人员的强制数据安全与工作流规则
├── CLAUDE.md                  # 指向 AGENTS.md 的入口说明
├── config.example.yaml        # 配置模板，init-workspace 会复制为本地 config.yaml（已 git-ignore）
├── .env.example               # 密钥变量名模板，init-workspace 会复制为本地 .env（已 git-ignore）
├── .githooks/pre-commit       # 提交前邮箱泄露扫描 + 可选 gitleaks 密钥扫描钩子
├── .agents/skills -> ../skills
├── .claude/skills -> ../skills
├── skills/                    # 7 个跨平台通用的 Agent Skills（每步一个目录 + SKILL.md）
├── docs/                      # 表结构、清洗规则、同意策略、脱敏规则与 meta.md 规范
├── scripts/                   # TypeScript CLI 脚本、共用核心库（scripts/lib/）及单元测试
├── schema/migrations/         # 按序号排列的 SQLite 建表与视图迁移 SQL
├── providers/                 # 下游发信平台插件（Phase 1：listmonk 本地 dry-run CSV）
├── apps/                      # 后期本地可视化管理界面占位目录（仅监听 127.0.0.1）
├── fixtures/                  # 确定性生成的合成测试数据、overrides 样例与预期统计结果
└── workspace/                 # 真实数据唯一存放处（已 git-ignore；也可用 MAIL_PIPELINE_WORKSPACE 指到仓库外）
    ├── resources/<source>/    # 只读原始导出文件 + meta.md（及可选人工备注 NOTES.txt）
    ├── overrides/             # 人工裁决 YAML：typo-decisions、suppressions、consents、exclude
    ├── output/                # 脚本自动生成的产物（可随时安全重建）
    │   ├── staging/           # 各来源清洗后的 Parquet 行、拒绝行与 stats.json
    │   ├── reports/           # 脱敏运行报告（.md/.json）与仅限本地查看的 pending-decisions.yaml
    │   ├── masked/            # 假名化脱敏 SQLite 副本与 shape.json（唯一允许离开本机的目录）
    │   └── exports/           # 本地查询导出与发信平台 dry-run CSV（含完整邮箱，严禁外泄）
    └── database/
        ├── mail-list.sqlite   # 合并后的 SQLite 主库
        └── backups/           # 每次合并前自动生成的数据库备份
```

## 数据安全机制

1. **工作区隔离与 Git 防提交守卫**：`.gitignore` 默认忽略 `workspace/*`、`config.yaml`、`.env*` 以及仓库内除 `fixtures/` 以外的所有数据文件后缀（`*.sqlite`、`*.csv`、`*.xlsx`、`*.parquet` 等）。每个 CLI 启动时都会运行 `checkWorkspaceSafety`，一旦发现工作区（或其任何符号链接子目录）可能被 Git 跟踪，立即以退出码 `2` 拒绝执行。建议通过 `MAIL_PIPELINE_WORKSPACE` 或 `config.yaml` 将真实工作区放在非云盘同步目录（避开 iCloud、Dropbox、OneDrive、Google Drive）。
2. **原始文件只读且绝不暗中改写邮箱**：`workspace/resources/` 下的导出文件永不修改。疑似拼写错误的域名（如 `member@example.con` → `member@example.com`）仅做标记并给出建议，只有在人工写入 `workspace/overrides/typo-decisions.yaml` 确认接受后才更新规范化邮箱，且始终保留 `raw_email` 原值。
3. **默认展示脱敏（查询 fail-closed 闭锁）**：CLI 终端输出、报错信息、JSON 输出、查询标准输出与清洗报告均经过地址清洗与字段脱敏（`t***@e***e.jp`、`山***`、`***-****-**12`）。`query` 标准输出采用 fail-closed（默认兜底脱敏）策略：仅已知非个人字段或预设声明安全的列会原样放行（仍做邮箱地址清洗），计算表达式、未知列及 JSON 中的个人字段都会被自动脱敏。
4. **提交前钩子与 CI 扫描**：`.githooks/pre-commit` 自动运行 `node scripts/check-staged-emails.ts`（支持扫描 UTF-8、UTF-16、CP932、GB18030、`.xlsx` 内部 XML 及二进制文件中的非 `example.*` 邮箱）并在本机安装了 `gitleaks` 时扫描密钥；GitHub Actions CI 在每次推送与 PR 时强制执行全量检查。
5. **严格的数据外发边界**：**只有 `workspace/output/masked/` 目录下的脱敏副本在经人工审阅后可以离开本机**，且 `.env` 中的 `MASK_HMAC_KEY` 严禁外传。

## 配合 AI Agent 使用

- **推荐搭配：[subagent-team-skills](https://github.com/interjc/subagent-team-skills)。** 实际使用往往要走很多步：接入多个来源、逐个确认 `meta.md`、预演、评审、拼写决定。用它让 Agent 做计划、分派任务并维护交接看板，会顺手很多。每台机器装一次：`npx skills add interjc/subagent-team-skills`（Claude Code 和 Codex 也可以按它的 README 用插件方式安装）。没装的话，`init-workspace` 会提醒你。

- **Claude Code 与 Codex**：仓库根目录已提供指向 [`skills/`](skills/) 的符号链接 `.claude/skills` 与 `.agents/skills`，两类工具会自动发现全部 7 个流水线 Skill。
- **其他任意 Agent**：让 Agent 阅读 [`AGENTS.md`](AGENTS.md)（`CLAUDE.md` 亦指向此处）及 [`skills/`](skills/) 下的 `SKILL.md`。所有 Skill 均采用中立描述与标准 `node` / `pnpm` 终端命令，不依赖任何特定厂商的专有工具。

## 订阅同意与合规说明

系统按 `(联系人, 来源)` 独立记录同意状态及原始列名、行号与取值证据，并将退订/退信/手动屏蔽记录在只增不删的 `suppressions` 表中（优先级高于任何同意记录）。导出默认采用严格视图 `v_sendable_strict`：要求至少一个当前来源明确 `granted` 或属于配置认定的 opt-in 来源，且没有任何来源标记 `denied`、未被屏蔽、亦非未处理的疑似拼错邮箱。若显式传入 `--list not_blocked` 选择宽松名单，脚本会在 `stderr` 打印风险警告。

各国反垃圾邮件与隐私法规（如日本《特定電子メール法》、GDPR、CAN-SPAM 等）对营销邮件的事前同意与证据留存有严格规定。**本仓库代码与文档不构成任何法律意见。** 请在发信前自行核实所在司法辖区的合规要求，在任何向外部系统上传或发信前取得明确人工确认，并对拟发送名单做邮箱有效性验证以控制退信率。

## 参与贡献、安全与变更记录

- **参与贡献**：开发环境配置、TypeScript 编码规范、合成测试数据生成、提交前检查及新增 Provider 插件指南请参见 [CONTRIBUTING.md](CONTRIBUTING.md)。
- **行为准则**：请参见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
- **安全与隐私漏洞报告**：如发现信息泄露、脱敏绕过或其他安全问题，请先阅读 [SECURITY.md](SECURITY.md) 并通过 GitHub 私密通道报告，严禁附带任何真实客户数据。
- **变更记录**：第一阶段功能与已知限制请参见 [CHANGELOG.md](CHANGELOG.md)。

## 开源许可证

[MIT](LICENSE)
