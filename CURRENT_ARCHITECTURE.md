# BUDU 当前架构事实文档（CURRENT ARCHITECTURE）

> **本文档为 BUDU 系统当前事实的唯一权威架构说明。**
> 仓库内其他历史架构文档（如 `docs/ARCHITECTURE_ANALYSIS.md` 及早期设计文档）**仅供历史参考**，其中关于数据源、权限、部署的描述可能已过时，一律以本文档为准。
> 本文档只描述**当前代码可验证的事实**，不描述未来目标、理想架构或推测状态。

- **基线提交 SHA**：`c396c997d523d0009bb05ee10f2f8e06e446478a`（main 分支 HEAD）
- **文档更新时间**：2026-08-21 04:40 CST
- **适用版本**：V2.19（`server/changelog.js`、`src/data/changelog.js` 中最新版本号）

---

## 1. 技术栈

### 前端
- **框架**：React 18.3 + Vite（构建）+ Tailwind CSS（`tailwind.config.js` / `src/index.css`）
- **路由/视图**：单页应用，`src/components/Dashboard.jsx` 按 `view` state 分发（非 react-router；`window.location.hash` 仅用于 POS 直达）
- **状态**：React hooks + `src/utils/userData.js`（本地缓存/镜像层，见第 3 节）
- **图表**：recharts 2.15（`ChannelChart`、`RevenueTrendChart` 等，懒加载分包）
- **PWA**：`public/manifest.webmanifest` + `public/sw.js`
- **界面文案**：`src/utils/text.js`（中文界面文本格式化，保留 `t('...')` 调用语义；**不再维护语言状态/英文词典**，`src/i18n` 已不存在）
- **扫码**：`@zxing/browser` + `@zxing/library`（`CameraScanner.jsx`）
- **图片生成**：`html-to-image`（工资条图片附件等）
- **Sentry**：`@sentry/react`，`src/main.jsx` 中 **`VITE_SENTRY_DSN` 配置后初始化**

### 后端
- **框架**：Node.js + Express 5（`server/index.js` 入口，`server/app.js` 组装路由）
- **认证**：账号密码 + httpOnly Cookie + JWT（`jsonwebtoken`）
- **Auth 工具**：`server/auth.js` 提供密码哈希（scrypt）、JWT 签发/校验等 **Auth utility**；**注册/登录/账号管理路由位于 `server/app.js`**（`/api/auth/register`、`/api/auth/login`、`/api/auth/me`、`/api/admin/users` 等）
- **数据库**：PostgreSQL + Prisma 6（`server/pg.js`，`prisma/schema.prisma`）
- **KV/JSON 存储**：Upstash Redis 或本地 JSON 文件（`server/store.js`，见第 3 节）
- **Sentry**：`@sentry/node`，`server/index.js` 中 **`SENTRY_DSN` 配置后初始化**
- **OCR**：腾讯云 OCR SDK（`server/ocr.js`）
- **对象存储**：腾讯云 COS（`cos-nodejs-sdk-v5`，`server/asset-storage.js`，**配置后启用**，见第 6 节）

### 部署
- **容器**：Docker（`Dockerfile` 多阶段构建 node:22-alpine）
- **编排**：docker compose（`docker-compose.yml`）
- **Web 服务器**：Nginx（配置在仓库 `deploy/nginx/`，含 `conf.d/` 与 `entrypoint.sh`）
- **CI/CD**：GitHub Actions **手动部署 Workflow**（`.github/workflows/deploy-test.yml` → HK 测试环境；`deploy-prod.yml` → 北京生产预备环境），均以 `workflow_dispatch` **手动触发**，非自动 CI；`scripts/deploy-remote.sh` 为部署执行脚本
- **环境**：`APP_ENV`（dev/test/prod）+ 各环境 `.env.*` 文件（本地 `.env.local`）

---

## 2. 模块清单

