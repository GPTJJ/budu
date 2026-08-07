# BUDU 项目状态快照（对话恢复指南）

> 本文件是项目的“存档点”：即使对话丢失、换电脑或开新会话，
> 任何新会话读一遍本文件即可完整恢复上下文，继续开发。

## 基本信息

- 项目路径（本机）：`/Users/apple/Desktop/budu OS`（原 Windows 机：`C:\Users\Administrator\Desktop\budu`）
- 项目名称：BUDU 甜蜜运营系统（React 18 + Vite + Tailwind + Express + Upstash KV）
- 线上正式地址：**https://budu11.vercel.app**（已上线可用）
- GitHub 仓库：https://github.com/GPTJJ/budu （分支 `main`，Vercel 自动部署）
- 管理员账号：`budu`（第一个注册用户，密码由用户本人持有）
- 技术栈说明：本地 `npm run server` 用 JSON 文件存储；Vercel 上自动用 Upstash KV（环境变量驱动）

## 进度保存与同步约定（用户指令，所有会话必须遵守）

用户说「保存当前进度」或「保存当前进度并同步」时，执行以下固定流程：
1. 更新本文件：把本次完成的工作写入「最新进度快照」；同步 HEAD 提交号、服务器状态、待办清单；
   涉及服务器变化时同步更新本机 `tools/TENCENT_SERVER_NOTES.txt`（该文件不入 git）
2. 检查代码变更是否完整、无未提交修改；必要时先跑构建/冒烟测试再保存
3. `git add -A && git commit -m "docs: 保存当前进度..." && git push origin main`
4. 若本次变更包含部署相关代码（Docker/Nginx/后端），同步到腾讯云服务器：
   `cd /opt/budu && git pull --ff-only && docker compose up -d --build`
   （如当时不适合上线，在回复中明确说明未同步及原因）
5. 向用户回复：保存了哪些内容、HEAD 提交号、是否已同步到服务器

> 该约定同样适用于另一台电脑的新会话：新会话读完本文件后按此执行。

## 最新进度快照（2026-08-07）

当前远端 HEAD：`9a48a5c`（新增 Upstash 只读脚本），本地与 GitHub 同步。

今日已完成：
1. **架构评审**（用户授权角色：首席架构师，未改业务代码）：输出《架构分析报告》`docs/ARCHITECTURE_ANALYSIS.md` 与《分阶段迁移计划》`docs/MIGRATION_PLAN.md`（P0–P9，约 6–9 周；目标：PostgreSQL+Prisma、RBAC、日志/安全链、Docker/Nginx/HTTPS/腾讯云、GitHub Actions、企业微信预留）
2. **腾讯云迁移启动（网址优先，P5 前置）**：用户确认“先把网址的问题解决，把 BUDU 迁到腾讯云”
3. 新增部署全套物料（未改业务逻辑）：
   - `Dockerfile`（node:22-alpine 多阶段，非 root 运行，含健康检查）
   - `docker-compose.yml`（api + nginx，持久卷、restart、健康依赖）
   - `deploy/nginx/`（entrypoint 按 HTTP_ONLY 生成 HTTP/HTTPS 配置；HTTPS 模板含 HSTS、gzip、安全头、/api 反代）
   - `.env.example`（全部变量注释；预留 DATABASE_URL 与 WECHAT_WORK_*）
   - `.github/workflows/deploy.yml` + `scripts/deploy-remote.sh`（推送 main → SSH → compose 构建重启 → 健康检查 → 失败自动回滚）
   - `scripts/backup-kv.mjs`（只读备份，优先用只读令牌，不打印密钥）
   - `docs/RUNBOOK_TENCENT.md`（开通清单、初始化、首次部署、证书、Secrets、备份恢复、回滚、FAQ）
4. 本地验证：`npm run build` 通过；服务 `/api/health` 返回 200
5. 迁移基线备份：`backups/kv-snapshot-20260807063154.json`（3 用户 / 1 员工 / 20 个业绩 key / 1 门店；**含 meta.secret，未提交 git，注意保管**）
6. **门店排班功能（新需求，已开发完成）**：
   - 菜单：门店经营 → 新增「门店排班」子菜单
   - 按周排班：默认定位本周（周一起始），支持上一周/下一周/本周切换，显示第几周与周范围
   - 按门店切换：内置三店 + 开发者自定义门店全部可选
   - 七天排班表：每天可添加/删除员工排班（员工姓名 + 班次时间 + 备注，姓名支持从员工名单快捷选择）
   - 数据存储：服务端共享数据新增 `schedules` 字段（周一起始日期 → 门店 key → 日期 → 班次数组），
     校验/规范化在 `server/app.js`，公开角色禁止修改；保存后所有登录账号实时同步
   - 班次时间改为下拉选项：早班 / 晚班 / 通班（数据字段仍为 time，历史数据兼容）
