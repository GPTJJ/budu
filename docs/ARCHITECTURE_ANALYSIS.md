# BUDU 架构分析报告

> 版本：v1.0　日期：2026-08-07　作者：Codex（首席架构师）
> 范围：当前 `budu` 项目全量代码（React 前端 + Express 后端 + 存储适配层 + 部署配置）
> 目标：支撑未来 5–10 年稳定运行、可持续迭代的企业级管理系统
>
> **历史说明（2026-08-20）**：本文保留的是 2026-08-07 的架构快照，不再代表当前运行状态。当前系统已经使用常规分包、PostgreSQL/Prisma 与固定简体中文界面；仓库内置 `reportData.js`、语言词典和旧单文件打包插件均已移除。请以 README、Prisma schema 和现行代码为准。

## 1. 执行摘要

当前 BUDU 是一个**小而精的单体 Web 应用**：React SPA + Express API + 「JSON 文件 / Upstash KV」自适应存储，已在 Vercel + Upstash KV 上运行。它的优点是上手快、迭代快、业务规则（薪酬/绩效）已沉淀并有基础测试；但距离「企业级、可长期演进」的目标还有明显差距，核心问题集中在：

1. **数据层不是数据库**：整库是一份 JSON 文档，整体读写、无事务、无约束、无索引，多设备并发时是「最后写入者覆盖」，存在丢数据风险；`productImages` 以 base64 存在同一文档里，会迅速撞上 KV 单值大小上限。
2. **鉴权偏弱**：JWT 30 天无刷新、无吊销、无登录限流、注册接口完全开放、无 CSRF 防护、无审计日志。
3. **权限是硬编码的三角色**：`developer / store / public` 散落在前后端多处判断，未来加权限点必须改代码。
4. **可观测性接近零**：只有 `console.log`，无结构化日志、无请求 ID、无指标、无告警、无错误追踪。
5. **交付链路脆弱**：无 CI 测试门禁、无 staging 环境、数据库无迁移机制、`api/*` 每个 Serverless 函数每次请求都新建一个 Express 实例并整库读 KV。
6. **业务计算在前端**：报表数据打包进 160KB+ 的 `reportData.js`，薪酬/绩效/汇总逻辑在浏览器里跑，无法被第三方（如企业微信、报表、门店大屏）复用。

本报告给出现状盘点、问题分级、目标架构和关键技术决策。**《迁移计划》见 `docs/MIGRATION_PLAN.md`。**

## 2. 现状盘点

### 2.1 技术栈

| 层 | 技术 | 版本/说明 |
| --- | --- | --- |
| 前端 | React 18 + Vite 6 + Tailwind 3 | SPA；`vite-plugin-singlefile` 打成单 HTML（约 1MB / gzip 317KB） |
| 图表/图标 | Recharts 2 + lucide-react | Dashboard 图表 |
| 表格解析 | xlsx（SheetJS） | 服务端解析上传报表（`server/analysis.js`） |
| 后端 | Express 5 | 单体 `server/app.js`（约 480 行集中式路由） |
| 鉴权 | jsonwebtoken + Node 内置 scrypt | httpOnly Cookie + JWT |
| 存储 | Upstash KV（生产）/ 本地 JSON 文件（开发） | `server/store.js` 自适应，单 key `budu-db` 存整库 |
| 前端构建 | Vite + vite-plugin-singlefile + postinstall | `npm install` 后自动 `npm run build` |
| 部署 | Vercel（Serverless）+ Upstash KV | GitHub 推送自动触发 |
| 本地/临时公网 | `npm run server`、cpolar/serveo 隧道脚本 | `scripts/start-public.mjs` |
| 测试 | 无测试框架 | `scripts/smoke-render.mjs`（SSR 冒烟）、`test-payroll*.mjs`（薪酬单测/集成） |
| 数据生成 | Python `scripts/build_report_data.py` | 从 Excel 生成 `src/data/reportData.js` |

### 2.2 代码结构与模块