### 后端模块（`server/*.js`）
| 文件 | 职责 |
|---|---|
| `index.js` | 服务入口、Sentry 初始化（配置后）、启动 |
| `app.js` | 路由装配、认证中间件、模块授权中间件（`requireModule`）、`/api/userdata` 读写、`/api/health`、账号管理、门店、分析上传/删除 |
| `auth.js` | 密码哈希（scrypt）、JWT 签发/校验等 Auth utility |
| `store.js` | KV/JSON 权威数据（用户、门店、员工、排班、业绩录入兼容镜像、分析、商品图等） |
| `pg.js` | PostgreSQL 连接（Prisma Client 单例）与 `dbReady()`（仅检查 `DATABASE_URL` 是否存在） |
| `pos.js` / `pos-core.js` | POS 点单：订单、支付、订单快照计算（PostgreSQL） |
| `payment-callbacks.js` | 支付回调（POS 支付状态回写） |
| `order-state.js` | 订单状态机 |
| `approvals.js` / `approvals-core.js` | 审批中心：模板、单据、节点、抄送、附件、通知 |
| `notification-center.js` / `notifications.js` | 通知中心：站内消息、投递记录、微信个人通道适配器（配置后启用） |
| `wechat-bind.js` | 微信扫码绑定（企业微信/公众号，配置后启用）+ 接收消息验证端点 |
| `wechat-alert.js` | 企业微信群机器人告警（`sendWechatMarkdown`，通知中心 `broadcast` 收口） |
| `payroll-notice.js` | 工资条发放：已发放工资条快照的持久化、签收、查询（PostgreSQL） |
| `products.js` | 商品主档（PostgreSQL InventoryItem，POS 与商品中心共用） |
| `v2.js` | `/api/v2` 业务接口：员工镜像、库存申请、发票、邮寄、调货、采购、日薪调整、大单奖、告警等（**资产接口不在本文件**） |
| `asset-center.js` / `asset-storage.js` / `asset-reminders.js` | 档案馆：文件、分类、版本、访问授权、到期提醒、COS 存储适配 |
| `daily-entry-upgrade.js` | 门店业绩录入（PostgreSQL DailyEntry/DailyStoreStaff/DailyEntryAuditLog）与兼容同步 |
| `analysis.js` | **Excel/分析文件解析相关逻辑**（读取商家报表 xlsx，映射门店/员工名称等），非运行中的经营分析聚合服务 |
| `productCategories.js` | 商品分类常量 |
| `config.js` / `fixedOptions.js` / `changelog.js` / `store-names.js` | 配置/固定选项/版本变更日志/门店名同步 |

### 前端页面组件（`src/components/*.jsx`，按需懒加载）
`Dashboard`（入口分发）、`LoginPage`、`PersonnelPage`、`PayrollPage`、`StoreEntryPage`、`SchedulePage`、`StoreMailingPage`、`PosPage`、`OrderRecordsPage`、`ProductCenterPage`、`InventoryRequestPage`、`FinancePage`、`InvoicePage`、`ApprovalCenterPage`、`AssetCenterPage`、`SettingsPage`、`AccountAdminPage`、`BusinessAnalysisPage`、`HomeWorkspace` 等；共享：`Sidebar`、`Header`、`NotificationBell`、`MobileBottomNav`、`AccountMenu`、`PayrollSlipCard/Modal`、`approval/*` 系列。

### 工具/共享
- `shared/accountPermissions.js`：角色常量、模块权限定义与判定（前后端共享）
- `src/utils/*`：selectors（业务选择器）、userData（本地缓存/镜像）、api、pos、payrollSlip、inventoryAlerts（铃铛轮询聚合）、schedule、productExcel、text 等
- `scripts/`：`deploy-remote.sh`（部署）、`migrate-kv-to-pg.mjs`（KV→PG 迁移，见第 3 节 Analysis）、`backup-kv.mjs` / `backup-pg.sh`（备份脚本，见第 7 节）、各类测试脚本

---

## 3. 数据源地图

> 图例：**权威源**（数据最终归属与正式读取路径）｜**兼容层/镜像**（同一数据的另一表示，仅兼容读或降级用）｜**缓存**（可丢失、可重建）｜**配置后启用**（依赖环境变量）｜**迁移准备/计划中**（尚未成为正式读取源）

### User（账号）
- **权威源**：KV/JSON（`server/store.js` → Upstash `budu-db` 或本地 `db.json` 的 `users[]`）
- **兼容/镜像**：Prisma `User` 模型存在于 `prisma/schema.prisma`（迁移目标）；**当前运行时无任何业务代码实际调用 `prisma.user`**（Model 存在 ≠ 运行时使用）；登录/权限/账号管理全部走 `store.js`（`server/app.js` 的 `loadDb().users`）
- **迁移状态**：`scripts/migrate-kv-to-pg.mjs` 提供迁移能力，但**当前运行仍以 KV/JSON 为权威**