7. **首页头部优化**：右上角「全部门店 / 日历」只在首页概览显示，进入其他板块自动隐藏；
   其他板块顶部显示当前页面标题；主内容区限宽（max 1600px），大屏布局更整齐
8. **商品目录支持增删改**：新增自定义商品（名称/所属门店/价格/备注），可编辑、删除；
   自定义商品与报表商品并存展示（单店视图同名覆盖报表商品），图片随改名自动迁移；
   服务端 `products` 字段带校验，公开角色禁止修改
9. **自助注册关闭**：登录页移除注册入口，新账号只能由开发者创建；
   后端 `POST /api/auth/register` 仅首个账号可注册（空库引导），其余返回 403；
   新增 `POST /api/admin/users`（开发者专用，用户名/密码/角色校验齐全）；
   账号管理页新增「新增账号」弹窗；接口测试/构建/冒烟全部通过
10. **网页提速**：移除单文件打包（vite-plugin-singlefile），改为常规分包：
    入口 HTML 从 1.03MB 降至 0.58KB；JS（gzip 234KB）/CSS（gzip 7KB）带 hash 长期缓存
    （Cache-Control immutable），HTML 每次重校验；Nginx 补 gzip_vary；
    首次打开更快、之后秒开（后续可再按页面懒加载进一步缩小首屏）
11. **加速/CDN 准备**：所有 `/api` 响应已加 `Cache-Control: no-store`（防 CDN 缓存动态数据）；
    输出《CDN_TENCENT.md》方案：未备案 → 轻量优选流量包（推荐）；
    备案后可切腾讯云 CDN/EdgeOne 大陆节点（规则已定义：/api 不缓存、静态 1 年、HTML 不缓存）
12. **前端懒加载瘦身**：抽出 `Dashboard` 组件并按需加载；
    登录首屏 JS 从 870KB 降至 **176KB（gzip 58.7KB）**；登录后再加载 Dashboard（gzip 163KB）；
    各功能页（人员/业绩/排班/商品/分析/设置/账号）独立分包 6–13KB，点开才下载
13. **门店运营账号隐藏首页经营数据**：KPI 卡片、门店排行、营业额趋势、渠道构成、
    商品销售 TOP10、员工绩效当班营业额、重要提醒中的经营类通知全部对门店运营角色隐藏
    （显示 ••• / 占位文案，经营数据仅开发者可见）；对外展示角色逻辑保持不变
14. **库存调拨**：菜单「库存采购」改为「库存调拨」，展开两个入口——申请调货 / 申请采购；
    可提交调货（调出/调入门店 + 商品 + 数量 + 备注）或采购申请，存云端 `inventoryRequests`，
    列表展示待处理/已完成，开发者可删任意申请、申请人可删自己的；服务端带校验
15. **调货/采购申请支持多行货品**：一次申请可添加多行（商品名称 + 数量 + 行备注，可增删行），
    提交后按 `items[]` 存储并兼容旧单行格式；列表按货品标签展示全部种类
16. **申请货品改为“挑选-添加”流程**：产品下拉选择 → 数量/备注 → 点“添加到申请列表”进本次列表，
    清空后可继续挑下一个；全部选完再提交整单（已提交申请列表展示逻辑不变）
17. **调货/采购申请可自定义门店**：调出/调入门店下拉增加「＋ 自定义门店」，填名称即添加
    （新增 `POST /api/stores` 仅追加接口，门店运营/开发者可用，公开角色 403，重名 409）
18. **自定义门店改为一次性 + 货品分类**：
    - 自定义门店只用于当前申请（本地临时 key + `storeName`/`fromStoreName` 随申请存档），
      不再写入全局门店列表、不进下拉
    - 挑选货品前先选类别：产品（目录下拉）/ 物料（自由输入）/ 其他（自由输入），
      每行货品带类别标签（产品/物料/其他）保存与展示
19. **产品选择二级菜单**：点「选择产品」先选品类（散糖/礼盒/生巧/冰淇淋/巧克力豆/试吃/其他），
    再选具体产品；`src/utils/productCategories.js` 按名称自动归类（可后续调整规则）
20. **右上角新增刷新按钮**：消息铃铛左侧加刷新图标（桌面/移动端各一份），点击重新加载页面
21. **散糖分类固定 NO.1–NO.12 选项**：散糖二级菜单固定提供 12 个编号口味
    （NO.1树莓 … NO.12巧克力，`NO_CANDY_NAMES`），NO.* 名称自动归入散糖
22. **库存申请实时通知开发者**：员工提交调货/采购申请后，开发者消息铃铛 8 秒内出现未读红点；
    点开可见申请（类型/门店/货品数/提交人/时间），可跳转对应页面或一键全部已读；
    实现：`inventoryAlerts.js` 轮询 + `NotificationBell.jsx`（未读数存 localStorage）
23. **申请列表升级**：分「待处理/已处理」页签（带数量角标）；按提交日期倒序排列；
    支持起止日期范围查询与清空；开发者可一键「标记已处理」/「恢复待处理」
