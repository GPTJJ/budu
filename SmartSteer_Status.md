# BUDU / SmartSteer 项目状态

> 更新时间：2026-08-23（Asia/Shanghai）
> 用途：供新的 Codex 任务快速接续 BUDU 项目。
> 事实口径：先以 `CURRENT_ARCHITECTURE.md` 为架构基线，再以本文记录的 Git、线上部署、合规和近期分支状态为补充。本文不构成生产写入、迁移、支付启用或部署授权。

## 0. 状态总览

| 项目 | 当前事实 |
|---|---|
| 正式域名 | `https://buducandy.cn` |
| 公共 DNS 实测 | `154.8.195.42`（北京） |
| 公网健康状态 | `200 OK`，`/api/health` 返回 `ok: true` |
| 公网运行提交 | `2d70da1341ae9c543d3b909b7b33efacf99a7fac`（受控部署，尚未合并/推送 main） |
| 公网环境标识 | `APP_ENV=prod` |
| 公网应用版本 | `V2.19` |
| 远端主分支 | `origin/main` = `a2e2519901376e174a61760424ae3f2a8222f6c0` |
| 当前开发分支 | `feat/wecom-push` |
| 当前已部署代码 HEAD | `2d70da1341ae9c543d3b909b7b33efacf99a7fac` |
| 分支关系 | `feat/wecom-push` 比 `origin/main` 多 7 个提交（含本状态文档提交）；功能分支已推送，尚未合并 main |
| 当前分支迁移 | 27 个 Prisma migration；北京生产恢复库已全部应用，最新为 `20260823000000_wechat_binding_security` |
| 最近本地验证 | 2026-08-23：Playwright 34/34；企微专项 16/16；`npm run test` PASS 27/27；`npm run test:critical` PASS 10/10；build/SSR PASS；`git diff --check` clean |
| ICP | 主体备案已完成，备案号 `京ICP备2026054094号-1` |
| ICP 悬挂 | 已解除：2026-08-23 公网 JS 实测同时包含 `京ICP备2026054094号-1` 与 `beian.miit.gov.cn` |
| 公安联网备案 | 已进行注册、填写和材料上传；尚无可验证的公安备案号，按待审核/待最终悬挂处理 |
| 北京迁移 | DNS 已指向北京；生产恢复库完成 25→27 migration；公网 `env=prod`、SHA/前端哈希/守卫验收通过；旧恢复 API 保留为快速回滚目标 |

## 1. 已完成内容

### 1.1 门店管理与移动端

- 登录、JWT httpOnly Cookie、会话、账号管理。
- 六个正式角色：开发者、管理员、财务、店长、员工、门店收银；Public 已停用。
- 账号级模块授权、门店范围、员工绑定、调货跨店范围授权。
- 移动首页工作台、经营分析、自然周筛选、待办、门店经营、最近动态。
- 业绩录入、排班、人员、工资、邮寄、财务、发票、审批、库存、档案馆、系统设置、通知中心。
- PWA、iPhone 安全区、移动底栏、右滑返回、下拉刷新、固定中文界面。

### 1.2 人员与工资

- 全职/兼职员工主档、员工卡片、工时、基础工资、提成、大单奖。
- 官舍店调货补贴：自 `2026-08-01`（含）起，明确识别为官舍值班的员工额外 `2 元/小时`，全职和兼职均适用。
- 开发者每日工资调整：不调整时用自动工资；调整后以开发者设定值为准并展示明细。
- 工资明细与 Excel 导出；工资条生成、正式发放、签收。
- 已发工资条使用 PostgreSQL `PayrollNotice` 保存快照。

### 1.3 商品、库存与 POS