### Staff（员工主档）——多源兼容合并
- **可编辑员工主档权威源**：KV/JSON `staff[]`（`server/store.js`），`/api/userdata` 下发与 `PUT /api/userdata`（staff 字段）写入；前端 `commitStaff()`（`src/utils/userData.js`）先写本地缓存并同步 KV（`syncUserData`），随后尝试镜像 PG
- **PG 镜像**：`PUT /api/v2/staff`（`server/v2.js`，注释原文："员工名单镜像：KV 员工 → PostgreSQL Staff 表"）——先删除后批量插入 PG `Staff` 表；**PG 写入失败被前端 `commitStaff` 的 catch 忽略，不阻断 KV 写入**（"PostgreSQL 不可用时仅同步 KV"）
- **运行时员工列表**（`src/utils/selectors.js` `employeeList()`）存在**多源兼容合并**，按代码顺序为：
  1. `analysisEmployees()`（Analysis 员工数据）或 `analysisEmployeeMonthly(monthKey)`（按月），**兜底 `BASE_EMPLOYEES`（`src/data/baseEmployees.js` 静态主档）**
  2. `localStaffList()`（KV staff，经 userData），标记 `local: true`
  3. 合并顺序（`[...source, ...local]` 按姓名 `Map`，后者覆盖前者）：**先以 Analysis 员工列表或 BASE_EMPLOYEES 静态兜底作为基础集合，再以 KV Staff（local）按同名员工覆盖/合并**；最终过滤已删除员工（`removedStaff`）。即优先级为：**KV Staff > Analysis 员工 > BASE_EMPLOYEES 静态兜底**（同名时 KV Staff 生效）
- **结论**：**PG `Staff` 当前不是正式运行时权威读取源**，更接近**单向镜像 / 迁移准备层**；当前不存在完整的正式 PG Staff 主读取链路

### Schedule（排班）——区分周排班与按日值班
- **周排班权威源**：KV/JSON `schedules{}`（`server/store.js`，结构 `schedules[周一起始日期][门店key][日期] = [{staff, time?, note?}]`），经 `/api/userdata` 读写
- **按日实际值班**：PostgreSQL `DailyStoreStaff`（`prisma/schema.prisma`）——承担**按日实际值班、工时、出勤等实际记录**，不等同于周排班表
- **当前状态**：周排班（KV schedules）与 `DailyStoreStaff`（PG）之间**尚无完整统一的 Schedule ID 闭环**
- **兼容字段**：`DailyEntry.staffNames` 属于**兼容/历史快照字段**（`server/daily-entry-upgrade.js` 同步 `staffNameSnapshot` 镜像），**不是完整排班权威源**

### DailyEntry（门店业绩录入）——PG 权威方向 + 兼容双写
- **权威方向**：PostgreSQL `DailyEntry` / `DailyStoreStaff` / `DailyEntryAuditLog`（`server/daily-entry-upgrade.js`，`prisma.dailyEntry` 等）——**设计上的主要读取方向/权威方向**
- **兼容双写仍存在**：`src/utils/userData.js` `commitEntries()` 先写本地缓存 + `syncUserData(['entries'])`（→ `/api/userdata` 的 entries 字段），再逐条 upsert 到 PostgreSQL（`/api/v2/daily-entries`）；`/api/v2/daily-entries` 提供 GET/PUT/DELETE。**因此不能写成"DailyEntry 已经完全 PostgreSQL Only"**
- **`/api/userdata.entries` 目前仍可写**（`PUT /api/userdata` fieldRules 含 entries）
- **一致性风险**：PG 与 KV 的 entries **不是同一数据库事务**；若 PG 查询返回空数组，前端兼容逻辑可能**不会完全清除已有 KV Entry 镜像**，旧 KV 数据可能继续显示
- **localStorage**：`src/utils/userData.js` 使用 `localStorage`（如 `budu-os-store-entries-v1`）与内存缓存——定位为**缓存/镜像**，**不是业务权威数据源**；账号隔离通过缓存键与登录账号关联（按代码实际为准）

