# BUDU / SmartSteer 项目状态交接

> 快照时间：2026-08-23 11:26 CST（Asia/Shanghai）
> 目的：只记录本轮结束时由 Git、代码、测试数据库和北京生产环境实际核实的事实。
> 本文件不构成生产迁移、部署、支付启用或敏感数据处理授权。

## 0. 状态总览

| 项目 | 当前真实状态 |
|---|---|
| 当前任务 | 员工档案（Employee Master Profile）后端/Schema 草稿；同时存在已提交但未部署的门店业绩权限修复 |
| 当前阶段 | **IN PROGRESS**：员工档案 Router 已挂载到本地 `app.js`，但无前端、无专项测试、未提交、未迁移生产 |
| 当前 Branch | `feat/wecom-push` |
| HEAD | `09d25d94e4c53a0bdc74c9bea177fbfcae1a2f9c` |
| 远端同步 | HEAD 与 `origin/feat/wecom-push` 一致；已 push |
| 相对 main | 比 `origin/main` 多 12 个提交 |
| Working Tree | **DIRTY** |
| 当前生产 SHA | `49262ad`（公网 `/api/health` 实测） |
| 当前生产环境 | 北京，`APP_ENV=prod`，容器 healthy |
| Repository migrations | 28 个目录（第 28 个尚未提交） |
| Production migrations | 27 APPLIED / 0 failed；员工档案 migration NOT APPLIED |
| 当前测试结论 | 单元/集成与浏览器通过；SSR 冒烟失败；员工档案无专项测试 |

## 1. 已完成内容

### DONE

- 移动端 Header 工具栏溢出修复：375/390/430px 门店选择器与日期工具不再被裁剪；浏览器测试覆盖。
- POS mock 扫码修复：mock 模式接受测试码；真实微信付款仍校验 18 位付款码。
- 企业微信个人通知与绑定安全加固：
  - OAuth state 使用 PostgreSQL 一次性哈希票据，拒绝伪造、过期和重放。
  - 手工绑定仅 Developer；目标账号校验、活动微信身份唯一约束、审计和脱敏已实现。
  - `PUBLIC_BASE_URL` 安全校验、回调 Token/AES Key 缺失时 fail-closed。
  - Migration `20260823000000_wechat_binding_security` 已在生产 APPLIED。
- 微信支付核对字段 migration `20260822000001_wechat_pay_reconciliation` 已在生产 APPLIED；真实微信支付仍显式关闭。
- 自建生产文件存储：支持显式 `DATA_STORE=file` + `DATA_DIR`，生产当前使用持久卷文件存储。
- 北京生产曾完成备份、隔离恢复 migration dry-run、数据库迁移和受控切流；当前生产仍健康。
- 后续已提交并推送的界面/权限工作：
  - 移动侧栏矮屏适配（`c93cb6d`）。
  - 账号管理用户名与卡片化 UI（`6d81c71`、`49262ad`）；生产当前运行到 `49262ad`。
  - 项目需求与技术亮点文档（`63a7569`，不影响运行时）。
- 当前工作树重新验证结果：
  - `npx prisma validate`：PASS（使用无敏感信息的占位 URL，仅校验 Schema）。
  - `npm run test`：PASS 27 / FAIL 0。
  - 隔离 PostgreSQL 测试 schema：28 个 migration 全部 APPLIED，测试后 schema 已清理。
  - `npm run build`：PASS。
  - `npx playwright test`：PASS 34 / 34。

### IN PROGRESS

#### A. 员工档案模块（未提交工作树）

- `prisma/schema.prisma` 新增 10 个 Employee 相关 model。
- 新建 migration `20260823000001_employee_profile`，创建 10 张表。
- 新建 `server/employee-profile.js`，包含 19 个 Router handler：员工列表/档案、任职信息、身份证、银行卡、调薪、状态历史、时间线、摘要和附件。
- `server/app.js` 已在本地将 `employeeProfileRouter` 挂到 `/api/v2`。
- `shared/accountPermissions.js` 新增 `MODULE_KEYS.EMPLOYEE_PROFILE`：Manager 默认包含，Staff 默认不包含；Developer/Admin/Finance 由既有全模块规则获得。
- 身份证号和银行卡号设计为 AES-256-GCM 密文 + last4 掩码；代码要求 `EMPLOYEE_SENSITIVE_KEY`。
- 当前没有 Employee Profile 前端页面、导航入口或浏览器测试。
- 当前没有员工档案专项 API、权限、加密、审计、并发或 migration 测试。