- 商品中心：稳定 `product_id`、唯一 SKU、分类、售价、成本、单位、图片、条码、上下架、库存参与开关、排序。
- 商品 Excel 导入/导出和自动字段识别。
- iPad 横屏 POS 三栏点单、每行 3 个商品、搜索、购物车、赠送、折扣、备注、订单记录和当日汇总。
- PostgreSQL 订单、订单行、支付、退款、支付日志；金额统一以整数“分”持久化，并保存成交快照。
- 订单/支付状态机、幂等结算、重复支付防护、Mock 支付、现金支付和退款基础能力。
- `CameraScanner` 使用 `getUserMedia()` + ZXing；付款码设计为仅在内存传递、不长期保存原文。
- 调拨、采购、库存余额及流水流程已存在。
- POS 销售尚未自动扣减库存，这是当前明确边界。

### 1.4 审批、通知与档案

- PostgreSQL 审批中心：草稿、提交、审批、驳回、撤回、归档、抄送、附件和日志。
- PostgreSQL 通知中心：站内消息、投递记录、个人微信绑定模型和业务通知聚合。
- 档案馆：分类、文件、版本、访问授权、操作日志和到期提醒。
- COS 和 Sentry 均为代码已接入、配置后启用。
- 企业微信群机器人告警已有入口，依赖 Webhook。

### 1.5 架构、测试、迁移和合规

- `CURRENT_ARCHITECTURE.md` 已建立当前架构事实基线（基线提交 `c396c9`）。
- 统一隔离测试入口：`npm run test`、`npm run test:critical`。
- User KV → PostgreSQL 只读迁移盘点工具完成；正式 Backfill 尚未执行。
- 北京迁移历史 Gate 已完成：Golden Backup、隔离恢复演练、最终恢复、DNS 切换、写权限交接。
- ICP 主体备案成功，备案页脚代码提交 `2cadc0d` 已进入 main。
- 软件著作权申请/实名认证流程已经提交并曾收到认证成功反馈；最终证书以官方平台为准。

### 1.6 当前企微开发分支（已部署公网、尚未合并 main）

- `4269a30`：企微自建应用个人推送，共享 access token 缓存、失效重试、错误详情、测试和配置文档。
- `d2eda74`：修正 EncodingAESKey 格式。
- `26ff356`：系统设置新增管理员手动绑定企业微信 userid；新增手动绑定/查询 API 和 PostgreSQL 集成测试。

### 1.7 企微绑定安全加固（2026-08-23，已提交并部署）

- 扫码 OAuth `state` 改为 PostgreSQL 10 分钟一次性随机票据，仅存 SHA-256 哈希；公开回调不再依赖登录 Cookie，伪造、过期和重放均拒绝。
- 移除回调 Token/EncodingAESKey 硬编码兜底；两项缺失或格式非法时回调端点 fail-closed（503）。
- 消息卡片与扫码回调只接受安全的 `PUBLIC_BASE_URL`；移除 `budu-hk.online` 运行时 fallback，生产模板明确使用 `https://buducandy.cn`。
- 手动绑定收紧为仅 Developer；写入前校验系统账号存在且启用、企微 userid 格式和活动身份唯一性。
- 新增绑定审计表、活动身份部分唯一索引、脱敏 API/UI 展示；本人解绑同步写审计。
- 新迁移：`20260823000000_wechat_binding_security`。迁移若发现既有重复活动绑定会安全失败，部署前必须先做只读重复检查。

### 1.8 2026-08-23 修复、Gate 与北京受控部署

- P1：移动 Header 工具栏改为手机单列/双列响应式布局，门店选择器不再被横向裁剪；375/390/430px 均有溢出断言。
- P2：`PosPage` 仅在真实微信付款时校验 18 位付款码，mock 测试码恢复兼容。
- 生产 Gate：真实恢复库全量备份恢复到隔离临时库，25→27 migration dry-run 成功；37 笔支付、1 条企微绑定行数不变，重复活动微信身份组为 0。
- 生产迁移：`20260822000001_wechat_pay_reconciliation` 与 `20260823000000_wechat_binding_security` 已应用；失败 migration 为 0。
- 生产存储：新增显式 `DATA_STORE=file` + `DATA_DIR=/app/server/data`，修复自建服务器文件存储与 `APP_ENV=prod` 校验冲突，避免误接历史 KV。
- 生产运行：公网容器 `budu-prod-2d70da1-api` 为 healthy；`PAYMENT_MODE=mock`、`WECHAT_PAY_ENABLED=0`；最近日志无 error/fatal/unhandled。
- 回滚：旧 `c396c997d523` 恢复 API 保持 healthy；迁移前数据库备份及 Nginx 切流前配置备份存放于北京服务器 `~/.budu-backups`。