### Analysis（经营分析）
- **权威源**：KV/JSON `analysis{}`（`server/store.js`）——**当前未迁移 PostgreSQL**；`scripts/migrate-kv-to-pg.mjs` **没有正式迁移 `db.analysis`**，因此不能写"Analysis 已迁移 PostgreSQL"
- **写入路径**：`POST /api/analysis/upload`（`server/app.js`，`requireModule(ANALYSIS)` + `requireManager`）、`DELETE /api/analysis`——**不是**通过 `PUT /api/userdata` 写入（`PUT /api/userdata` 的 fieldRules **不含 analysis**）
- **读取**：`/api/userdata` 下发 `analysis` 供前端读取（`src/utils/userData.js` `getAnalysis()`）；`server/analysis.js` 仅承担 **Excel/分析文件解析**（商家报表 xlsx → 门店/员工映射），**不是正式运行中的经营分析聚合服务**

### POS（点单/订单/支付）
- **核心权威数据域**（PostgreSQL）：`InventoryItem`（商品）、`Order`、`OrderItem`、`Payment`、`Refund`、`RefundItem`、`PaymentLog`（`server/pos.js`、`pos-core.js`、`payment-callbacks.js`、`order-state.js`；`server/products.js` 管理商品主档）
- **不属于 POS 核心域的模型**（分属其他业务域）：
  - `StockBalance` / `StockLedger` / `PurchaseItem` / `TransferItem` → **Inventory（库存）域**（`server/v2.js` 采购/调货写入）
  - `WasteRecord` → **Inventory/损耗**域
  - `Expense` → **Finance（财务）**域
  - `Member` / `MemberConsumption` → **Member（会员/CRM）**域
- **当前事实**：**POS 尚未完成"销售后自动扣库存 / 自动形成销售库存流水"的闭环**——`pos.js`/`pos-core.js`/`order-state.js` 中无销售触发 `StockBalance`/`StockLedger` 写入逻辑（不要把未来计划写成现状）
- **前端会话缓存**：`sessionStorage`（购物车/待支付单/结算 key，`src/utils/pos.js`）——可丢失

### Inventory（库存申请/调货/采购）
- **权威源**：PostgreSQL `TransferRequest`/`TransferItem`/`PurchaseRequest`/`PurchaseItem`/`Supplier`（`server/v2.js`）
- **兼容层**：KV/JSON `inventoryRequests[]`、`inventory[]`（`server/store.js` 中均为**数组**，旧数据/降级）；前端 `src/utils/inventoryAlerts.js` 轮询聚合
- **库存余额/流水**：PostgreSQL `StockBalance`/`StockLedger`（采购入库等写入）
- **跨门店能力**：`hasInventoryTransferAll`（`shared/accountPermissions.js`）在**调货模块权限**基础上扩展调货门店范围（详见第 5 节）

### Payroll（工资）——区分"工资计算"与"工资条发放"
- **工资计算**：当前主要由**前端 selector/计算逻辑**（`src/utils/selectors.js`、`src/utils/payrollSlip.js`）结合多种输入完成：
  - PG `DailyEntry`（业绩录入/经营快照）
  - KV/静态员工数据（staff、`BASE_EMPLOYEES`）
  - PG `BigOrderBonus`（大单奖）、PG `DailyPayAdjustment`（日薪调整）——**两者均为 PostgreSQL**
  - 当前工资规则（节假日/调休标记见 `src/utils/payroll.js`）
- **工资条发放**：`PayrollNotice`（PostgreSQL，`server/payroll-notice.js`）只代表**已经正式发放的工资条快照**（含每日明细与汇总），**不是整个工资计算系统的唯一权威源**
- **结论**：不要将"工资计算"与"工资条发放"混为一个数据源

### Approval（审批中心）
- **权威源**：PostgreSQL：`ApprovalTemplate`/`ApprovalRequest`/`ApprovalNode`/`ApprovalCc`/`ApprovalAttachment`/`ApprovalComment`/`ApprovalLog`/`ApprovalNotification`（`server/approvals.js`）
- **通知**：`approval_notifications`（旧站内通知，兼容保留）+ 通知中心 `notifications`（**双写**，见第 8 节）

### Notification（通知中心）
- **权威源**：PostgreSQL：`NotificationTemplate`/`Notification`/`NotificationDelivery`/`WechatBinding`（`server/notification-center.js`、`notifications.js`、`wechat-bind.js`）
- **通道**：inapp（站内，权威）+ wechat（企业微信/公众号**个人**提醒，`WXWORK_*`/`MP_*` 环境变量**配置后启用**，未配置时投递标记 `skipped`）+ wecom（企业微信**群**机器人广播，走 `wechat-alert.js`）
- **前端聚合**：`src/utils/inventoryAlerts.js` 8 秒轮询：调货/采购/发票/邮寄/资产/工资条/审批/通知中心多源合并（**兼容层**）