#### B. 门店业绩录入权限修复

- HEAD `09d25d9` 已提交并 push：门店业绩录入按账号 `storeKeys` 过滤门店，未绑定门店显示空态。
- 当前尚未部署生产；生产仍为 `49262ad`。
- 全量测试与浏览器套件通过，但 SSR 冒烟出现 StoreEntryPage 文案断言失败，不能标记为发布完成。

### NOT STARTED

- 员工档案前端页面、表单、导航与移动端布局。
- 员工档案旧 Staff/账号数据 backfill、对账与回滚设计。
- 员工档案生产 Secret 配置和密钥轮换方案。
- 员工档案生产 migration Gate、备份恢复演练与部署。
- 员工档案真实敏感数据验收；不得用真实身份证号或银行卡号做普通测试。
- 企业微信真实员工闭环验收（绑定 → 测试消息 → 工资条 → 微信收到 → 点击直达）仍为 NOT TESTED。
- 微信真实支付现场 Gate；功能继续关闭。

### BLOCKED

- **当前 HEAD/工作树部署 BLOCKED**：`npm run test:ssr` 失败，且工作树包含未提交员工档案代码。
- **员工档案生产迁移 BLOCKED**：无专项测试、无前端、生产未配置 `EMPLOYEE_SENSITIVE_KEY`、权限/隐私/事务设计尚未 Review。
- **员工档案生产使用 BLOCKED**：production migration 未应用，`employees` 表不存在。

## 2. 当前代码结构

### 2.1 下一轮 Agent 最先读取

1. `SmartSteer_Status.md`：本快照。
2. `CURRENT_ARCHITECTURE.md`：已有架构基线；注意它未覆盖本轮未提交员工档案代码。
3. `git diff -- prisma/schema.prisma server/app.js shared/accountPermissions.js`：所有已跟踪未提交改动。
4. `server/employee-profile.js`：未跟踪的员工档案 Router、权限、加密、审计和业务逻辑。
5. `prisma/migrations/20260823000001_employee_profile/migration.sql`：未跟踪 migration。
6. `src/components/StoreEntryPage.jsx` 与 `scripts/smoke-render.mjs`：当前 SSR 失败相关文件。
7. `scripts/run-tests.mjs`、`scripts/test-notification-center.mjs`：隔离测试与 migration 测试入口。

### 2.2 前端

| 文件 | 作用 / 状态 |
|---|---|
| `src/components/StoreEntryPage.jsx` | HEAD 的门店范围过滤修复；SSR 文案 Gate 当前失败 |
| `src/components/AccountAdminPage.jsx` | 已提交的账号管理卡片化 UI |
| `src/components/Sidebar.jsx` | 已提交的移动端矮屏适配 |
| `src/components/Header.jsx` | 全局门店/日期工具与移动端响应式布局 |
| `src/components/CalendarPicker.jsx` | Header 日期选择器 |
| `src/components/PosPage.jsx` | POS 与 mock/真实付款码分支 |
| `src/components/SettingsPage.jsx` | 微信绑定、解绑、Developer 手工绑定 UI |
| `src/components/Dashboard.jsx` | 页面与业务模块分发；目前没有 Employee Profile 页面接入 |

员工档案前端文件：**NOT PRESENT**。

### 2.3 后端 API / Service

- `server/app.js`
  - 公开：`/api/v2/wechat/bind/callback`、`/api/v2/wechat/recv`。
  - 鉴权业务路由统一挂在 `/api/v2`。
  - 当前脏工作树已挂载 `employeeProfileRouter`。
- `server/employee-profile.js`
  - 当前相对路径包括 `/employees`、`/employees/:id/profile`、identity/bank reveal、salary/status change、timeline、summary、documents 等；挂载后完整路径为 `/api/v2/...`。
  - 不是独立 Service 层：Router 直接调用 Prisma。