24. **货品清单可下载**：本次申请或任意已提交申请可打开「货品清单」弹窗
    （门店/提交人/时间/逐项货品+数量+备注），一键下载 PNG 图片（html-to-image），方便门店找货
25. **移动端保存修复**：手机点击下载改为优先调起系统分享（可存相册/发微信）；
    不支持时弹出清单图片，长按保存到相册或浏览器打开（此前 a.download 在手机端不落相册）
26. **消息提示音**：收到新申请时铃铛响三连音提示（Web Audio 合成，无音频文件）；
    首次点击页面后解锁声音（浏览器自动播放策略）；铃铛下拉可开关提示音（localStorage 记忆）
27. **全员实时同步**：数据自动同步从「仅开发者」扩展为「所有登录账号」，统一 8 秒刷新一次；
    任一设备录入业绩/提交申请后，其他设备（含门店运营/对外展示）8 秒内自动更新
28. **调拨审批与库存联动**：在现有调货/采购、分类选品、清单下载、通知和实时同步基础上补齐：
    - 调货状态：待审核 → 运输中 → 已完成，待审核可驳回
    - 开发者审核并发货时自动扣减调出门店库存，库存不足禁止发货
    - 确认收货时自动增加调入门店库存；记录操作账号、时间及驳回原因
    - 新增门店库存台账及开发者“库存盘点/调整”，用于初始化和修正库存
    - 服务端新增 `inventory` 数据校验，并兼容旧调货单 `done` 状态迁移
    - 库存规则、API 保存读取、25 个组件 SSR 冒烟和生产构建均已通过

## M1「门店账号绑定与权限隔离」实施记录（2026-08-08）

已完成并验证（后端接口测试 22 项全过 + 前端冒烟 26 项全过）：
- 角色升级：`developer / manager(店长·区域负责人) / staff(店员) / public`；
  User 增加 `storeKeys[]`；旧 `store` 账号自动迁移为 manager 且 storeKeys 留空（需开发者重新绑定）
- 权限隔离：GET /api/userdata 按绑定门店过滤（业绩/员工/排班/商品/申请单/门店列表/分析）；
  PUT 改为合并语义——非开发者只能增删改自己授权门店的数据，他店数据原样保留，越权 403
- 账号管理：创建/编辑账号支持多选绑定门店；未绑定门店账号登录后显示占位页
- 调货状态机：`待审核 → 已发货 → 已收货`；调出门店 manager 可发货、调入门店 manager 可确认收货，
  店员不可审核；新增 `/api/inventory/requests/:id/ship|receive`（权限+状态校验）
- 通知：开发者/店长可见本店相关申请（含待发货/待收货），按状态过滤

待办：M2「库存后端化 + PostgreSQL」（Prisma、库存/申请/业绩迁 PG、事务化收发货、ETL 对账、前端 v2 切换）

## M2「库存后端化 + PostgreSQL」实施记录（2026-08-08）

已完成并上线验证：
- PostgreSQL 16（docker-compose 新增 postgres 服务 + 数据卷）+ Prisma 6
- 首批表：Store/User/Staff/DailyEntry/InventoryItem/StockBalance/StockLedger/
  TransferRequest+Item/PurchaseRequest+Item；金额按分(BigInt)、DailyEntry 唯一约束+版本乐观锁
- v2 API：业绩读取/单条 upsert（409 冲突返回最新）、调货创建/发货/驳回/收货（事务扣增库存+流水）、
  采购创建/收货入库（实收差异）、库存余额与流水查询；权限按绑定门店过滤
- KV→PG 迁移脚本（幂等，--dry-run/--reconcile）：已迁移 2 门店/3 用户/1 员工/28 条业绩，对账一致
- 前端业绩：读取以 PG 为权威源，保存走 v2 upsert（带版本冲突回退），KV 保留为兼容层
- 每日 pg_dump 备份脚本（保留 7 天，scripts/backup-pg.sh）

剩余（后续批次）：库存/申请单前端切 v2（当前申请单与库存台账仍走 KV）、盘点/报损/预警、
SKU/条码/供应商增强、自动备份同步 COS 与告警

更新（2026-08-08 追加）：
- v2 补齐查询/删除/盘点接口：GET /v2/transfer-requests、GET /v2/purchase-requests、
  DELETE（仅待审/待处理，创建人或开发者）、POST /v2/stock/adjust（事务写余额+流水）
- 前端申请单/库存切 v2：提交走 v2 创建、发货/驳回/收货走 v2、采购改为「收货入库」（按实收入库）、
  删除走 v2；库存面板改为 v2 盘点调整；loadUserData 以 v2 为申请单/库存权威源（KV 回退）

## M3「SKU/供应商+预警 / COS 备份告警 / 财务会员 MVP」实施记录（2026-08-08）