### 资产（档案馆）
- **权威源**：PostgreSQL `AssetFile`/`AssetCategory`/`AssetFileVersion`/`AssetAccessGrant`/`AssetOperationLog`/`AssetReminder`
- **路由实现**：资产相关路由（config/categories/overview/files/reminders 等）由 **`server/asset-center.js`** 实现，经 `assetCenterRouter` 挂载至 `/api/v2` API 空间（`server/app.js` 的 v2 路由组）——**URL 前缀（/api/v2/asset-center/...）与实现文件（asset-center.js）需区分，不要误认为由 `v2.js` 实现**
- **文件内容**：腾讯云 COS（`server/asset-storage.js`，`COS_BUCKET/REGION/SECRET_ID/SECRET_KEY` **配置后启用**；未配置则 dataUrl 直接入库）

### 发票 / 邮寄 / 大单奖 / 日薪调整
- **权威源**：PostgreSQL：`Invoice`/`InvoiceCompany`、`MailingRecord`、`BigOrderBonus`、`DailyPayAdjustment`/`DailyPayAdjustmentAuditLog`（`server/v2.js` 等）

---

## 4. `/api/userdata` 与 `/api/v2` 职责边界

### `/api/userdata`（`server/app.js`）
- **GET**：下发 KV/JSON 共享数据（按角色/绑定门店裁剪，`scopeUserData`；收银员仅返回 POS 最小集）：entries、staff、removedStaff、analysis、productImages、stores、schedules、products、inventoryRequests、inventory
- **PUT**：**仅允许修改以下字段**（`fieldRules` + 模块授权校验）：`entries`、`staff`、`removedStaff`、`productImages`、`stores`、`schedules`、`products`、`inventoryRequests`、`inventory`——**analysis 不在可写字段内**
- **定位**：既是读取层，也是**部分旧业务的真实写入口**（entries/staff/schedules 等仍在走 PUT /api/userdata），**不是"纯废弃兼容读取层"**
- **前端**：`loadUserData()`（`src/utils/userData.js`）启动拉取 → 本地缓存（localStorage/内存），selectors 读取

### `/api/v2`（`server/app.js`）
- **职责**：**结构化业务接口**——POS（订单/支付/商品）、审批、工资条、调货/采购/发票/邮寄/资产、库存余额、通知中心、微信绑定、业绩录入升级、商品中心、员工镜像、日薪调整、大单奖、告警测试
- **鉴权**：`requireAuth` → POS 对收银开放 → `requireBusiness`（收银员拒绝业务接口）→ 各路由 `requireModule` 按模块授权
- **原则**：凡涉及 PG 数据的业务走 v2；KV 共享数据仍走 userdata（存在重叠写入口，见第 8 节风险）

---

## 5. 六角色、版块授权与门店数据范围

- **角色**（`shared/accountPermissions.js` `ACTIVE_ROLES`）：
  `developer`（开发者）｜`admin`（管理员）｜`finance`（财务）｜`manager`（店长）｜`staff`（员工）｜`cashier`（门店收银）｜另有 `public`（**停用状态**：`status` 默认为 `disabled`，登录中间件对 `role === 'public'` 直接返回 403"账号已停用"——**不是当前可正常登录的展示角色**）
