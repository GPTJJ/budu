# BUDU 分阶段迁移计划

> 版本：v1.0　日期：2026-08-07　作者：Codex（首席架构师）
> 前置文档：《架构分析报告》`docs/ARCHITECTURE_ANALYSIS.md`
> 原则：**全程线上可用、双轨过渡、每阶段可验收、可回滚；未获确认不进入下一阶段。**

## 1. 迁移目标

把 BUDU 从「Vercel Serverless + Upstash KV 文档库」迁移为：

- 数据：PostgreSQL 16 + Prisma（完整 migration、事务、约束、备份）
- 后端：模块化 Express + RBAC + 安全中间件 + 结构化日志/审计
- 前端：React SPA 继续演进，去掉「业务规则必须在前端」的约束
- 部署：腾讯云 Docker + Nginx + HTTPS（正式域名）
- 交付：GitHub Actions 自动测试/迁移/发布/回滚
- 集成：预留企业微信接口
- 治理：`.env.example`、环境分层（dev/staging/prod）、运行文档齐全

## 2. 阶段总览

| 阶段 | 名称 | 核心产出 | 建议周期 | 线上影响 |
| --- | --- | --- | --- | --- |
| P0 | 基线治理与风险止血 | 数据备份、env 模板、分支保护、文档 | 2–3 天 | 无 |
| P1 | 数据库与 ORM 落地 | Prisma schema + 首批 migration + 种子 | 3–5 天 | 无（并行） |
| P2 | 存量数据迁移与对账 | ETL 脚本、对账报告、双轨验证 | 3–5 天 | 无（只读+演练） |
| P3 | 后端重构 | 模块化路由、RBAC、安全链、日志审计、刷新令牌 | 8–12 天 | 无（新 API 并存） |
| P4 | 前端适配 | API 客户端、权限驱动 UI、移除整库镜像依赖 | 5–8 天 | 低（staging 验证） |
| P5 | 容器化与腾讯云部署 | Dockerfile、compose、Nginx、HTTPS、COS | 5–7 天 | 切换日短停 |
| P6 | CI/CD 自动化 | GitHub Actions 全套流水线 | 3–5 天 | 无 |
| P7 | 可观测性与安全加固 | 日志/健康/告警、备份演练、安全清单 | 3–5 天 | 无 |
| P8 | 企业微信接口预留 | 配置表、模块骨架、环境占位 | 2–3 天 | 无 |
| P9 | 验收、切换与交接 | 正式切换、运行手册、培训、旧平台下线 | 3–5 天 | 切换窗口 |

合计约 **6–9 周**（单人兼职节奏）；若并行执行 P1/P8、压缩验收窗口可到 4–6 周。

## 3. 阶段详述

### P0　基线治理与风险止血（2–3 天）

**背景**：迁移开始前必须先有「可恢复的现状」和「干净的协作基线」。

任务：
1. 用 `scripts/read-upstash.mjs` 导出生产 KV 全量数据，落盘为只读快照（`backups/kv-snapshot-YYYYMMDD.json`，**不入 git**，放安全位置并上传 COS 私有桶）。
2. 盘点密钥：`JWT_SECRET`、KV Token 等是否可轮换；`meta.secret` 内嵌数据问题记录在案。
3. 新建 `.env.example`（全部变量占位 + 注释），本地 `.env.local` 保持 gitignore。
4. Git 仓库治理：开启分支保护（main 需 PR + 状态检查）、约定 commit 规范、补 `LICENSE`/`CONTRIBUTING`（可选）。
5. 冻结「整库文档继续膨胀」：临时关闭商品图片上传（或限制总数），避免迁移前撞 KV 上限。
6. 更新 `PROJECT_STATUS.md`，记录迁移决策与阶段状态。

交付物：KV 快照 + 备份清单、`.env.example`、分支保护、P0 验收单。
验收标准：快照可恢复（在临时 KV 里还原验证一次）；仓库无法直接 push main；env 模板无真实密钥。

### P1　数据库与 ORM 落地（3–5 天）

**背景**：PostgreSQL 先行，不动现有业务；新代码以 Prisma 为唯一数据访问层。

任务：
1. 搭建本地开发 PostgreSQL（Docker `postgres:16`），申请/开通腾讯云 PostgreSQL（或先用服务器 Docker 版）。
2. 初始化 Prisma（`apps/api/prisma/schema.prisma`），按《架构分析报告》4.3 节实体清单建模：
   - User / Role / Permission / RolePermission / UserRole / Session
   - Store / Staff / DailyEntry / Product / ProductImage
   - AnalysisReport / AnalysisData / AuditLog / AppSetting / WeChatConfig
