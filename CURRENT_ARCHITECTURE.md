# BUDU 当前架构事实文档（CURRENT ARCHITECTURE）

> **本文档为 BUDU 系统当前事实的唯一权威架构说明。**
> 仓库内其他历史架构文档（如旧版 `ARCHITECTURE.md`、早期设计文档）**仅供历史参考**，其中关于数据源、权限、部署的描述可能已过时，一律以本文档为准。

- **基线提交 SHA**：`c396c997d523d0009bb05ee10f2f8e06e446478a`（main 分支 HEAD）
- **文档更新时间**：2026-08-21 04:06 CST
- **适用版本**：V2.14（`server/changelog.js`、`src/data/changelog.js` 中最新版本号）

---

## 1. 技术栈

### 前端
- **框架**：React 18.3 + Vite（构建）+ Tailwind CSS（样式，见 `tailwind.config.js` / `src/index.css`）
- **路由/视图**：单页应用，由 `src/components/Dashboard.jsx` 统一按 `view` 分发（非 react-router，基于 state 的视图切换 + `window.location.hash` 兼容 POS 直达）
- **状态**：React hooks + `src/utils/userData.js`（本地缓存层，与 `loadUserData()` 同步）
- **图表**：recharts 2.15（`ChannelChart`、`RevenueTrendChart` 等，懒加载分包）
- **PWA**：`public/manifest.webmanifest` + `public/sw.js`，支持离线壳与安装提示（`PwaInstallPrompt.jsx`）
- **国际化**：`src/i18n`（中/英，当前固定简体中文为主）
- **扫码**：`@zxing/browser` + `@zxing/library`（`CameraScanner.jsx`）
- **图片生成**：`html-to-image`（工资条图片附件等）
- **Sentry**：`@sentry/react`（`src/main.jsx` 初始化）

### 后端
- **框架**：Node.js + Express 5（`server/index.js` 入口，`server/app.js` 组装路由）
- **认证**：账号密码 + httpOnly Cookie + JWT（`server/auth.js`，`jsonwebtoken`）
- **数据库**：PostgreSQL + Prisma 6（`server/pg.js`，`prisma/schema.prisma`）
- **KV/JSON 存储**：Upstash Redis 或本地 JSON 文件（`server/store.js`，见第 4 节）
- **Sentry**：`@sentry/node`（`server/index.js` 初始化）
- **OCR**：腾讯云 OCR SDK（`server/ocr.js`）
- **对象存储**：腾讯云 COS（`cos-nodejs-sdk-v5`，`server/asset-storage.js`，配置后启用）

### 部署
- **容器**：Docker（`Dockerfile` 多阶段构建 node:22-alpine）
- **编排**：docker compose（`docker-compose.yml`）
- **Web 服务器**：Nginx（反代前端静态资源与 API，配置在服务器侧）
- **CI/CD**：GitHub Actions（`.github/workflows/deploy-test.yml` → HK 测试环境；`deploy-prod.yml` → 北京生产预备环境），`scripts/deploy-remote.sh` 为部署执行脚本
- **环境**：`APP_ENV`（dev/test/prod）+ 各环境 `.env.*` 文件（本地 `.env.lo`）

---

## 2. 模块清单