- **Developer**：固定拥有**全部模块**（`normalizeModules` 对 developer 直接返回全 true，不受账号级调整影响）；拥有**完整账号治理能力**——可创建/管理账号、角色、模块/功能授权。代码事实：账号管理接口使用中间件 **`requireAccountAdmin`**（`server/app.js`，实现为 `user.role !== 'developer'` 即拒绝，"仅开发者可管理账号与授权"）；注意业务事实（仅 Developer 可治理账号）与代码中间件名称（`requireAccountAdmin`）是两个层面，文档分别表述。另有 `requireDeveloper` 中间件（developer/finance/admin 均通过）用于门店创建等业务接口
- **Admin / Finance**：默认拥有较完整模块权限（`defaultModuleKeys` 默认全模块）；但**不等于与 Developer 完全相同**——其模块权限经 `normalizeModules` 支持按账号调整/撤销（`source ? source[key] === true : defaults.has(key)`），且**不具备 Developer 专属的账号治理能力**
- **Manager / Staff**：可见能力由 **账号模块授权（`user.permissions.modules`）+ 门店绑定（`storeKeys`）+ 数据范围（`scopeUserData`/`storeFilter`）** 共同决定，**不是统一固定全权限**（manager/staff 有各自默认模块集，可被开发者调整）
- **Staff 的 POS 权限**：若账号获得 `store-pos` 模块授权，则**可以实际点单、收款**（`PosPage` 对具备 POS 权限的账号开放），**不是"POS 只读"**
- **Cashier**：绑定**单一门店**（`validateCashierRole`：必须且仅绑定一家门店、不绑定员工）；模块权限固定为 **仅 `store-pos`**（`normalizeModules` 对 cashier 固定 POS）；POS 点单范围 = 绑定门店
- **调货跨门店权限（inventoryTransferAll）**：`hasInventoryTransferAll`（`shared/accountPermissions.js`）**不是脱离模块授权独立可用的完整功能**——调货路由仍受调货**模块权限**约束（`/api/v2` 统一中间件 `requireAnyModule([INVENTORY_TRANSFER])`，见 `server/app.js`）；`inventoryTransferAll` 仅**扩展调货业务的门店范围/跨门店能力**（`server/v2.js` 中 `sf = hasInventoryTransferAll(user) ? null : storeFilter(user)`，有该权限则不受绑定门店限制）。即：模块权限是基础授权条件，inventoryTransferAll 是调货范围内门店范围的扩展
- **工资条权限**（`server/payroll-notice.js`）：超管（developer/finance/admin）全量；其余仅本人（绑定员工或 targetUsername）；发放仅超管；签收仅本人（开发者可代签）
- **审批权限**（`server/approvals-core.js`，以 `can*` 函数为准）：
  - **草稿**：创建人（提交人）**可编辑、可删除自己的草稿**（`canDelete` = 草稿状态且（超管 或 提交人））；超管也可删除任意草稿
  - **已驳回**：提交人可编辑并**重新提交**（`canEdit`/`canSubmit` 允许 rejected → pending）
  - **待审批**：仅审批人可**通过/驳回**（`canDecide` = isApproverFor + pending）；提交人可**撤回**（`canWithdraw` = pending 且提交人）
  - **已通过/已驳回**：仅超管可**归档**（`canArchive` = isSuperUser）
  - **结论**：普通申请提交人**可以删除自己的草稿**，不是"删除草稿仅超管可执行"

---

## 6. Docker / Nginx / PostgreSQL / Upstash / COS / GitHub Actions 现状

- **Docker**：`Dockerfile` 多阶段（node:22-alpine，builder 构建前端 dist + server）；`docker-compose.yml` 编排 api/postgres（+ nginx 反代）；部署经 GitHub Actions SSH 到服务器执行 `deploy-remote.sh`
- **Nginx**：配置在仓库 **`deploy/nginx/`**（`conf.d/` + `entrypoint.sh`），反代前端静态资源与 `/api` → 应用容器；健康检查通过 `docker compose exec api wget 127.0.0.1:3000/api/health`
- **PostgreSQL**：业务权威库（POS/审批/工资条/通知/资产/发票/邮寄/库存流水等）
- **`dbOk`（`server/pg.js` `dbReady()`）**：**仅检查 `process.env.DATABASE_URL` 是否存在**（`Boolean(process.env.DATABASE_URL)`），**不代表已验证数据库真实连接成功**
- **Upstash Redis**：`server/store.js` `redisConfig()`——配置 `KV_REST_API_URL/TOKEN` 或 `UPSTASH_REDIS_REST_URL/TOKEN` 时启用；**未配置时降级本地 JSON 文件**（`DATA_DIR/db.json`）
- **COS**：`server/asset-storage.js`——`COS_BUCKET/REGION/SECRET_ID/SECRET_KEY` **配置后启用**（可选存储模式）；未配置则资产 dataUrl 直接入库
- **微信个人提醒**：`WXWORK_*`（企业微信）或 `MP_*`（公众号）环境变量**配置后启用**；未配置时通知中心微信投递记录 `skipped`
- **Sentry**：`SENTRY_DSN` / `VITE_SENTRY_DSN` **配置后初始化**（`server/index.js`、`src/main.jsx`）
- **GitHub Actions**：`deploy-test.yml`（HK 测试）、`deploy-prod.yml`（北京生产预备）均为 **`workflow_dispatch` 手动触发**的**手动部署 Workflow**（非自动 CI）；密钥存 GitHub Secrets（`TENCENT_SSH_KEY` 等）