已完成并待部署验证：
- 新迁移 `20260808010000_next_batch`：Supplier、WasteRecord、AlertLog、Expense、Member、
  MemberConsumption；StockBalance.minQty（安全库存）；PurchaseRequest.supplierId
- v2 新接口：货品档案增改查（unit/spec/barcode/category）、供应商增改查、
  报损（事务扣库存+流水+记录）、缺货预警查询、企微测试、费用增删查、
  门店利润（日/月+排名）、利润 CSV 导出、会员增查/消费/积分/生日名单
- 前端：库存面板（盘点+安全库存+报损+货品档案+流水筛选+低库存高亮）、采购表单（供应商+预计到货）、
  铃铛新增库存预警类目、财务利润页、会员营销页、设置页企微测试按钮
- 备份：脚本支持 COS 上传（cos-nodejs-sdk-v5，未配置则跳过）+ 备份失败企微告警；
  Actions 部署失败企微通知步骤

待用户提供：`WECHAT_WORK_WEBHOOK_URL`、`COS_SECRET_ID/KEY/BUCKET/REGION`（服务器 .env.production）

部署验证（2026-08-08）：迁移 `next_batch` 已应用；items/suppliers/alerts/waste-records/expenses/profit/
members/birthdays/transfer/purchase/stock 全部 200；profit 返回 28 行；修复利润接口开发者过滤 bug（0490400）

更新：新调货申请提交后推送企业微信「新调货申请」提醒（待审核）；企微 Webhook 已配置并测试通过
更新：企微提醒已覆盖采购申请提交 / 调货发货 / 调货收货 / 采购入库四个节点
更新：账号管理支持「绑定员工」（一对一，取自人员管理名单）；绑定后店员账号在人员管理中仅见本人档案；
     未绑定店员名单为空；后端 staffKey 校验与过滤（接口测试 5 项通过）
更新：绑定员工弹窗改用完整人员名单（含报表/分析员工，不再只显示本地 1 人）；
     后端放开静态员工绑定校验；人员管理页对绑定账号按本人过滤（含静态员工）
更新：修复白屏——新增全局 ErrorBoundary（渲染/懒加载分片错误不再白屏，
     发版后旧分片 404 自动刷新一次恢复）；PWA 缓存升级 v5 清理旧缓存

## 腾讯云部署进度（2026-08-07 下午）

- 服务器：`124.156.171.195`（腾讯云轻量香港/OpenClaw 龙虾镜像，2核2G/40G，实例 lhins-gkqyrkst）
- 已安装：Docker 29.1.3 + Compose 2.40.3；项目克隆到 `/opt/budu`
- 已启动：`budu-api-1`（健康）+ `budu-nginx-1`（80/443）；Nginx 本机验证通过：
  `/api/health` 返回 ok、首页正常返回（此前修复了镜像默认站点抢占 80 端口 + 脚本可执行位）
- 服务器环境：`.env`（DOMAIN 占位 + HTTP_ONLY=1）、`.env.production`（KV 线上密钥，未入库）
- **已完成（2026-08-07 晚）**：
  1. 腾讯云防火墙已放行 80/443（用户控制台操作）
  2. 域名 `buducandy.cn` DNS A 记录 → `124.156.171.195`；服务器 `.env` 已更新 DOMAIN + HTTP_ONLY=0
  3. 证书已部署（deploy/certs/fullchain.pem + privkey.pem），HTTPS 正常
  4. **正式网址 https://buducandy.cn 已验证上线**：HTTP 301→HTTPS、HTTPS /api/health 200、
     首页 200（含完整 BUDU 登录页）
  5. **库存调拨审批与库存联动已部署（2026-08-07 22:57）**：腾讯云网页远程命令构建并重启容器成功；
     线上应用代码 `50f7332`，容器健康，公网首页与 `/api/health` 均为 200；线上“申请调货”页已确认显示
     门店库存、库存调整、待处理/已处理及新审批流程。GitHub Actions #31 仍因 SSH Secrets 未配置而失败，本次采用手动部署。
- 说明：直接 IP 访问 80 在部分网络返回 502，为访问方本地代理现象（服务器本机 IP:80 返回 301 正常）；
  域名访问不受影响
- **待办**：GitHub Actions Secrets（TENCENT_HOST/USER/SSH_KEY/APP_DIR）配置自动部署；
  服务器 SSH 密钥登录未生效（Actions 前需修复）；30 天观察期后 Vercel/KV 归档下线；
  P1+ PostgreSQL/Prisma 迁移

## 当前进度存档（2026-08-07 晚）

**已交付功能**：架构分析报告 + 迁移计划（docs/）、腾讯云部署全套物料（Docker/Nginx/GitHub Actions/RUNBOOK）、
门店排班（按周/按门店/早班晚班通班）、商品目录增删改、首页头部只显示概览工具 + 布局优化；
全部已推送到 GitHub（当前 main HEAD `360c32d`），Vercel 线上 https://budu11.vercel.app 保持可用。