## 2. 当前代码结构

```text
budu OS/
├── src/
│   ├── components/
│   │   ├── Dashboard.jsx              SPA 视图分发中心
│   │   ├── HomeWorkspace.jsx          移动首页工作台
│   │   ├── BusinessAnalysisPage.jsx   经营分析
│   │   ├── PersonnelPage.jsx          人员
│   │   ├── PayrollPage.jsx            工资
│   │   ├── StoreEntryPage.jsx         业绩录入
│   │   ├── SchedulePage.jsx           排班
│   │   ├── PosPage.jsx                iPad POS
│   │   ├── OrderRecordsPage.jsx       订单记录
│   │   ├── ProductCenterPage.jsx      商品中心
│   │   ├── InventoryRequestPage.jsx   调拨/采购/库存
│   │   ├── ApprovalCenterPage.jsx     审批
│   │   ├── AssetCenterPage.jsx        档案馆
│   │   ├── SettingsPage.jsx           系统设置
│   │   └── ComplianceFooter.jsx       备案页脚
│   ├── utils/                         API、selectors、缓存、工资、POS、Excel
│   └── data/                          静态兼容配置
├── server/
│   ├── index.js / app.js              Express 入口、鉴权、路由装配
│   ├── auth.js / store.js             Auth、Upstash/KV/JSON 兼容层
│   ├── pg.js                          Prisma Client
│   ├── daily-entry-upgrade.js         PG 日报
│   ├── products.js                    商品主档
│   ├── pos.js / pos-core.js           POS 与结算
│   ├── payments/                      PaymentService、Provider、微信 V2、核对器
│   ├── approvals*.js                  审批
│   ├── payroll-notice.js              工资条快照
│   ├── notification-center.js         通知/个人微信推送
│   ├── wechat-bind.js                 企微/公众号绑定
│   ├── asset-*.js                     档案馆/COS
│   └── v2.js                          库存、采购、调货、财务、发票、邮寄
├── shared/accountPermissions.js       共享角色/模块权限
├── prisma/schema.prisma               PostgreSQL 模型
├── prisma/migrations/                 additive migrations
├── scripts/                           测试、部署、备份、迁移、盘点
├── tests/                             Playwright 手机/iPad 场景
├── deploy/nginx/                      Nginx
├── .github/workflows/                 CI、北京生产/香港测试手动部署
├── CURRENT_ARCHITECTURE.md            权威架构事实基线
└── SmartSteer_Status.md               本状态文件
```

### 2.1 数据源事实

| 域 | 当前主要/权威来源 | 兼容层与风险 |
|---|---|---|
| User | KV/JSON `users[]` | Prisma User 尚未正式接管运行时 |
| Staff | KV Staff | PG Staff 是镜像；还合并 Analysis/静态员工 |
| Schedule | KV 周排班 | PG DailyStoreStaff 是实际按日值班；未统一 ID |
| DailyEntry | PostgreSQL 为主要权威方向 | 仍双写 KV + PG；localStorage 仅缓存/镜像 |
| Analysis | KV `analysis{}` | 尚未迁移 PG |
| POS/Payment/Refund | PostgreSQL | 前端会话用 sessionStorage |
| Inventory | PostgreSQL | KV 保留旧数组兼容数据 |
| Payroll | 前端计算 + PG 日报/奖金/调薪 + KV/静态员工 | PayrollNotice 只是已发快照 |
| Approval | PostgreSQL | 旧审批通知和新通知中心存在双写 |
| Notification | PostgreSQL | 铃铛仍为多源聚合；微信依赖配置 |
| Asset | PG 元数据；COS 配置后存文件 | 未配置 COS 时 Data URL 入库 |

## 3. 关键参数