### 后端模块（`server/*.js`）
| 文件 | 职责 |
|---|---|
| `index.js` | 服务入口、Sentry 初始化、启动 |
| `app.js` | 路由装配、认证中间件、`/api/userdata`、`/api/health`、账号管理、门店、分析上传 |
| `auth.js` | 注册/登录/JWT/Cookie |
| `store.js` | KV/JSON 权威数据（用户、门店、员工、排班、业绩录入、分析、商品图等） |
| `pg.js` | PostgreSQL 连接（Prisma Client 单例）与 `dbReady()` |
| `pos.js` / `pos-core.js` | POS 点单：订单、支付、商品、库存流水（PostgreSQL） |
| `payment-callbacks.js` | 支付回调（POS 支付状态回写） |
| `order-state.js` | 订单状态机 |
| `approvals.js` / `approvals-core.js` | 审批中心：模板、单据、节点、抄送、附件、通知 |
| `notification-center.js` / `notifications.js` | 通知中心：站内消息、投递记录、微信个人通道适配器 |
| `wechat-bind.js` | 微信扫码绑定（企业微信/公众号）+ 接收消息验证端点 |
| `wechat-alert.js` | 企业微信群机器人告警（`broadcast`） |
| `payroll-notice.js` | 工资条：发放、签收、快照查询 |
| `products.js` | 商品中心（POS 商品主档，PostgreSQL InventoryItem） |
| `v2.js` | `/api/v2` 业务接口：库存申请、发票、邮寄、资产、调货、采购、分析汇总、告警 |
| `asset-center.js` / `asset-storage.js` / `asset-reminders.js` | 档案馆：文件、分类、版本、访问授权、到期提醒 |
| `daily-entry-upgrade.js` | 门店业绩录入升级（PostgreSQL 持久化） |
| `analysis.js` | 经营分析聚合 |
| `productCategories.js` | 商品分类常量 |
| `config.js` / `fixedOptions.js` / `changelog.js` / `store-names.js` | 配置/固定选项/版本变更日志/门店名同步 |

### 前端页面组件（`src/components/*.jsx`，按需懒加载）
`Dashboard`（入口分发）、`LoginPage`、`PersonnelPage`、`PayrollPage`、`StoreEntryPage`、`SchedulePage`、`StoreMailingPage`、`PosPage`、`OrderRecordsPage`、`ProductCenterPage`、`InventoryRequestPage`、`FinancePage`、`InvoicePage`、`ApprovalCenterPage`、`AssetCenterPage`、`SettingsPage`、`AccountAdminPage`、`BusinessAnalysisPage`、`HomeWorkspace` 等；共享：`Sidebar`、`Header`、`NotificationBell`、`MobileBottomNav`、`AccountMenu`、`NotificationPanel`、`PayrollSlipCard/Modal`、`approval/*` 系列。

### 工具/共享
- `shared/accountPermissions.js`：角色常量与权限判定（前后端共享）
- `src/utils/*`：selectors（业务选择器）、userData（本地缓存）、api、pos、payrollSlip、inventoryAlerts（铃铛轮询聚合）、schedule、productExcel 等
- `scripts/`：`deploy-remote.sh`（部署）、`migrate-kv-to-pg.mjs`（KV→PG 迁移）、`backup-kv.mjs` / `backup-pg.sh`（备份）、各类测试脚本

---

## 3. 数据源地图

> 图例：**权威源**（数据最终归属）｜**镜像/兼容层**（同一数据的另一表示，仅读或降级用）｜**缓存**（可丢失，可重建）｜**迁移状态**（KV→PG 或本地→共享）

### User（账号）
- **权威源**：KV/JSON（`server/store.js` → Upstash `budu-db` 或本地 `db.json` 的 `users[]`）
- **兼容/镜像**：Prisma `User` 模型（`prisma/schema.prisma` line 33）——**仅作历史迁移目标与部分业务关联，非当前正式账号权威源**；登录/权限/账号管理全部走 `store.js`（`server/app.js` 的 `loadDb().users`）
- **迁移状态**：`scripts/migrate-kv-to-pg.mjs` 可将 users 迁移至 PG，但**当前线上运行仍以 KV/JSON 为权威**

### Staff（员工主档）
- **权威源**：KV/JSON `staff[]`（`server/store.js`），`/api/userdata` 下发
- **镜像**：Prisma `Staff` 模型（line 42）——非当前权威源
- **前端**：`src/utils/selectors.js` 的 `localStaffList()` ← `getStaff()` ← userData 缓存

### Schedule（排班）
- **权威源**：KV/JSON `schedules{}`（`server/store.js`），经 `/api/userdata` 读写
- **无 PG 模型**（`prisma/schema.prisma` 中无 Schedule 模型）

### DailyEntry（门店业绩录入）
- **权威源**：**PostgreSQL** `DailyEntry` / `DailyStoreStaff` / `DailyEntryAuditLog`（`daily-entry-upgrade.js` 升级后）
- **兼容层**：KV/JSON `entries{}`（`server/store.js`）——旧数据与本地降级路径；`/api/userdata` 仍下发 entries 供前端兼容
- **迁移状态**：已升级至 PG（`daily-entry-upgrade.js`）