**腾讯云服务器**：`124.156.171.195`（香港轻量 2核2G，实例 lhins-gkqyrkst，OpenClaw 龙虾镜像）
- Docker 29.1.3 + Compose 2.40.3 已装；`/opt/budu` 已部署并运行（api healthy + nginx）
- 服务器本机 `/api/health` 通过；公网 80/443 未放行（等 API 密钥或用户控制台操作）
- 登录方式：`ubuntu` + 密码（详见本机 `tools/TENCENT_SERVER_NOTES.txt`，**不提交 git**）
- 本地工具：`tools/plink.exe`、`pscp.exe`、`budu_deploy` 密钥（tools/ 已 gitignore）

**已上线**：https://buducandy.cn（腾讯云香港服务器，Docker + Nginx + HTTPS 全链路已验证）

**下一步**：GitHub Actions Secrets → 自动部署；服务器 SSH 密钥登录修复；30 天观察/回滚窗口；
之后按迁移计划进入 PostgreSQL/Prisma（P1+）。

**恢复指令**：新会话先读 `PROJECT_STATUS.md` 与 `docs/RUNBOOK_TENCENT.md`，再继续腾讯云迁移或功能开发。
   - 新文件：`src/components/SchedulePage.jsx`、`src/utils/schedule.js`
   - 测试：`npm run build` 通过；冒烟测试新增 SchedulePage（20 组件 SSR OK）；
     API 自测通过（保存/读取/非法数据 400）；薪酬单测与集成测试全部 OK

决策：
- 迁移期数据继续用 **Upstash KV**（零数据迁移、可随时 DNS 切回 Vercel）；PostgreSQL 在 P1–P2 再迁
- 服务器 `JWT_SECRET` 暂留空，自动沿用 KV 中 `meta.secret`，现有登录不失效

待用户提供（拿到即可完成部署）：
- 正式域名 + 是否已 ICP 备案（决定大陆/香港服务器）
- 腾讯云服务器公网 IP + SSH 登录方式
- SSL 证书（腾讯云免费证书或 Let's Encrypt）

## 历史进度快照（2026-08-06）

当时远端 HEAD：`6a9507a`（朝外店工时修复），本地与 GitHub 同步，Vercel 已部署。

今日已完成：
1. 多设备开发指南（PROJECT_STATUS + DEPLOY，Codespaces / 本地开发两种方式）
2. 人员管理：删除任意员工（含报表员工），删除后从人员管理/值班选择/员工绩效中隐藏，历史业绩保留
3. 系统设置：中英文界面切换（本机保存）
4. 账号菜单（左下角）：修改密码、本地上传头像、退出登录、切换账号；右上角入口已移除；修改用户名选项已移除
5. 三级角色：开发者（最高权限+账号管理）、门店运营（普通业务权限，细节待定）、对外展示（隐藏所有敏感数字，只保留功能展示）
6. 首页问候语随现实时间自动切换（早上/中午/下午/晚上，每分钟刷新）
7. 数据分析：本地上传 .xlsx/.xls/.csv 报表（月度营业额/菜品明细/薪资表），自动解析并覆盖首页 KPI、门店排行、趋势、渠道、商品销售、员工绩效、人员管理等模块，可一键清除
8. 商品目录：商品管理 → 商品目录，每款菜品独立展示（销量/销售额/收入/优惠），支持上传/移除商品图片并跨设备同步；首页商品销售显示上传图片并可点击跳转
9. 修复：Vercel 各接口路由（账号管理/数据分析/修改头像与密码）、package-lock 补齐 xlsx 依赖

今日后续更新：
10. 员工添加/删除均仅限开发者（前端隐藏 + 后端拒绝非开发者变更员工名单）
11. 门店运营账号隐藏个人隐私（工时/工资/提成/ROI），姓名与营业额正常展示，其余功能正常
12. 首页员工绩效 TOP5 改为根据每日门店业绩录入实时分析（营业额/订单按值班人数均摊），无录入时回退薪资表
13. 人员管理与首页概览默认定位当前月份；右上角日历保留任意月份/日期自由选择
14. 手机端适配优化（顶栏自动换行、日历手机可用、录入表单单列），并修复日历下拉被滚动容器裁剪的问题
15. 员工薪酬自动计算：根据每日门店业绩录入实时生成工资/提成/工时，通盈店区分工作日与节假日（含 2026 法定节假日及调休补班），按门店阶梯提成（目标 2000/节假日 5000，每超 1000 加 5 元/h）；1 人值班按门店标准工时（通盈/西单 12h、朝外 11.5h、官舍 11h）并享受 30 元/h（28+2 加班补贴），2 人及以上各 8h、28 元/h；未达当日目标不提成
16. 修复：朝外店（及通盈/西单/官舍）作为“新增门店”加入时 key 为自动生成值，薪酬配置改为“先按 key、再按门店名”匹配，避免单人工时被回退成 12h
17. 本地环境连接线上数据：已通过 Vercel CLI 拉取生产环境变量到 `.env.local`（已 gitignore），本地脚本可直接只读 Upstash 共享数据；新增 `scripts/read-upstash.mjs`（加载 .env.local 并打印门店/员工/当月业绩录入，不输出密钥）