```
budu/
├─ api/                     # Vercel Serverless 入口（每个文件 = 一个路由，全部转发给 server/app.js）
├─ server/                  # Express 应用
│  ├─ app.js                # 全部路由 + 鉴权 + 参数校验（单体）
│  ├─ store.js              # 存储适配层（本地 JSON ↔ Upstash KV）
│  ├─ auth.js               # scrypt 哈希 + JWT
│  ├─ analysis.js           # Excel 报表解析（月度/菜品/薪资三类）
│  └─ data/db.json          # 本地库（gitignored，含账号/密钥）
├─ src/                     # React 前端
│  ├─ App.jsx               # 登录门禁 + 视图路由（state 切换，无 React Router）
│  ├─ components/           # Sidebar/Header/各报表组件/人员管理/业绩录入/账号管理/数据分析/商品目录/设置
│  ├─ utils/                # api.js / userData.js / selectors.js / payroll.js / format.js
│  ├─ data/reportData.js    # 自动生成的内置报表（160KB+，随包发布）
│  ├─ i18n.jsx + locales.js # 中英文切换（部分文案仍硬编码）
│  └─ visibility.jsx        # 角色可见性 Context（public/store 隐私）
├─ scripts/                 # 报表生成 / 冒烟测试 / 薪酬测试 / KV 迁移与只读脚本 / 公网隧道
├─ dist/                    # 构建产物（gitignored）
├─ .env.local               # 本地 KV 只读凭据（gitignored）
└─ vercel.json / DEPLOY.md / PROJECT_STATUS.md / README.md
```

### 2.3 数据模型与存储

生产数据是 Upstash KV 中的一个 JSON 文档（key：`budu-db`），结构如下：

```jsonc
{
  "meta": { "secret": "JWT 兜底密钥（随数据存储）" },
  "users": [{ "id", "username", "role", "passwordHash", "avatar?", "createdAt" }],
  "entries": { "<月份>|<门店key>|<日>": { "inc", "ord", "staff": [...], ... } },
  "staff": [{ "name", "type", "storeKey", ... }],
  "removedStaff": ["姓名"],
  "stores": [{ "key", "name", "district" }],
  "analysis": { "daily", "products", "employeeMonthly", "employees", "months", "sourceFiles", "uploadedAt" },
  "productImages": { "<商品名>": "data:image/...;base64,..." }
}
```

读写方式：

- `loadDb()`：整库 GET 一次并缓存；本地模式读 JSON 文件。
- `persist()`：整库 PUT 一次；本地模式原子写临时文件再 rename。
- 前端登录后 `GET /api/userdata` 全量拉取，变更后 250ms 防抖，`PUT /api/userdata` 全量回写。

### 2.4 鉴权与权限现状

- 密码：scrypt + 随机盐（`salt:hash`），实现正确，无明文存储。
- 会话：JWT（30 天）存 httpOnly Cookie，`SameSite=Lax`，HTTPS 下 `Secure`。
- 无：刷新令牌、吊销、登出失效、登录限流、锁定、CSRF Token、审计日志。
- 注册：`POST /api/auth/register` 完全开放，第一个注册者为 `developer`，之后默认 `store`。
- 角色：`developer / store / public` 硬编码；后端 `requireDeveloper / requireOperational` 两个中间件 + 前端 `visibility.jsx` 与各处 `user?.role === 'developer'` 判断。
- 权限点示例：员工增删改仅 developer；门店新增仅 developer；上传分析报表排除 public；首页/人员隐私字段按角色隐藏。

### 2.5 前端架构与数据流

1. 启动 → `GET /api/auth/me` 恢复登录态 → `loadUserData()` 全量拉取共享数据。
2. 数据缓存在内存 + localStorage 镜像（`budu-os-cloud-mirror-v1`），旧版 localStorage 首次登录自动迁移。
3. 所有 KPI/排行/趋势/薪酬均由 `selectors.js` 在前端实时计算（合并内置 `reportData.js` + 上传分析 + 每日录入）。
4. 页面视图用 React state 切换（`view`），无路由库、无状态管理库；图表直接渲染 DOM。

### 2.6 部署与运维现状

- Vercel：`framework=vite`，构建 `npm run build`，输出 `dist/`；API 走 `api/*` Serverless 函数。
- 每个 `api/*.js` 入口都执行 `createApp()` 新建 Express 实例；Serverless 冷启动时每次都要重新建应用并整库读 KV。
- 环境变量：`KV_REST_API_URL / KV_REST_API_TOKEN / JWT_SECRET / COOKIE_SECURE`（Vercel 面板配置）。
- 无：Docker、Nginx、自有 HTTPS 终止、数据库备份自动化、监控告警、日志采集、staging。
- 本地数据 `server/data/db.json` 被 gitignore，是唯一的「离线备份点」，但内容已滞后于生产。