### Analysis（经营分析）
- **权威源**：KV/JSON `analysis{}`（`server/store.js`），`/api/analysis/upload` 写入
- **无 PG 模型**（analysis 在 PG 中无对应表，除非 `migrate-kv-to-pg.mjs` 已迁移 `analysis`，当前以 KV/JSON 为准）

### POS（点单/订单/支付）
- **权威源**：**PostgreSQL**：`Order`/`OrderItem`/`Payment`/`Refund`/`RefundItem`/`PaymentLog`/`StockBalance`/`StockLedger`/`WasteRecord`/`Expense`/`Member`/`MemberConsumption`（`server/pos.js`、`pos-core.js`、`payment-callbacks.js`、`order-state.js`）
- **商品主档**：PostgreSQL `InventoryItem`（`server/products.js`，POS 与商品中心共用）
- **前端会话缓存**：`sessionStorage`（购物车/待支付单/结算 key，`src/utils/pos.js`）——可丢失

### Inventory（库存申请/调货/采购）
- **权威源**：PostgreSQL：`TransferRequest`/`TransferItem`/`PurchaseRequest`/`PurchaseItem`/`Supplier`（`server/v2.js`）
- **兼容层**：KV/JSON `inventoryRequests{}`/`inventory{}`（`server/store.js`，旧数据/降级）；前端 `src/utils/inventoryAlerts.js` 轮询聚合
- **库存余额**：PostgreSQL `StockBalance`/`StockLedger`

### Payroll（工资条）
- **权威源**：PostgreSQL `PayrollNotice`（`server/payroll-notice.js`）
- **快照计算**：`src/utils/payrollSlip.js`（月/周/自定周期，前端生成快照后 POST 存 PG）
- **通知**：通知中心（见 Notification）

### Approval（审批中心）
- **权威源**：PostgreSQL：`ApprovalTemplate`/`ApprovalRequest`/`ApprovalNode`/`ApprovalCc`/`ApprovalAttachment`/`ApprovalComment`/`ApprovalLog`/`ApprovalNotification`（`server/approvals.js`）
- **通知**：`approval_notifications`（旧站内通知，兼容保留）+ 通知中心 `notifications`（**双写**，见第 9 节）

### Notification（通知中心）
- **权威源**：PostgreSQL：`NotificationTemplate`/`Notification`/`NotificationDelivery`/`WechatBinding`（`server/notification-center.js`、`notifications.js`、`wechat-bind.js`）
- **通道**：inapp（站内，权威）+ wechat（企业微信/公众号个人提醒，配置驱动，未配置时 `skipped`）+ wecom（企微群机器人广播，走 `wechat-alert.js`）
- **前端聚合**：`src/utils/inventoryAlerts.js` 8 秒轮询：调货/采购/发票/邮寄/资产/工资条/审批/通知中心多源合并（**兼容层**，未来可收敛为单一通知中心源）

### 资产（档案馆）
- **权威源**：PostgreSQL `AssetFile`/`AssetCategory`/`AssetFileVersion`/`AssetAccessGrant`/`AssetOperationLog`/`AssetReminder`（`server/asset-center.js`）
- **文件内容**：腾讯云 COS（`asset-storage.js`，配置后；未配置则 dataUrl 入库）

### 发票 / 邮寄 / 大单奖 / 薪资调整
- **权威源**：PostgreSQL：`Invoice`/`InvoiceCompany`、`MailingRecord`、`BigOrderBonus`、`DailyPayAdjustment`/`DailyPayAdjustmentAuditLog`（`server/v2.js`、`daily-pay-adjustment` 相关）

---

## 4. `/api/userdata` 与 `/api/v2` 职责边界

### `/api/userdata`（`server/app.js` line 1021/1027）
- **职责**：KV/JSON 共享数据的**全量读写**——门店、员工、排班、业绩录入（entries，兼容）、分析、商品图片、库存申请（兼容）、库存（兼容）
- **权限**：`requireAuth` + `scopeUserData`（`server/app.js`）按角色/绑定门店裁剪；收银员仅返回 POS 最小集
- **前端**：`loadUserData()`（`src/utils/userData.js`）启动时拉取 → 本地缓存 `localStorage`/内存，selectors 读取