当前账号：`budu` = 开发者（最高权限）。本地与线上数据均为测试后恢复的干净状态。

下一步候选（用户未确认）：门店运营角色具体权限、对外展示模式细节、账号管理补充（新增账号/禁用账号）、密码找回、商品图片批量上传等。

## 数据存放与备份（防丢失）

| 位置 | 说明 |
| --- | --- |
| Upstash KV（线上） | 生产数据：用户、业绩录入、员工名单（Vercel → Storage 可查看） |
| `server/data/db.json`（本地） | 本地模式数据 + 线上数据的离线备份点 |
| 旧浏览器 localStorage | 首次登录会自动迁移到服务端 |

备份/恢复方法：
```powershell
# 备份：复制 server/data/db.json 或直接在 Vercel Storage 导出
# 恢复：把 db.json 放回原路径后 npm run server；线上恢复用迁移脚本
npx vercel env pull     # 生成 .env.local（含 KV_REST_API_URL / KV_REST_API_TOKEN）
node scripts/migrate-upstash.mjs   # 把本地 db.json 推送到线上 KV
```

## 常用命令

```bash
npm run dev        # 前端开发（Vite，5173，/api 代理到 3000）
npm run build      # 生产构建（单文件 dist/index.html）
npm run server     # 本地完整服务（http://localhost:3000）
node scripts/smoke-render.mjs       # SSR 冒烟测试（19 个组件）
node scripts/test-payroll.mjs       # 薪酬规则单元测试（含用户示例与 2026 节假日）
node scripts/test-payroll-integration.mjs  # 薪酬 selectors 集成测试（模拟业绩录入）
node scripts/start-public.mjs       # 本机 + 公网隧道（临时用）
node scripts/migrate-upstash.mjs    # 本地数据 → 线上 KV
npx vercel env pull                 # 拉取线上环境变量
```

## 开发约定（务必遵守）

- 功能改动完成前必须先自测通过再交付/推送：前端 `npm run build`、SSR 冒烟 `node scripts/smoke-render.mjs`、相关接口用临时账号实测（测完恢复数据）。
- 涉及线上部署时，部署完成后核对线上 URL 对应的接口/页面是否正常，再向用户报告完成。
- 每次任务完成后，自动更新本文件，并把最新版本同步保存到桌面 `~/Desktop/budu-项目进度.md`（本机存档点）。

## 关键文件

- `server/app.js` — Express 应用（路由/鉴权/数据接口）
- `server/store.js` — 存储适配层（本地 JSON ↔ Upstash KV 自动切换）
- `server/auth.js` — 密码哈希（scrypt）+ JWT
- `api/` — Vercel Serverless 函数（health/register/login/logout/me/userdata）
- `src/` — React 前端（App.jsx 登录门禁；LoginPage.jsx；PersonnelPage.jsx 人员日视图）
- `src/utils/userData.js` — 共享数据缓存 + 防抖同步 + 旧数据迁移
- `src/utils/selectors.js` — 业务查询（员工日状态 employeeDayStatus 等）
- `vercel.json` — Vercel 构建配置；`DEPLOY.md` — 完整部署文档

## 已完成功能