## 3. 架构评价

### 3.1 做得好的地方

- 业务规则（薪酬阶梯、节假日、门店标准工时）沉淀在 `payroll.js` 并有单测/集成测试，规则清晰。
- 存储有适配层（本地 ↔ KV），切换成本低，为迁 PostgreSQL 提供了天然的改造点。
- 前端对「角色隐私」已有 Context 隔离（`visibility.jsx`），方向正确。
- 文档习惯好（PROJECT_STATUS / DEPLOY），适合继续做工程化。
- 密码哈希、httpOnly Cookie、基础参数长度校验等安全意识已有雏形。

### 3.2 主要问题与风险（按严重度排序）

| # | 风险 | 影响 | 说明 |
| --- | --- | --- | --- |
| R1 | 整库文档式读写 | 并发丢数据、无法事务 | 多设备同时录入时最后写入覆盖；无行级冲突检测 |
| R2 | KV 单值大小上限 | 系统不可用 | 分析数据 + base64 图片都塞进同一个 key；单图上限 500KB，几十张图后即超限（Upstash 单值上限通常 1MB） |
| R3 | 认证体系弱 | 账号被盗/暴力破解 | 30 天 JWT 无吊销；登录无限流；注册开放；无 CSRF Token |
| R4 | 无审计与日志 | 追责/排障困难 | 无操作审计、无结构化日志、无请求 ID |
| R5 | Serverless 冷启动整库读 | 延迟抖动、成本上升 | 每个函数每次请求新建 Express + 读全量 KV |
| R6 | 业务计算在前端 | 无法集成/复用 | 报表与薪酬规则在浏览器执行，API 无法被第三方消费 |
| R7 | 无类型系统与测试门禁 | 回归风险 | 纯 JS + 无 CI；改动靠人工自测 |
| R8 | 上传解析在服务进程内 | 安全与稳定性风险 | xlsx 解析无沙箱/超时/资源限制；库本身有已知安全通告 |
| R9 | 密钥随数据存储 | 密钥轮换困难 | `meta.secret` 存在数据库文档里，泄露数据即泄露签名密钥 |
| R10 | 无备份自动化 | 数据丢失不可恢复 | KV 靠手动导出；本地 db.json 无人值守备份 |

### 3.3 对「5–10 年」目标的差距总结

| 维度 | 现状 | 目标 |
| --- | --- | --- |
| 数据 | JSON 文档、无 schema | PostgreSQL + Prisma migration、事务、约束、索引 |
| 权限 | 3 个硬编码角色 | 动态 RBAC（角色-权限表）+ 后端强制校验 |
| 安全 | 基础 Cookie + JWT | 完整中间件链：Helmet / 限流 / 校验 / CSRF / 刷新令牌 / 审计 |
| 部署 | Vercel Serverless | 腾讯云 Docker + Nginx + HTTPS，自托管可控 |
| 交付 | 手动推送 | GitHub Actions：测试→构建→迁移→发布→回滚 |
| 观测 | console.log | 结构化日志、健康检查、监控告警 |
| 集成 | 无 | 预留企业微信（登录/消息/回调） |

## 4. 目标架构（5–10 年）

### 4.1 总体分层

```
┌──────────────────────────────────────────────────────────┐
│ 客户端：Web（React SPA，桌面+手机）／未来：企业微信 H5 / 小程序 │
└──────────────────────────┬───────────────────────────────┘
                           │ HTTPS
┌──────────────────────────▼───────────────────────────────┐
│ Nginx（TLS 终止 / 静态资源 / 反向代理 / 限流 / gzip）          │
└──────────────────────────┬───────────────────────────────┘
                           │ /api
┌──────────────────────────▼───────────────────────────────┐
│ API 服务（Node 22 LTS + Express 模块化 + Prisma）            │
│ 路由 / 校验(zod) / RBAC / 安全中间件 / 日志 / 审计 / 企业微信 │
└───────────────┬───────────────────────┬──────────────────┘
                │ Prisma                 │ SDK
        ┌───────▼────────┐        ┌──────▼──────────┐
        │ PostgreSQL 16   │        │ 腾讯云 COS       │
        │ 业务数据+审计    │        │ 商品图/头像/报表  │
        └────────────────┘        └─────────────────┘
```