3. 编写第一批 migration（唯一约束、索引、种子数据、`pgcrypto`）。
4. 建立 `lib/prisma.js` 单例与 `zod` 校验目录骨架。
5. 保留 `server/store.js`（KV/JSON）作为旧数据源，新旧并存。

交付物：`schema.prisma` + `prisma/migrations/*`、seed 脚本、本地可运行的新数据库。
验收标准：`prisma migrate dev` 与 `migrate deploy` 均可空库建表；种子后三角色与权限码齐全；`prisma studio` 可查询。

### P2　存量数据迁移与对账（3–5 天）

**背景**：生产数据唯一权威在 Upstash KV；迁移必须可重复、可对账、可回滚。

任务：
1. 编写 ETL 脚本 `scripts/migrate-kv-to-pg.mjs`（幂等，支持 `--dry-run`）：
   - users → User：角色映射 `owner/admin/member → developer/store/store`，密码哈希原样保留（scrypt 格式兼容），头像 base64 → COS 或暂存字段。
   - stores → Store：先内置三店 + 自定义门店；`key/name/district` 校验去重。
   - staff → Staff：`storeKey` 关联 Store（按 key，缺失按名称匹配），保留 type/name，软删标记来自 removedStaff。
   - entries → DailyEntry：解析 `<month>|<storeKey>|<day>` 为 `(storeId, date)`；金额字段 ×100 转分；staff 名单入 `staffNames JSONB`。
   - analysis → AnalysisReport + AnalysisData（派生数据按原样 JSONB 归档）。
   - productImages → COS（P5 前可先存 `ProductImage.objectKey` 指向本地/临时 URL 占位）。
   - meta.secret 不迁移（新系统用环境变量 `JWT_SECRET`）。
2. 对账脚本：逐表统计（用户数、员工数、录入天数、各店营业额合计、商品数）并与 KV 快照比对，输出差异报告。
3. staging 库先跑两轮：空库全量 → 对账 → 重跑幂等 → 再对账。

交付物：ETL 脚本 + 对账脚本 + staging 对账报告。
验收标准：三张关键表（User/DailyEntry/Staff）计数与金额合计 100% 一致；幂等重跑不产生重复；干跑不写库。

### P3　后端重构（8–12 天）

**背景**：新 API 与旧 API 并行，前端逐步切换；所有旧行为先保持兼容。

任务：
1. 路由模块化（`apps/api/src/routes/`）：
   - `auth.routes.ts`（注册/登录/登出/me/刷新）
   - `admin.routes.ts`（账号、角色、权限）
   - `store.routes.ts`（门店、员工、每日业绩）
   - `report.routes.ts`（报表上传/清除/查询）
   - `product.routes.ts`（商品、图片）
   - `system.routes.ts`（设置、健康、审计查询）
   - `wechat.routes.ts`（占位）
2. 鉴权升级：
   - access token 15 分钟 + refresh token 30 天轮换（Session 表存哈希，登出/改密/禁用即吊销）。
   - 保留 httpOnly Cookie；`SameSite=Strict`，生产 `Secure`。
3. RBAC 中间件：`requirePermission(code)`，JWT 带 `roleIds + permVersion`；角色变更 bump `permVersion`。
4. 安全链：helmet、CORS 白名单、express-rate-limit（登录/注册/全局）、zod 校验、Origin/CSRF 校验、统一错误处理。
5. 日志与审计：pino + pino-http（requestId）；写操作落 AuditLog；`/healthz`、`/readyz`。
6. 上传改造：xlsx 解析入独立 worker + 超时/大小限制；图片上传先落 COS（P5 后正式启用）。
7. 旧兼容层：`server/app.js` 原样保留在旧入口（Vercel 仍服务旧前端），新 API 挂新端口/新路径前缀，如 `/v2/api`（或同路径按 `X-API-Version` 分发）。

交付物：新 API 全部路由 + 中间件 + 测试（vitest 起步，覆盖 auth/RBAC/audit）。
验收标准：新 API 在 staging 通过全部用例；安全头/限流/校验生效（用 curl 验证）；审计表有写操作记录；旧线上不受影响。

### P4　前端适配（5–8 天）

**背景**：前端从「整库镜像 + 本地计算」切换为「按需 API + 服务端数据」。

任务：
1. API 客户端改造：baseURL 环境化、自动刷新 access token、请求级错误处理（401 静默刷新）。
2. 权限驱动 UI：`<Can permission="...">` 组件替换散落的 `user?.role` 判断；角色文案从 API 获取。
3. 数据层改造（分步，先保底）：
   - 阶段 A：保留现有 `userData.js` 镜像，但写操作改调新 API（`PUT /v2/api/daily-entries/...`）。
   - 阶段 B：读操作改调查询 API（按月/按店/按日分页），删除对 `reportData.js` 整包依赖（历史报表数据迁入 PG 后由 API 提供）。