- 账号登录/注册/退出（首个用户为管理员，JWT + httpOnly Cookie）
- 业绩录入、员工名单全团队共享（多设备实时同步）
- 人员管理按日视图：工资/工时/提成/营业额与所选日期关联，仅值班员工显示；添加员工与删除员工（含报表员工）均仅开发者可操作，删除后从人员管理/值班选择/员工绩效中隐藏，历史业绩记录保留，并同步到服务端
- 系统设置：中英文界面切换（侧边栏「系统设置」→「界面语言」，选择后立即生效并保存在本机浏览器）
- 账号菜单：左下角用户卡片点击后即可修改密码、本地上传头像、退出登录、切换账号（头像自动裁剪并随账号保存到服务端）
- 三级角色体系：开发者（最高权限，可管理账号）、门店运营（普通业务权限，人员管理显示姓名与营业额，工时/工资/提成/ROI 等个人隐私隐藏，首页员工绩效同步隐藏工资/工时/ROI，其余功能正常）、对外展示（隐藏所有敏感数字，仅保留功能展示）；第一个注册账号自动成为开发者；左下角账号菜单新增「账号管理」（仅开发者可见），可查看已注册账号、调整角色、重置密码、删除账号；不能删除/降级自己，且至少保留一个开发者账号
- 首页问候语随本地时间自动切换：早上好 / 中午好 / 下午好 / 晚上好（每分钟自动刷新）
- 数据分析：侧边栏「数据分析」可本地上传 .xlsx/.xls/.csv 报表（月度营业额 / 菜品明细 / 薪资表），自动解析并覆盖到首页 KPI、门店排行、营业额趋势、渠道构成、商品销售、员工绩效、人员管理等模块；上传数据存入共享分析层，可一键清除恢复内置报表
- 商品目录：商品管理 → 商品目录，根据菜品销售明细为每款菜品独立展示（销量 / 销售额 / 收入 / 优惠），支持上传 / 移除商品图片并跨设备同步；首页商品销售模块同步显示上传图片，点击商品可跳转到对应商品详情
- 手机端适配优化：顶栏自动换行（避免裁剪日历下拉框）、日历在手机端可用、录入表单改单列、KPI 数字自适应，未改动任何功能逻辑
- 首页员工绩效 TOP5：优先根据每日门店业绩录入实时分析（营业额 / 订单按值班人数均摊、按营业额排序），无录入数据时自动回退薪资表数据
- 人员管理：员工出勤天数 / 当班营业额 / 订单数按所选月份的门店业绩录入实时统计（按天去重、营业额按值班人数均摊），不再使用薪资表静态天数
- 门店管理：系统设置内可新增门店（仅开发者），新增门店自动同步到首页右上角门店选择、业绩录入门店选择、人员添加门店选项；员工按当月值班门店自动匹配门店身份
- 人员管理：打开版块时默认定位到当前月份，直接显示当月值班/业绩；右上角日历保留任意月份和日期自由选择查询
- 首页概览：默认定位到当前月份（不默认选具体日期），直接显示当月数据；右上角日历保留任意月份和日期自由选择查询，其他功能不变
- 员工薪酬：人员管理与首页员工绩效的工资/提成/工时改为按每日业绩录入自动计算（全职/兼职规则一致）；当日视图直接显示当天工资/提成/工时，月度视图按录入逐日累加；无录入月份自动回退薪资表；门店运营账号继续隐藏工资/提成/工时/ROI，重要提醒中的提成金额也对其隐藏
- 薪酬配置匹配：新增门店即使使用自动生成 key，只要名称含「通盈/西单/朝外/官舍」即自动套用对应标准工时与业绩目标
- Vercel + Upstash KV 生产部署；GitHub 自动部署流水线

## 待办/可扩展方向（用户未确认）

- 数据导出/导入（JSON 文件）
- cpolar 固定域名（工具已下载在 tools/，模板 tools/cpolar-budu.yml）
- 登录过期处理、多用户冲突策略（当前最后保存者生效）
- 薪酬规则参数化配置（门店目标/时薪/阶梯在界面可调）

### 美团接入·凭证办理待办（2026-08-08 暂缓，用户确认后再继续）

1. 用户确认公司主体（营业执照名称）与是否走品牌商入驻
2. 启动软著申请（建议以公司名义，普通办理约 1–2 个月）
3. 联系美团收银销售 / 400-626-0106 购买「经营数据接口」服务包
4. 品牌商入驻 + 开通智能版业务，获取 developerId + SignKey
5. 商家授权门店，获取 accessToken/refreshToken 与门店 poiId
6. Codex 调整 server/meituan 为官方签名与接口规范，填服务器 .env.production 后联调

## 环境变量（Vercel 项目 gptjjs-projects/budu11 已配置）

- `KV_REST_API_URL` / `KV_REST_API_TOKEN`（Upstash KV，自动注入）
- `JWT_SECRET`（生产密钥，勿泄露）
- `COOKIE_SECURE=1`

## 新会话恢复指令模板

> 继续开发 /Users/apple/Desktop/budu OS 的 BUDU 项目。
> 先读 PROJECT_STATUS.md 和 DEPLOY.md，再按需求继续。

## 部署流水线

改代码 → `git add -A && git commit -m "说明" && git push origin main` → Vercel 自动构建部署（约 1-2 分钟）→ 网址不变 https://budu11.vercel.app

腾讯云迁移期：部署流程 `docs/RUNBOOK_TENCENT.md`；GitHub Actions 推送 main 后自动部署到腾讯云（配置好 Secrets 后生效），DNS 未切换前 Vercel 仍是线上正式环境。
## 笔记本 / 多设备继续开发指南

### 方式一（推荐）：GitHub Codespaces —— 浏览器开发，笔记本零安装
1. 笔记本浏览器登录 GitHub（GPTJJ）→ 打开 https://github.com/GPTJJ/budu → 绿色 Code 按钮 → Codespaces → Create codespace（首次自动安装依赖）
2. 终端运行：`npm run server`（完整应用跑在 3000 端口；`npm install` 已自动构建前端，无需手动 build）
3. 点击编辑器底部 Ports 面板里的 3000 端口 → Open in Browser，即完整应用
4. 要连线上真实数据（和家里看到的一样）：在 GitHub → 仓库 Settings → Secrets and variables → Codespaces 里配置 `KV_REST_API_URL`、`KV_REST_API_TOKEN`、`JWT_SECRET`；不配则用 Codespace 内的空本地库
5. 改完代码直接 commit + push 到 main，Vercel 自动部署；家里台式机 `git pull` 即同步