### 4.2 推荐目录结构（单仓库、双部署单元）

```
budu/
├─ apps/
│  ├─ web/                  # React SPA（Vite），部署为 Nginx 静态资源
│  └─ api/                  # Express + Prisma 服务
│     └─ prisma/            # schema.prisma + migrations
├─ packages/
│  └─ shared/               # 领域常量、RBAC 权限码、DTO 类型、薪酬规则（前后端共用）
├─ docker/                  # nginx.conf、compose.yml、entrypoint、备份脚本
├─ .github/workflows/       # ci.yml / deploy.yml / migrate.yml
├─ docs/                    # 架构、迁移、运行手册
└─ .env.example
```

> 迁移期可保留现有 `src/` + `server/` 结构原位演进，逐步对齐上述布局，避免一次性大爆炸式重构。

### 4.3 数据架构：PostgreSQL + Prisma

#### 核心设计原则

- 金额一律用**整数「分」**（`BigInt`/`Integer` 列）存储，展示层再格式化，避免浮点误差。
- 所有业务表带 `createdAt / updatedAt`，关键表带 `createdById / updatedById` 与软删除。
- 主键用 `UUID`（生成在应用层），避免暴露自增序号。
- 报表解析结果等半结构化数据用 `JSONB`，但只允许放「可重建的派生数据」，**原始事实进关系表**。
- 图片/文件一律存对象存储（腾讯云 COS），数据库只存对象 key。

#### Prisma Schema 实体清单（第一版）

| 模型 | 关键字段 | 说明 |
| --- | --- | --- |
| `User` | username(unique), passwordHash, avatarKey, status(active/disabled), lastLoginAt | 账号 |
| `Role` | code(developer/store/public/…), name | 角色 |
| `Permission` | code(如 `user.manage`, `entry.write`, `analysis.upload`), name | 权限点 |
| `RolePermission` | roleId, permissionId | 角色-权限 |
| `UserRole` | userId, roleId | 用户-角色（多对多，支持未来一人多角色） |
| `Session` | userId, refreshTokenHash, expiresAt, revokedAt, ip, userAgent | 刷新令牌轮换与吊销 |
| `Store` | key(unique), name, district, payConfig(JSONB), active | 门店与薪酬参数 |
| `Staff` | storeId, name, type(fulltime/parttime), status, joinDate, leaveDate | 员工档案 |
| `DailyEntry` | storeId, date, rev, inc, dis, ord, dish, …(整数分), staffNames(JSONB), createdById, updatedById | 每日业绩（唯一约束 storeId+date） |
| `Product` | storeId, name, category, unitPrice? | 商品目录 |
| `ProductImage` | productId, objectKey, sort | 商品图（COS） |
| `AnalysisReport` | fileName, reportType, status, sourceMeta(JSONB), uploadedById | 上传报表元信息 |
| `AnalysisData` | reportId, month, payload(JSONB) | 解析后的派生数据 |
| `AuditLog` | userId, action, resourceType, resourceId, detail(JSONB), ip, userAgent | 操作审计 |
| `AppSetting` | key(unique), value(JSONB) | 系统配置（含企业微信配置） |
| `WeChatConfig` | corpId, agentId, secretEncrypted, token, encodingAesKey, enabled | 企业微信预留 |

#### 第一批 Prisma migration 要点

1. `CREATE EXTENSION IF NOT EXISTS "pgcrypto";`（gen_random_uuid）。
2. 唯一约束：`User.username`、`Store.key`、`DailyEntry(storeId,date)`、`Role.code`、`Permission.code`、`RolePermission(roleId,permissionId)`、`UserRole(userId,roleId)`。
3. 索引：`DailyEntry(storeId,date)`、`DailyEntry(date)`、`AuditLog(createdAt)`、`Session(userId)`、`Session(expiresAt)`。
4. 审计表不设外键到 User（历史不可因删号而断链），只存 `userId` 快照字段。
5. 种子数据：三个内置角色 + 权限码 + `WeChatConfig` 空行。