---

## 7. 备份、健康检查、Sentry、企微告警现状

- **备份脚本（仓库内存在）**：
  - `scripts/backup-kv.mjs`（KV/JSON 导出）
  - `scripts/backup-pg.sh`（每日 PostgreSQL 备份，注释声明"保留 7 天"，`find -mtime +7 -delete`）
  - **仅说明仓库存在备份脚本；无法从仓库证明服务器 Cron 定时任务已真实启用**
  - 部署流程内置迁移前 PG 备份（`deploy-remote.sh`）
- **健康检查**：`GET /api/health`（`server/app.js`）返回 `{ ok, time, env, appVersion, gitSha, dbOk }`；`dbOk` 语义见第 6 节；部署脚本 `wait_healthy` 轮询
- **Sentry**：前端 `@sentry/react` + 后端 `@sentry/node` 均已**接入代码**，DSN 配置后启用（见第 6 节）；ErrorBoundary 上报前端错误
- **企微告警**：`server/wechat-alert.js` `sendWechatMarkdown`（企业微信群机器人 webhook，`WECHAT_WORK_WEBHOOK_URL` 或代码 fallback）；多个业务流程（库存预警/调货/采购/发票/邮寄/资产到期等）通过通知中心 `broadcast()` 收口兼容通知；另有 `/v2/alerts/test` 测试接口与设置页"发送测试消息"

---

## 8. 已知双写与数据一致性风险

1. **KV 整库覆盖风险**：`server/store.js` 对 KV/JSON 采用**整库读写**（loadDb 全量加载、persist 整库写回），多并发写入存在覆盖风险
2. **Staff 镜像失败被忽略**：`commitStaff()`（`src/utils/userData.js`）KV 写入优先，PG 镜像（`PUT /api/v2/staff`）失败被 catch 忽略——存在 **KV/PG Staff 镜像不一致**风险
3. **DailyEntry 非事务双写**：`commitEntries()` 写 KV（`/api/userdata`）+ 逐条 upsert PG（`/api/v2/daily-entries`），**不是同一数据库事务**——KV/PG 之间可能短暂或长期不一致
4. **PG 空结果与 KV 镜像残留**：PG 查询返回空数组时，前端兼容逻辑可能**不会完全清除已有 KV Entry 镜像**——旧 KV 数据可能继续显示
5. **审批通知双写**：`server/approvals.js` 同时写 `approval_notifications`（旧表，兼容接口 `/v2/approvals/notifications`）与通知中心 `notifications`——两表独立、无事务联动，异常时可能不一致（旧表仅兼容用途，权威为通知中心）
6. **Store 多源并存**：门店数据可能同时存在于**静态门店配置（`BASE_STORES`，`src/data/baseStores.js`）、KV `stores[]`、PostgreSQL `Store`**——多源并存风险
7. **KV ↔ PG 迁移中**：`store.js`（users/staff/schedules/analysis/entries 兼容层）与 PG（DailyEntry 已升级）并存；`migrate-kv-to-pg.mjs` 提供迁移/对账能力，但**未全量完成**，存在同一业务两种读路径的风险
8. **POS 会话**：购物车/待支付单存 `sessionStorage`（可丢失）；订单/支付以 PG 为准
9. **资产文件**：COS 与 dataUrl 双模式，未配置 COS 时大文件直接入库（DB 膨胀风险）
10. **工资条快照缺少服务端完整重算校验**：后端在工资条发放（`server/payroll-notice.js` POST /payroll-notices）过程中，**仅验证请求结构、periodKey 格式、snapshot 形状与 totalCents 为非负整数**，**没有基于服务器端完整工资规则重新计算并独立校验客户端提交的工资快照**。因此：如果客户端使用旧规则、数据被错误计算、数据被篡改，或前端逻辑与后端规则不同步，就可能生成错误的已发放工资条快照（PayrollNotice 以客户端提交的快照为准入库）。真正的技术整改（服务端完整重算与交叉校验）属于后续独立 Task，本文档仅记录风险
11. **前端铃铛多源聚合**：`inventoryAlerts.js` 轮询多个接口合并展示，与通知中心存在重复通知可能（同一事件既走旧业务通知又走通知中心）