- `server/wechat-bind.js`：企业微信/公众号绑定、一次性 state、手工绑定和回调验签。
- `server/notification-center.js`：站内通知与个人微信推送。
- `server/payments/`：PaymentService、Provider、微信 V2 客户端与未决支付核对器。
- `server/store.js`：JSON/Redis 兼容数据层；生产明确使用 file 模式。
- `server/pg.js`：Prisma Client 与数据库就绪状态。

### 2.4 Prisma Model / 数据库表

已在生产存在的相关 model/table：

- `Payment` / `payments`。
- `Notification` / `notifications`。
- `NotificationDelivery` / `notification_deliveries`。
- `WechatBinding` / `wechat_bindings`。
- `WechatBindState` / `wechat_bind_states`。
- `WechatBindingAuditLog` / `wechat_binding_audit_logs`。

仅当前未提交 Schema/migration 中存在：

- `Employee` / `employees`。
- `EmployeeProfile` / `employee_profiles`。
- `EmployeeBankAccount` / `employee_bank_accounts`。
- `EmployeeContract` / `employee_contracts`。
- `EmployeeSalaryHistory` / `employee_salary_history`。
- `EmployeeStoreHistory` / `employee_store_history`。
- `EmployeePositionHistory` / `employee_position_history`。
- `EmployeeStatusHistory` / `employee_status_history`。
- `EmployeeDocument` / `employee_documents`。
- `EmployeeAuditLog` / `employee_audit_logs`。

### 2.5 权限

- 共享权限入口：`shared/accountPermissions.js`。
- 员工档案模块键：`employee-profile`（当前未提交）。
- Router 当前规则：
  - 编辑：Developer / Admin / Finance。
  - 身份证完整号码 reveal：Developer / Admin。
  - 银行卡完整号码 reveal：Developer / Admin / Finance。
  - Manager 默认获得模块，且当前 `canViewEmployee()` 允许 Manager 查看全部员工；必须做隐私范围 Review。
  - Staff 默认不获得该模块；若未来单独授权，代码仅允许查看关联本人。
- 账号治理仍仅 `canManageAccounts()` / Developer。

## 3. 关键参数

### 3.1 Git 状态

| 参数 | 值 |
|---|---|
| Branch | `feat/wecom-push` |
| HEAD SHA | `09d25d94e4c53a0bdc74c9bea177fbfcae1a2f9c` |
| HEAD commit | `fix(store-entry): 门店业绩录入仅限账号绑定门店...` |
| Working Tree | **DIRTY** |
| 已 push | YES；HEAD = `origin/feat/wecom-push` |
| 未提交代码已 push | NO |

生成本文件后应存在的未提交文件：

- `M SmartSteer_Status.md`（本交接文件）。
- `M prisma/schema.prisma`。
- `M server/app.js`。
- `M shared/accountPermissions.js`。
- `?? prisma/migrations/20260823000001_employee_profile/`。
- `?? server/employee-profile.js`。

不要把这些文件视为同一来源已 Review 的原子提交；下一轮必须先检查 diff 和文件修改时间。

### 3.2 技术栈

- Frontend：React 18、Vite 6、Tailwind CSS、Playwright WebKit。
- Backend：Node.js 22、Express 5。
- Database：PostgreSQL 16、Prisma 6.19.3。
- Production：Docker + Nginx，北京公网 `https://buducandy.cn`。
- 业务金额：整数分；业务日期：Asia/Shanghai。

### 3.3 Database / Migration

#### `20260822000001_wechat_pay_reconciliation`

| 字段 | 状态 |
|---|---|
| Created | YES |
| Local | UNKNOWN（本机未配置 `DATABASE_URL`） |
| Test | APPLIED（隔离 schema） |
| Production | APPLIED |

#### `20260823000000_wechat_binding_security`

| 字段 | 状态 |
|---|---|
| Created | YES |
| Local | UNKNOWN（本机未配置 `DATABASE_URL`） |
| Test | APPLIED（隔离 schema） |
| Production | APPLIED |

#### `20260823000001_employee_profile`