### 4.4 RBAC 设计

- 权限码（第一版建议）：
  - `user.manage`（账号管理/角色/重置密码）
  - `staff.write` / `staff.delete`（员工增改删）
  - `store.write`（门店新增）
  - `entry.write`（业绩录入）
  - `analysis.upload` / `analysis.clear`
  - `product.manage`（商品图）
  - `settings.manage`
  - `wechat.manage`（企业微信配置）
  - `report.read`（敏感报表字段）
- 内置角色映射：`developer` = 全部权限；`store` = 业务读写（不含 `user.manage`、不含 `staff.write`、`report.read` 视隐私策略）；`public` = 只读展示权限子集。
- 后端强制：`requirePermission('entry.write')` 中间件读用户-角色-权限；JWT 只存 `sub/roleIds/permVersion`，权限变更通过 `permVersion` 触发重新拉取，避免「改角色后旧 JWT 仍有效」。
- 前端只做 UI 显隐（`<Can permission="...">`），所有授权判断以后端为准。

### 4.5 安全中间件链（API 层）

1. `helmet`：安全响应头（CSP、X-Frame-Options、HSTS 等）。
2. CORS 白名单（配置化，生产只允许正式域名）。
3. 全局限流（`express-rate-limit`）+ 登录/注册专用限流（按 IP + 用户名，5 次/分钟，超限锁定 15 分钟）。
4. `zod` 请求体/参数校验（路由级 schema），拒绝未知字段。
5. 认证：短时 access token（15 分钟）+ 可轮换 refresh token（30 天，存 Session 表哈希）；登出/改密/禁用即吊销。
6. CSRF：`SameSite=Strict` + Origin 校验（或双提交 Cookie Token）。
7. 上传：类型/大小/扩展名白名单 + 解析超时与内存上限（建议 xlsx 解析放到独立 worker 或直接上云函数），图片落 COS，回源校验。
8. 密码策略：≥8 位并校验常见弱密码；管理端重置后强制下次登录改密（可选）。
9. 错误处理：统一错误 JSON，不向客户端泄漏堆栈/内部路径；未捕获异常进日志。

### 4.6 日志与审计

- 应用日志：`pino` + `pino-http`，每条请求带 `requestId`、`userId`、耗时、状态码；Docker 内输出 stdout 并滚动落盘。
- 审计日志：所有「写操作」（登录、注册、改密、角色变更、员工增删、业绩录入、分析上传/清除、设置变更）写 `AuditLog` 表，保留 `who/what/when/where(ip)`。
- 运维指标：`/healthz`（进程存活）、`/readyz`（DB 连通 + 迁移版本），供 Docker healthcheck 与 Nginx/云监控探活。
- 告警：健康检查失败、5xx 突增、登录失败激增 → 企业微信 Webhook 通知（复用预留模块）。

### 4.7 部署架构（腾讯云 + Docker + Nginx + HTTPS）

- 推荐起步：腾讯云 Lighthouse（轻量应用服务器）2C4G，Ubuntu 22.04，Docker + Compose 单机多容器：
  - `nginx`：80→443 跳转、TLS 终止、静态资源（web 构建产物）、`/api` 反代、客户端限流。
  - `api`：Node 22 LTS slim，Prisma 客户端，健康检查。
  - `postgres`：PostgreSQL 16，数据卷 + 每日 `pg_dump` 到 COS + 保留 N 天。
  - 可选 `backup` 侧车容器负责备份与恢复演练。
- HTTPS：腾讯云免费 SSL 证书（或 Let's Encrypt certbot 自动续期），配置 HSTS。
- 图片/报表文件：腾讯云 COS（私有桶 + 预签名 URL），数据库只存 key。
- 容量演进：单机 → 加 CVM/负载均衡 → API 多副本 + 托管 PostgreSQL（腾讯云 TDSQL-C/PostgreSQL）→ 加 Redis 缓存。5–10 年内先单机 + 托管 DB 即足够。

### 4.8 CI/CD（GitHub Actions）

- `main` 推送：install → lint → 单测 → build → `prisma migrate deploy`（迁移任务，先备份）→ 构建 Docker 镜像（GHCR 或腾讯云 TCR，tag=`git-sha`）→ SSH 到服务器 `docker compose pull && up -d` → 健康检查。
- PR：只跑 install/lint/test/build，不部署。
- 回滚：重新部署上一个镜像 tag；数据库迁移遵循「只增不删、向后兼容、可回滚」原则，破坏性变更拆两步。