### 3.1 公开、非敏感参数

- 域名：`buducandy.cn`
- 北京公网 IP：`154.8.195.42`
- 当前版本：`V2.19`
- Node：22。
- PostgreSQL：16；Prisma：`6.19.3`。
- 金额：人民币整数“分”。
- 业务日期：北京时间。
- 官舍调货补贴：`2 元/小时`，生效日 `2026-08-01`。
- ICP：`京ICP备2026054094号-1`，链接 `https://beian.miit.gov.cn/`。
- 正式角色：`developer`、`admin`、`finance`、`manager`、`staff`、`cashier`。

### 3.2 环境变量名称（严禁在文档写入实际值）

| 范围 | 名称 |
|---|---|
| 应用 | `APP_ENV`、`GIT_SHA`、`PORT`、`PUBLIC_BASE_URL`、`DATA_STORE`、`DATA_DIR` |
| PostgreSQL | `DATABASE_URL` |
| KV | `UPSTASH_REDIS_REST_URL`、`UPSTASH_REDIS_REST_TOKEN`、`KV_REST_API_URL`、`KV_REST_API_TOKEN` |
| 认证 | `JWT_SECRET`、`COOKIE_SECURE` |
| COS | `COS_BUCKET`、`COS_REGION`、`COS_SECRET_ID`、`COS_SECRET_KEY` |
| 监控 | `SENTRY_DSN`、`VITE_SENTRY_DSN`、`WECHAT_WORK_WEBHOOK_URL` |
| 企微个人推送 | `WXWORK_CORP_ID`、`WXWORK_AGENT_ID`、`WXWORK_SECRET`、`WXWORK_RECV_TOKEN`、`WXWORK_RECV_AES_KEY` |
| 公众号 fallback | `MP_APP_ID`、`MP_APP_SECRET`、`MP_TEMPLATE_ID` |
| 微信支付 | `PAYMENT_MODE`、`WECHAT_PAY_ENABLED`、`WECHAT_PAY_PROTOCOL`、`WECHAT_PAY_MCHID`、`WECHAT_PAY_APPID`、APIv2 key/证书路径、`WECHAT_PAY_TERMINAL_IP`、`WECHAT_PAY_ENABLED_STORES` |
| 北京部署 | `BJ_HOST`、`BJ_USER`、`BJ_APP_DIR`、`BJ_SSH_KEY`（GitHub Secrets） |

安全规则：

- 不得提交或输出 `.env`、SSH 私钥、付款码、JWT、TLS 私钥及第三方 Secret。
- 微信真实支付保持 `WECHAT_PAY_ENABLED=0`、`PAYMENT_MODE=mock`，直到 Review 和现场 Gate 全部通过。
- 当前 `/api/health` 的 `dbOk` 只检查 `DATABASE_URL` 是否存在，不是真实数据库探针。

## 4. 未解决问题

### P0/P1：版本与生产拓扑

1. 公网提交 `2d70da1` 位于已推送的 `feat/wecom-push`，尚未合并 `origin/main`；必须先 Review/合并，避免线上长期漂移。
2. 北京当前保留主 compose、恢复栈和新公网 API 三套容器；公网路由已明确指向新 API，但后续应在确认观察期稳定后收敛为单一可重复部署拓扑。
3. `/opt/budu` 工作树仍停留 `26ff356`，并保留 DeepSeek 的 Nginx 上游切流修改；自动部署脚本不能在未理解该拓扑时直接 `checkout --force`。
4. 公安联网备案尚无可验证备案号；审核通过后需要增加公安图标、号码和官方链接。

### P0：微信支付

5. 真钱支付继续暂停。生产明确为 `PAYMENT_MODE=mock`、`WECHAT_PAY_ENABLED=0`。
6. `fix/wechat-pay-review-r1` 尚未最终通过 Review；商户号、AppID、APIv2 密钥、证书、门店灰度、撤销/核对告警仍需独立现场 Gate。

### P1：企业微信个人推送