### `/api/v2`（`server/app.js` line 574-602）
- **职责**：**结构化业务接口**——POS（订单/支付/商品）、审批、工资条、调货/采购/发票/邮寄/资产、库存余额、通知中心、微信绑定、业绩录入升级、商品中心、分析汇总、告警测试
- **鉴权**：`requireAuth` → POS 对收银开放 → `requireBusiness`（收银员拒绝业务接口）
- **原则**：v2 是**增量业务层**，凡涉及 PG 数据的业务走 v2；KV 共享数据仍走 userdata

---

## 5. 六角色、版块授权与门店数据范围

- **角色**（`shared/accountPermissions.js` `ACTIVE_ROLES`）：
  `developer`（开发者）｜`admin`（管理员，V2.06 起）｜`finance`（财务）｜`manager`（店长·区域负责人）｜`staff`（店员）｜`cashier`（门店收银）｜另有 `public`（对外展示，登录菜单中特殊处理，不属于 ACTIVE_ROLES）
- **超级用户**：`isSuperUser(user)` = developer | finance | admin（`shared/accountPermissions.js`）——全部菜单、全量数据、账号管理、归档、发放工资条
- **版块授权**（`server/app.js` `requireDeveloper/requireManager/requireOperational/requireBusiness` + `src/components/Sidebar.jsx` 菜单过滤 + `Dashboard.jsx` 视图守卫）：
  - developer/admin/finance：全部菜单与模块
  - manager：门店经营/人员/库存/发票/审批/系统设置（按绑定门店范围）
  - staff：本人数据 + 绑定门店范围（业绩录入/排班/邮寄/POS 只读等），无商品中心/账号管理
  - cashier：仅 POS 点单（全屏，无侧边栏）
  - public：仅展示页（排班/首页），无业务操作
- **门店数据范围**：`scopeUserData`（KV 数据按 `storeKeys` 过滤）、`storeFilter(user)`/`canStore`（v2 业务按门店过滤）、`hasInventoryTransferAll`（库存调拨全权限）
- **工资条权限**（`server/payroll-notice.js`）：超管全量；其余仅本人（绑定员工或 targetUsername）；发放仅超管；签收仅本人（开发者可代签）
- **审批权限**（`server/approvals-core.js`）：提交人=发起账号；审批人=admin 角色（无 admin 账号回退超管）；抄送=提交人+财务+手动添加；归档/删除草稿仅超管

---

## 6. Docker / Nginx / PostgreSQL / Upstash / COS / GitHub Actions 现状

- **Docker**：`Dockerfile` 多阶段（node:22-alpine，builder 构建前端 dist + server）；`docker-compose.yml` 编排 api/postgres（+ nginx 反代）；部署经 GitHub Actions SSH 到服务器执行 `deploy-remote.sh`
- **Nginx**：服务器侧配置，反代前端静态资源与 `/api` → 应用容器；健康检查通过 `docker compose exec api wget 127.0.0.1:3000/api/health`
- **PostgreSQL**：业务权威库（POS/审批/工资条/通知/资产/发票/邮寄/库存流水等），部署时 `pg_dump` 备份到 `~/.budu-backups/`；`dbOk` 反映连接状态
- **Upstash Redis**：`server/store.js` `redisConfig()`——配置 `KV_REST_API_URL/TOKEN` 或 `UPSTASH_REDIS_REST_URL/TOKEN` 时启用；**未配置时降级本地 JSON 文件**（`DATA_DIR/db.json`）
- **COS**：`server/asset-storage.js`——配置 `COS_BUCKET/REGION/SECRET_ID/SECRET_KEY` 后资产文件存 COS（DB 只留 storage_key）；未配置则 dataUrl 直接入库
- **GitHub Actions**：`deploy-test.yml`（HK 测试，含磁盘清理步骤）；`deploy-prod.yml`（北京生产预备，`BJ_*` secrets）；密钥存 GitHub Secrets（`TENCENT_SSH_KEY` 等）；workflow 推送受 OAuth scope 限制（需手动在 Web 更新）

---