4. 移除单文件打包限制可选项：保留 `vite-plugin-singlefile` 或改常规分包（建议改常规分包，利于缓存与体积）。
5. 登录页/账号菜单接入新鉴权（含刷新与“会话已过期”提示）。
6. 中英文文案补齐（新建文案全部走 i18n）。

交付物：新前端构建产物 + API 契约文档（OpenAPI）。
验收标准：staging 全流程（登录→录入→报表→账号管理→隐私角色视图）通过；无整库 PUT；刷新令牌过期后自动登出提示正确。

### P5　容器化与腾讯云部署（5–7 天）

任务：
1. Dockerfile：
   - `web`：多阶段（node:22-alpine 构建 → nginx:alpine 静态托管）。
   - `api`：多阶段（build → node:22-alpine-slim 运行，非 root 用户）。
2. `docker-compose.yml`（prod）：nginx + api + postgres + backup（可选）；数据卷、健康检查、日志滚动、restart 策略。
3. Nginx：HTTP→HTTPS 跳转、TLS 证书（腾讯云证书或 certbot）、HSTS、gzip、`/api` 反代、静态缓存、上传体大小限制、客户端限流。
4. 腾讯云资源：Lighthouse（2C4G+）、安全组（仅 80/443/22，DB 不暴露公网）、COS 桶（私有）+ CAM 子账号密钥、域名 DNS 指向。
5. `.env.example` 落地为 `.env.production`（服务器上单独维护，不入 git）。
6. 图片/头像上传正式切 COS（预签名 URL），数据库只存 key。
7. 部署手册 `docs/RUNBOOK.md`：首次部署、证书续期、升级、回滚、备份/恢复命令。

交付物：Docker 全套 + 腾讯云开通清单 + RUNBOOK。
验收标准：全新服务器按文档从零部署成功；HTTPS 可访问；`/readyz` 通过；上传图片后 COS 可见、数据库无 base64。

### P6　CI/CD 自动化（3–5 天）

任务：
1. `.github/workflows/ci.yml`：install → lint → test → build（PR + main）。
2. `.github/workflows/deploy.yml`：main 合并后：
   - 备份 DB（pg_dump → COS）
   - `prisma migrate deploy`
   - 构建并推送镜像（GHCR 或腾讯云 TCR，tag=sha）
   - SSH 到服务器 `docker compose pull && up -d api web`
   - 健康检查 + 失败自动回滚到上一 tag
3. `.github/workflows/migrate.yml`：手动触发的「仅迁移」工作流（含 dry-run 输出）。
4. 密钥管理：GitHub Secrets（服务器 SSH、COS 密钥、DATABASE_URL 等），服务器 `.env` 不入仓库。
5. staging 环境（可选）：同一台服务器另一 compose 项目或独立实例。

交付物：三套 workflow + Secrets 配置文档。
验收标准：故意在分支上引入测试失败 → PR 不通过；合并后自动部署并在 5 分钟内健康；模拟迁移失败 → 自动回滚成功。

### P7　可观测性与安全加固（3–5 天）

任务：
1. 日志：pino JSON 输出 + Docker 滚动；本地排查指南。
2. 监控：云监控/外部 uptime 探活 `/healthz`；5xx 与登录失败阈值 → 企业微信 Webhook 告警。
3. 备份：每日 `pg_dump` 到 COS，保留 30 天；每月恢复演练；写恢复手册。
4. 安全清单核对：Helmet 头、限流、CSRF、上传限制、密码策略、依赖 `npm audit`（CI 门禁）、权限矩阵（developer/store/public × 功能点）。
5. 可选：Sentry 接入错误追踪。

交付物：告警配置、备份/恢复脚本与演练记录、安全自评清单。
验收标准：模拟 DB 宕机 → 告警发出；从 COS 备份恢复到新库 ≤30 分钟；`npm audit` 无高危未处理项。

### P8　企业微信接口预留（2–3 天，可与 P3/P4 并行）

任务：
1. `WeChatConfig` 表 + `AppSetting` 默认值；配置管理页（developer 可见，只存加密 secret）。
2. 模块骨架 `server/modules/wechat/`：
   - `config.js`（读取/加密存储）
   - `oauth.js`（扫码/网页授权登录占位，返回“未配置/已禁用”）
   - `message.js`（text/markdown 推送占位，统一 `sendWechatMessage()` 接口，供后续日报/告警调用）
   - `callback.js`（URL 验签、AES 解密占位，路由 `/api/wechat/callback`）
3. `.env.example` 增加 `WECHAT_WORK_*` 占位与注释。
4. 文档：`docs/WECHAT_INTEGRATION.md`（接入步骤、回调配置、权限说明）。