| 字段 | 状态 |
|---|---|
| Created | YES（未跟踪文件） |
| Local | UNKNOWN（本机未配置 `DATABASE_URL`；未执行本地 migrate status） |
| Test | APPLIED（`npm run test` 的一次性 PostgreSQL schema；之后已清理） |
| Production | **NOT APPLIED** |

整体状态：Repository 28 migration；Production 27 APPLIED、0 failed，latest = `20260823000000_wechat_binding_security`；生产 `employees` 表 NOT PRESENT。

### 3.4 配置 / Feature Flag（只记录状态）

| 配置 | Production 状态 |
|---|---|
| `APP_ENV` | `prod` |
| `DATA_STORE` | `file` |
| `DATA_DIR` | CONFIGURED |
| `PUBLIC_BASE_URL` | CONFIGURED |
| 企业微信 Corp/Agent/Secret/Recv Token/Recv AES Key | CONFIGURED |
| `EMPLOYEE_SENSITIVE_KEY` | **NOT CONFIGURED** |
| `PAYMENT_MODE` | `mock` |
| `WECHAT_PAY_ENABLED` | `0`（关闭） |
| 微信支付密钥/证书 | UNKNOWN；因功能关闭，本轮未读取 |
| Sentry / COS | UNKNOWN；本轮未核验 |

### 3.5 已执行测试（当前工作树）

| 命令 / Gate | 结果 |
|---|---|
| `npx prisma validate` | PASS |
| `npm run test` | PASS 27 / FAIL 0 |
| 28 migrations → 隔离 PostgreSQL schema | APPLIED；测试后清理 |
| `npm run build` | PASS |
| `npx playwright test` | PASS 34 / 34 |
| `npm run test:ssr` | **FAIL**：`StoreEntryPage missing: 选择值班人员（可多选）` |
| 员工档案专项 API/权限/加密测试 | NOT PRESENT / NOT TESTED |
| 员工档案前端测试 | NOT PRESENT / NOT TESTED |

## 4. Production 状态

| 参数 | 当前事实 |
|---|---|
| Production Modified | **YES**（本轮历史中已迁移数据库并多次受控切流；本次生成交接文件仅做只读核实） |
| 环境 | 北京生产，`https://buducandy.cn` |
| 公网 Git SHA | `49262ad` |
| 部署状态 | `budu-prod-49262ad-api` healthy；Nginx 当前上游明确指向该容器 |
| Health Check | HTTP 200，`ok=true`、`env=prod`、`appVersion=V2.19`、`gitSha=49262ad` |
| Migration | 27 APPLIED / 0 failed；员工档案 NOT APPLIED |
| 支付 | mock；真实微信支付关闭 |
| 最近日志 | 最近 30 分钟关键 error/fatal/unhandled 匹配数为 0 |

生产运维不一致风险：

- 公网 SHA `49262ad` 比当前 Branch HEAD 少 2 个提交；`09d25d9` 门店业绩修复未部署。
- `/opt/budu/.current-sha` 仍记录 `2d70da1...`，与公网 `49262ad` 不一致。
- `/opt/budu` 服务器工作树仍为 `26ff356...`，不是公网镜像源码状态。
- 北京保留多个旧 API/恢复容器；尚未收敛为单一可重复 Compose 拓扑。
- `/api/health.dbOk` 只表示数据库配置存在，不是真实 SQL readiness；生产 migration 状态已另用只读 SQL 核实。

## 5. 未解决问题

### 当前 Bug / 测试失败

1. `npm run test:ssr` 失败：StoreEntryPage 缺少 smoke test 期待的“选择值班人员（可多选）”文本。尚未判断是产品文案变更还是测试过期。
2. 员工档案没有专项测试；通用测试 PASS 不能证明该 Router 正确。

### 未完成代码

3. 员工档案前端与导航不存在。
4. 员工档案没有旧 Staff/账号数据 backfill、employeeNo 分配和对账方案。
5. 新 Router/Schema/migration/权限均未提交、未 push。
6. 生产缺少 `EMPLOYEE_SENSITIVE_KEY`，敏感字段读写会 fail-closed。

### 架构与安全风险