### 4.9 企业微信集成预留

- 数据：`WeChatConfig` 表 + `AppSetting` 键（corpId/agentId/secret 加密存储）。
- 环境变量占位：`WECHAT_WORK_CORP_ID`、`WECHAT_WORK_AGENT_ID`、`WECHAT_WORK_SECRET`、`WECHAT_WORK_TOKEN`、`WECHAT_WORK_AES_KEY`、`WECHAT_WORK_CALLBACK_URL`。
- 代码预留：`server/modules/wechat/`（config / oauth / message / callback 四个模块骨架 + 空实现）。
- 预留能力：扫码/网页授权登录、文本/Markdown 消息推送（日报、告警）、回调验签与 AES 解密、后续门店群机器人。

## 5. 关键技术决策（D1–D8）

| # | 决策点 | 建议 | 理由 |
| --- | --- | --- | --- |
| D1 | 后端框架 | 保留 Express 5，按模块拆路由 | 迁移成本最低；团队熟悉；规模不需要换框架 |
| D2 | 数据库 | PostgreSQL 16（腾讯云托管或 Docker 自建） | 事务/约束/JSONB/成熟生态；5–10 年无瓶颈 |
| D3 | ORM | Prisma + migration 管理 | 类型安全、schema 即文档、迁移可控 |
| D4 | 金额 | 整数「分」存储 | 杜绝浮点误差，财务类系统标准做法 |
| D5 | 图片存储 | 腾讯云 COS（私有桶+预签名） | 解决 KV 上限；CDN/审计/合规都方便 |
| D6 | 单仓库 | 单仓库双部署单元（apps/web + apps/api） | 协同简单，前端/后端可独立发布 |
| D7 | 部署形态 | 腾讯云 Lighthouse + Docker Compose + Nginx | 起步成本低；Dockerfile 化后迁移 CVM/K8s 无缝 |
| D8 | 认证 | access+refresh 双令牌 + Session 表 | 可吊销、可轮换、可审计；JWT 只做无状态载体 |

## 6. 风险登记册（迁移前基线）

| 风险 | 影响 | 概率 | 应对 |
| --- | --- | --- | --- |
| KV 单值超限导致线上不可用 | 高 | 中（图片持续上传即触发） | 迁移前先做 KV 导出备份；尽快切 PG+COS |
| 并发录入丢数据 | 高 | 高（多设备） | 迁移后 DailyEntry 唯一约束 + 事务；冲突提示 |
| 登录爆破 | 高 | 中 | 限流 + 锁定 + 审计告警 |
| 迁移过程丢数据 | 极高 | 低 | 双轨运行、对账脚本、回滚保留旧平台 30 天 |
| 旧 JWT 在角色变更后仍有效 | 中 | 高 | permVersion 机制 + 短令牌 |
| 上传报表解析被攻击 | 高 | 低-中 | worker 沙箱 + 大小/超时限制 + 依赖升级 |

## 7. 结论

当前系统业务价值已经成立，但**数据层和工程化必须重做**，否则 5–10 年目标无法达成。推荐按「数据库先行、后端重构、容器化上云、CI/CD 收尾、企业微信预留」的顺序推进，全程保持线上可用的双轨过渡。具体节奏、任务、验收标准与回滚方案见《迁移计划》。

---

附录 A：现状文件地图（关键文件 → 职责）已在 2.2 节列出。
附录 B：当前 API 清单（`server/app.js`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/health | 健康检查 |
| POST | /api/auth/register | 注册（开放） |
| POST | /api/auth/login | 登录 |
| POST | /api/auth/logout | 退出（仅清 Cookie，JWT 仍有效） |
| GET/PUT | /api/auth/me | 当前用户 / 改密码、用户名、头像 |
| GET | /api/userdata | 全量共享数据 |
| PUT | /api/userdata | 全量写回（整库文档） |
| POST/DELETE | /api/analysis/upload, /api/analysis | 报表上传解析 / 清除 |
| GET/PUT/DELETE | /api/admin/users… | 账号管理（developer 专属） |