7. 安全加固已部署并通过技术 Gate，但尚未执行真实员工闭环验收：绑定 → 测试消息 → 工资条 → 微信收取 → 点击直达。
8. 真实企微验收需控制接收人和消息内容，不能用生产全员广播代替灰度测试。

### P1：数据与架构债务

9. User、Staff、Schedule、Analysis 仍由本地 JSON/KV 兼容层承载，尚未完全迁移 PostgreSQL；User Backfill 只有只读盘点。
10. JSON/KV 整库写入存在并发覆盖；Staff 镜像失败可能被忽略；DailyEntry 双写不在同一事务。
11. PG 空结果时旧 JSON/localStorage DailyEntry 镜像可能继续显示；门店静态/JSON/PG 多源，审批通知仍双写。
12. 工资条后端没有按服务端完整工资规则独立重算客户端快照；POS 销售没有自动扣库存闭环。

### P1：运维与质量

13. `/api/health.dbOk` 仍只检查 `DATABASE_URL` 是否存在，需要真实、超时受控的数据库 readiness 探针。
14. 已验证北京本机备份和一次隔离恢复，但 COS 离机备份、保留策略和持续恢复演练仍需独立核验。
15. Sentry、COS、告警和个人微信通知的生产配置需继续做脱敏巡检。
16. `CURRENT_ARCHITECTURE.md` 基线为 `c396c9`，尚未覆盖 ICP、支付初版、企微安全和新的北京恢复拓扑。
17. 工作区另有非本任务来源的未跟踪文件 `audit-budu.mjs`、`docs/REQUIREMENTS_SPEC.md`、`docs/TECH_HIGHLIGHTS.md`，本次未评估、未提交、未触碰。

## 5. 下一步建议

### 第一优先级：观察、合并与拓扑收敛

1. 观察公网 `2d70da1` 的错误日志、登录和关键业务读写；异常时通过已保留的旧恢复 API 和 Nginx 备份快速回滚。
2. Review 当前 6 个分支提交，合并并推送 main，使 GitHub 与公网批准版本重新一致。
3. 把恢复数据库、文件数据卷、Secret 挂载和 Nginx 外部网络固化为正式 Compose/Runbook，再下线冗余 API/PG 容器。
4. 更新 `scripts/deploy-remote.sh`，使它识别当前恢复拓扑、验证真实数据库 readiness，并避免误切回旧主库。

### 第二优先级：企业微信灰度验收

1. 指定一个测试员工，验证企微可见范围、可信域名、userid 绑定、state 防重放、解绑/换绑。
2. 闭环验收：绑定 → 测试消息 → 发测试工资条 → 微信收到 → 点击直达 → 未授权拒绝。
3. 小范围灰度；微信失败不得阻断站内通知和工资条正式发放。

### 第三优先级：数据与运维治理

1. V3-004B 只进入 Backfill Technical Design；生产写入另开 Task 和 Review。
2. 依次收敛 User、Staff、Schedule、Analysis，每次只迁移一个权威域并提供对账/回滚。
3. 增加真实 DB readiness、备份新鲜度、COS 恢复性和告警投递监控。
4. 稳定合并后更新 `CURRENT_ARCHITECTURE.md`。

### 暂缓

- 微信真实支付：继续显式关闭。
- POS 自动扣库存：等待独立设计。
- User JSON/KV → PG 正式 Backfill：未获生产执行授权。
- 旧服务器不可恢复清理：等待北京稳定观察、备份恢复及合规验收完成。

## 6. 新任务接续方式

新任务开场发送：

> 这是项目状态文件，请先读取 `SmartSteer_Status.md`，并基于它继续开发。

新 Codex 必须：

1. 读取本文与 `CURRENT_ARCHITECTURE.md`。
2. `git fetch origin --prune`，重新确认 main、分支、工作区和公网 `/api/health`，不要把本文 SHA 当成永久事实。
3. 明确需求作用于本地分支、main、测试环境还是北京生产。
4. 涉及生产写入、迁移、支付、权限、备案或部署时，先给出范围、风险、验证和回滚 Gate。
5. 绝不读取、复制或输出 Secret 的实际值。