交付物：预留模块 + 配置页 + 文档。
验收标准：未配置时所有微信接口返回 501 且日志友好；配置后可手工触发一次文本推送（如已完成对接，否则仅接口就绪）。

### P9　验收、切换与交接（3–5 天）

任务：
1. 切换演练：DNS 从 Vercel 指向腾讯云正式域名前，先在 staging 域名完整跑 3 天。
2. 正式切换（低峰窗口）：
   - 新系统进入只读维护模式前做最后一次 KV→PG 增量同步。
   - DNS 切换 → 验证登录/录入/报表/图片 → 解除维护。
3. 观察期 30 天：保留 Vercel + Upstash KV 只读存档（不删数据），随时可回滚。
4. 交接：更新 README/PROJECT_STATUS/RUNBOOK；培训账号与权限说明；确定运营值班与告警联系人。
5. 清理：确认稳定后下线 Vercel 项目与 KV 资源（先降级为只读，30 天后删除，删除前导出一份最终归档）。

交付物：切换报告、交接文档、最终归档快照。
验收标准：切换后核心链路 100% 可用；30 天内无回滚；归档可恢复。

## 4. 数据迁移细节（P2 补充）

### 4.1 关键映射

| 旧（KV 文档） | 新（PostgreSQL） | 转换规则 |
| --- | --- | --- |
| `users[].role` | `UserRole` | owner/admin/member → developer/store/store；新系统用角色种子表 |
| `users[].passwordHash` | `User.passwordHash` | 原样迁移（scrypt 格式一致） |
| `users[].avatar`（base64） | `User.avatarKey`（COS） | 迁移时批量上传；失败记录到对账报告 |
| `stores[]` | `Store` | 内置三店 + 自定义店；缺失 store 的 entries 挂 `unassigned` 并告警 |
| `staff[]` | `Staff` | storeKey → storeId；removedStaff → `status=archived` |
| `entries["M\|S\|D"]` | `DailyEntry` | 金额 ×100；date 由 M+D 拼接；唯一约束防重 |
| `analysis.*` | `AnalysisReport` + `AnalysisData` | 元信息 + JSONB 派生数据 |
| `productImages` | `ProductImage`（COS） | 商品名匹配 Product；无法匹配的进孤儿报告 |
| `meta.secret` | 不迁移 | 新密钥在环境变量 |

### 4.2 对账口径

- 用户数、角色分布
- 门店数、自定义门店
- 员工数（在职/归档）
- 业绩录入条数、按店/按月营业额合计（分 vs 元换算后）
- 分析报表数、商品数、图片数
- 抽样 10 天逐条比对（旧文档 vs 新表）

### 4.3 切换期写保护

- 切换窗口内旧系统进入「只读」（前端禁用写按钮 + 后端拒绝 PUT），完成后新系统接管写入。
- 若无法接受停写，可加短期双写（旧 KV 与新 PG 同时写，24h 后校验），复杂度上升，仅在大流量场景启用。

## 5. 回滚策略

| 阶段 | 回滚方式 |
| --- | --- |
| P0–P4 | 无线上影响，直接修复或回退 commit |
| P5–P6 | 旧镜像 tag 重新部署；DB 迁移按「向后兼容」设计，需要时 `prisma migrate resolve` 标记 |
| P9 切换后 30 天内 | DNS 切回 Vercel；PG 数据通过增量导出回灌 KV（脚本复用 P2 ETL 反向） |
| 切换 30 天后 | 仅从最终归档恢复（演练过） |

## 6. 需要用户确认/提供的信息

1. 正式域名（如 `os.budu.example.com`）与 DNS 托管方式（腾讯云 DNSPod？）。
2. 腾讯云账号与预算：Lighthouse 规格（默认 2C4G）、PostgreSQL 托管 or 服务器自建、COS 存储。
3. SSL 证书偏好：腾讯云免费证书 or Let's Encrypt。
4. 企业微信：corpId / agentId / secret / 回调配置是否已具备（不具备则只做预留）。
5. 金额存储是否接受「整数分」（强烈建议接受）。
6. 前端是否同意从「单文件打包」改为「常规分包」。
7. 迁移窗口可接受的最长停写时间（默认 15 分钟）。
8. 旧数据保留期（默认 Vercel/KV 保留 30 天后归档下线）。

## 7. 建议的执行顺序

1. 先确认本计划与信息清单（本文件第 6 节）。
2. 立即执行 P0（数据备份 + env 模板 + 分支保护），不阻塞任何业务。
3. P1、P8 可并行；P2 依赖 P1；P3/P4 依赖 P2（部分可先行）。
4. P5 与 P6 串行推进（部署在前，自动化在后）。
5. P7、P9 收尾并留 30 天观察期。

> 每阶段结束向用户提交验收报告；未获确认不进入下一阶段。