### 方式二：笔记本本地开发
1. 装 Node.js LTS + GitHub Desktop → 登录 GPTJJ
2. `git clone https://github.com/GPTJJ/budu.git` → `npm install` → `npm run server` → http://localhost:3000
3. 要连线上数据：把台式机的 `.env.local` 私密传给笔记本放进项目目录
4. 开工前 `git pull`，收工 `git push`

### 两台电脑的 Codex 会话
- 每台电脑的 Codex 对话互不相通；新电脑开新对话第一句：“先读 PROJECT_STATUS.md 和 DEPLOY.md，继续开发 BUDU”
- 本文件就是两台电脑共用的“存档点”，重要进度更新后随时再 push

## M4「美团餐饮收银接入」实施记录（2026-08-08）

- 新迁移 `20260808030000_meituan`：MeituanStoreMapping、DailySales、DishDaily、DishMapping、MeituanSyncLog
- 后端：server/meituan/（config/sign/client/sync），5 分钟轮询 + 首次回补 7 天（可配）；
  冲突规则=美团覆盖营业数据、保留手工值班人员；未配置凭证时模拟模式（不写库）
- v2 接口：daily-sales、dish-daily、meituan/status、meituan/mappings、meituan/sync-now、
  meituan/dish-unmapped、meituan/dish-mappings
- 前端：设置页「美团收银对接」卡片；首页/渠道/商品销售优先读美团数据；
  业绩录入页美团门店显示“以美团为准”提示；loadUserData 恢复 v2 申请/库存拉取并新增美团数据
- 当前运行模式：模拟模式（未配置真实凭证，现有功能零影响）

### 美团接入凭证办理进度（2026-08-08 已查明官方要求）

已与官方文档核对，美团「餐饮系统-智能版（收银）」真实接入要求：

1. **个人开发者不可对接收银智能版**：官方明确“目前平台暂不提供个人开发者的对接服务”，
   且商家资质要求“需有企业营业执照”。必须走「品牌商（自研开发者）」或「服务商（SI/ISV）」入驻。
2. 推荐路线：**品牌商（自研开发者）**（用户自有品牌连锁店）：
   - 联系美团收银销售 / 400-626-0106 购买「经营数据接口」服务包（第三方财务/数据中台·BI，含数据报表类接口）
   - developer.meituan.com → 控制台 → 入驻申请 → 自研开发者（品牌商）
   - 材料：企业营业执照、经营信息、**软件著作权登记证书**（品牌商自研必须有）
   - 审核通过后申请开通「智能版」业务（businessId=18）
   - 在「开发者账号-账号信息」获取 **developerId + SignKey**（不是 app_id/app_secret）
   - 商家用美团收银智能版账号通过授权链接（open-erp.meituan.com/general/auth）授权门店，
     换取 accessToken（即 appAuthToken）+ refreshToken（30 天过期，需自动刷新）
3. 代码侧待调整（凭证到手后做）：BUDU 现有 `MEITUAN_APP_ID/APP_SECRET + MD5` 与官方不符，
   需改为 `developerId + SignKey + SHA1 签名 + businessId=18 + api-open-cater.meituan.com + appAuthToken`，
   并实现 token 自动刷新。
4. 软著：用户可以办理（个人/企业均可），但美团入驻需与营业执照主体一致，建议以公司名义申请；
   官方渠道中国版权保护中心 ccopyright.com.cn，普通 30–40 个工作日，加急 3–10 个工作日（代理收费）。
5. 待用户提供：公司全称、拟登记的软件名称/版本号；确认后 Codex 可代整理源程序 60 页 + 操作手册材料。
6. 凭证到手后需用户提供：developerId、SignKey、accessToken、refreshToken、美团门店 ID（poiId）与门店名称。

## 发票开具（2026-08-08）

- 菜单：财务利润 → 发票开具（developer/manager 可见，staff/public 不可见）
- 数据模型：`Invoice`（抬头类型 公司/个人、公司名称、税号、金额按分、品类、邮箱、门店、创建人）+ `InvoiceCompany`（公司名→税号字典，输入公司名自动匹配）
- 迁移 `20260808050000_invoice`：新表 Invoice / InvoiceCompany，已随容器启动 `prisma migrate deploy` 自动应用
- v2 接口：`GET/POST /v2/invoices`、`DELETE /v2/invoices/:id`、`GET /v2/invoices/companies`（搜索）、`DELETE /v2/invoices/companies/:id`（仅开发者）
- 前端 `src/components/InvoicePage.jsx`：抬头类型切换、公司名联想下拉自动带出税号、金额/品类/邮箱表单、开票记录列表（月份/门店筛选、合计金额、删除）
- 权限：门店绑定过滤 + 金额 BigInt 分存储 + 邮箱格式校验 + 删除限创建人或开发者