7. Manager 默认获得员工档案模块且当前可查看全部员工资料；是否符合隐私最小权限 UNKNOWN，必须 Review。
8. Router 直接操作 Prisma，调店/调岗/状态历史与主记录更新存在多步骤非事务写入，部分成功风险未测试。
9. `logAudit()` 捕获审计写入错误后继续业务，敏感 reveal 是否允许审计 fail-open 必须决策。
10. EmployeeDocument 设计为 base64 写 PostgreSQL；容量上限、恶意文件、备份膨胀和访问审计未完成 Gate。
11. 状态、用工类型等使用 String，数据库未加枚举/Check Constraint；非法值风险未测试。
12. Employee `userId` 当前不是数据库外键；与 JSON User/Staff 的权威关系和解绑语义 UNKNOWN。

### 数据兼容 / 生产风险

13. 生产没有 Employee 表；不得让前端或现有流程依赖未迁移模型。
14. 本地 migration 状态 UNKNOWN；测试仅证明 migration 可在隔离 schema 从零顺序应用。
15. 当前生产拓扑和 `.current-sha`/服务器工作树不一致，标准 `scripts/deploy-remote.sh` 可能校验或回滚到错误目标。
16. 当前工作区正被其他进度修改；文件来源和原子提交边界需再次确认。

## 6. 下一步建议

### NEXT STEP

**先只处理一个动作：核对并修复 `StoreEntryPage.jsx` 与 `scripts/smoke-render.mjs` 的 SSR 断言不一致，然后运行 `npm run test:ssr` 恢复绿色基线。**

SSR 恢复后，下一轮再按以下顺序推进员工档案：

1. 阅读本文件及第 2.1 节列出的文件，重新执行 `git status`，确认没有新的并发改动。
2. 对员工档案权限、隐私范围、审计 fail-open、事务边界、附件容量和 userId 关联做代码 Review。
3. 补专项测试：加解密/掩码、缺密钥 fail-closed、角色与本人范围、reveal 审计、写入事务、附件权限、API 端到端。
4. 在隔离 PostgreSQL 中从生产备份副本演练 migration，并验证 10 张表、索引、FK 和回滚方案。
5. 设计并实现前端页面/导航；运行 `npm run test`、`npm run test:critical`、`npm run test:ssr`、`npm run build`、Playwright。
6. 只有全部 Gate 通过并完成 Secret 配置/备份/回滚审查后，才可请求员工档案生产 migration 与部署授权。

## 7. DO NOT

- 不要 reset、stash、discard、覆盖或自动提交当前 DIRTY 工作树。
- 不要重复创建 `20260823000001_employee_profile` migration。
- 不要把员工档案 migration 应用到生产；当前明确 NOT APPLIED 且 Gate 未通过。
- 不要部署当前 HEAD/工作树；SSR 失败且存在未提交代码。
- 不要写入、打印或提交真实身份证号、银行卡号、密码、Token、Secret、完整 `DATABASE_URL` 或 SSH 私钥。
- 不要用真实员工敏感数据做自动化测试。
- 不要临时生成弱 `EMPLOYEE_SENSITIVE_KEY` 后直接上线；密钥托管、备份、轮换和恢复必须先设计。
- 不要开启真实微信支付；保持 `PAYMENT_MODE=mock`、`WECHAT_PAY_ENABLED=0`。
- 不要擅自修改工资计算规则、现有角色枚举或 Staff/User 权威数据源。
- 不要删除北京旧容器、恢复库、备份或数据卷；生产拓扑尚未收敛。
- 不要直接运行现有标准部署脚本，直到它能识别公网 `49262ad` 与恢复数据库拓扑并有正确回滚目标。

## 8. 新窗口接续

新 Agent 开始时必须先运行：

```bash
git status --short --branch
git log -5 --oneline --decorate
git diff -- prisma/schema.prisma server/app.js shared/accountPermissions.js
```

然后读取：

- `SmartSteer_Status.md`
- `CURRENT_ARCHITECTURE.md`
- `server/employee-profile.js`
- `prisma/migrations/20260823000001_employee_profile/migration.sql`
- `src/components/StoreEntryPage.jsx`
- `scripts/smoke-render.mjs`

任何生产读取只输出状态，不输出 Secret；任何生产写入必须重新获得明确授权。