---

## 9. 历史文档声明

- 仓库内旧架构文档（`docs/ARCHITECTURE_ANALYSIS.md` 及早期设计/进度文档）**仅供历史参考**，其中描述与当前代码不一致之处（如数据源、角色、部署方式）**一律以本文档为准**。
- 本文档为 BUDU 系统**当前事实的唯一权威架构说明**，后续 V3 设计、开发与 Review 以此为准。

---

## 10. 文档自检（对应 Codex Review 修复验收）

- ✅ 版本号修正为 **V2.19**（基线），全文无过时版本描述
- ✅ Staff：可编辑主档 = KV Staff；运行时多源合并（Analysis 员工 / BASE_EMPLOYEES 兜底 / KV Staff，按姓名合并，顺序按 `selectors.js employeeList`）；PG Staff = 单向镜像/迁移准备层；`commitStaff` KV 优先、PG 失败忽略
- ✅ Schedule：周排班 = KV schedules；DailyStoreStaff = 按日实际值班/工时/出勤；无统一 Schedule ID 闭环；DailyEntry.staffNames = 兼容/历史快照字段
- ✅ DailyEntry：PG = 权威方向；兼容双写仍存在（userdata + v2/daily-entries）；userdata.entries 仍可写；PG 空结果不清 KV 镜像风险；localStorage = 缓存/镜像
- ✅ Analysis：未迁移 PG（migrate-kv-to-pg.mjs 不迁移 db.analysis）；server/analysis.js = Excel/文件解析；写入走 POST /api/analysis/upload、DELETE /api/analysis；userdata 可读但不可 PUT 写
- ✅ Payroll：拆开"工资计算"（前端 selector + PG DailyEntry/经营快照 + KV/静态员工 + PG 大单奖/日薪调整）与"工资条发放"（PayrollNotice = 已发放快照）；DailyPayAdjustment/BigOrderBonus 属 PG
- ✅ 权限：Developer 固定全模块 + 账号治理（中间件 `requireAccountAdmin`，仅 developer）；Admin/Finance 默认较完整但可被按账号调整，无 Developer 治理能力；Manager/Staff 按模块授权+门店绑定+数据范围；Staff 有 POS 授权可实际点单收款；Cashier 单一门店固定 POS；Public 已停用（登录 403）；inventoryTransferAll 是调货模块权限之内的门店范围扩展（非独立功能）；审批提交人可删除自己的草稿（canDelete = 草稿且超管或提交人），已驳回可重新提交、待审批可撤回、已通过/已驳回仅超管归档
- ✅ /api/userdata：区分 GET 读取字段与 PUT 可写字段（9 个，不含 analysis）；非"纯废弃兼容层"
- ✅ POS 核心域 = Product/Order/OrderItem/Payment/Refund/RefundItem/PaymentLog；StockBalance/StockLedger/WasteRecord/Expense/Member 分属 Inventory/Finance/Member 域；明确"销售后自动扣库存闭环未完成"
- ✅ 基础设施：dbOk 仅检查 DATABASE_URL 存在；Sentry/COS/微信 = 配置后启用；GitHub Actions = 手动 workflow_dispatch；备份脚本存在（无法证明 Cron 启用）；Nginx 路径 = `deploy/nginx/`
- ✅ 风险章节：KV 整库覆盖、Staff KV→PG 镜像失败被忽略、DailyEntry 非事务双写、PG 空结果可能残留 KV 镜像、Store 静态（BASE_STORES）/KV/PG 多源、工资条客户端快照缺少服务端完整重算校验
- ✅ 引用修正：`src/utils/text.js`（无 src/i18n）、删除 NotificationPanel、`.env.local`、`docs/ARCHITECTURE_ANALYSIS.md`、auth.js 职责（utility，路由在 app.js）、analysis.js 职责、资产路由由 `server/asset-center.js` 实现并挂载 `/api/v2`（非 v2.js）、inventory 兼容层为数组（inventoryRequests[]/inventory[]）
- ✅ 删除硬编码数量（"13 处 broadcast"等）→ 改为"多个业务流程通过 broadcast/notification 兼容通知"；删除无法稳定证明的 OAuth Scope 限制描述
- ✅ 不包含推测性结论、"应该已经/可能已经迁移"、未来计划写成现状、配置存在写成生产启用、Prisma Model 存在写成运行时权威源