## 7. 备份、健康检查、Sentry、企微告警现状

- **备份**：`scripts/backup-kv.mjs`（KV/JSON 导出）、`scripts/backup-pg.sh`（PG 备份）；部署流程内置迁移前 PG 备份（`deploy-remote.sh` line 69-70）
- **健康检查**：`GET /api/health`（`server/app.js` line 562）返回 `{ ok, time, env, appVersion, gitSha, dbOk }`；部署脚本 `wait_healthy` 轮询
- **Sentry**：前端 `@sentry/react` + 后端 `@sentry/node` 均已初始化（`src/main.jsx`、`server/index.js`）；ErrorBoundary 上报前端错误
- **企微告警**：`server/wechat-alert.js` `sendWechatMarkdown`（企业微信群机器人 webhook，`WECHAT_WORK_WEBHOOK_URL` 或代码 fallback）；业务告警经 `notification-center.js` 的 `broadcast()` 收口（库存预警/调货/采购/发票/邮寄/资产到期共 13 处调用）；另有 `/v2/alerts/test` 测试接口与设置页"发送测试消息"

---

## 8. 已知双写与数据一致性风险

1. **审批通知双写**：`server/approvals.js` 同时写 `approval_notifications`（旧表，供旧接口 `/v2/approvals/notifications` 兼容）与通知中心 `notifications`——两表独立、无事务联动，异常时可能不一致（旧表仅兼容用途，权威为通知中心）
2. **KV ↔ PG 数据迁移中**：`store.js`（users/staff/schedules/analysis/entries 兼容层）与 PG（DailyEntry 已升级）并存；`migrate-kv-to-pg.mjs` 提供迁移/对账，但**尚未全量完成**，存在同一业务两种读路径的风险
3. **POS 会话**：购物车/待支付单存 `sessionStorage`（可丢失）；订单/支付以 PG 为准，会话丢失可重查订单
4. **资产文件**：COS 与 dataUrl 双模式，未配置 COS 时大文件直接入库（DB 膨胀风险）
5. **工资条快照**：前端生成快照（`payrollSlip.js`）POST 入库，若前后端口径不一致（节假日规则等）可能生成不同结果；快照以入库值为准
6. **前端铃铛多源聚合**：`inventoryAlerts.js` 轮询 6+ 个接口合并展示，与通知中心存在重复通知可能（同一事件既走旧业务通知又走通知中心）

---

## 9. 历史文档声明

- 仓库内旧架构文档（`ARCHITECTURE.md`、早期设计/进度文档等）**仅供历史参考**，其中描述与当前代码不一致之处（如数据源、角色、部署方式）**一律以本文档为准**。
- 本文档为 BUDU 系统**当前事实的唯一权威架构说明**，后续 V3 设计、开发与 Review 以此为准。

---

## 10. 文档自检（对应 Task 验收）

- ✅ 基线 SHA：`c396c997d523d0009bb05ee10f2f8e06e446478a`；更新时间：2026-08-21 04:06 CST
- ✅ 前端/后端/PWA/数据库/部署技术栈均对应实际代码（第 1 节）
- ✅ 模块清单对应 `server/*.js` 与 `src/components/*.jsx` 实际文件（第 2 节）
- ✅ 数据源地图逐域标注权威源/兼容层/缓存/迁移状态（第 3 节）
- ✅ `/api/userdata` 与 `/api/v2` 边界对应 `server/app.js`（第 4 节）
- ✅ 六角色与版块授权对应 `shared/accountPermissions.js`、`server/app.js`、`Sidebar.jsx`（第 5 节）
- ✅ Docker/Nginx/PG/Upstash/COS/GitHub Actions 现状对应 `Dockerfile`、`docker-compose.yml`、`store.js`、`asset-storage.js`、workflows（第 6 节）
- ✅ 备份/健康检查/Sentry/企微告警对应 `scripts/`、`/api/health`、Sentry 初始化、`wechat-alert.js`（第 7 节）
- ✅ 双写与一致性风险逐条标注代码位置（第 8 节）
- ✅ 明确 Prisma `User`/`Staff` 非当前正式权威源（第 3 节 User/Staff 行）
- ✅ 历史文档声明（第 9 节）
