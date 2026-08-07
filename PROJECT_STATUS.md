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

## 腾讯云部署进度（2026-08-07 下午）

- 服务器：`124.156.171.195`（腾讯云轻量香港/OpenClaw 龙虾镜像，2核2G/40G，实例 lhins-gkqyrkst）
- 已安装：Docker 29.1.3 + Compose 2.40.3；项目克隆到 `/opt/budu`
- 已启动：`budu-api-1`（健康）+ `budu-nginx-1`（80/443）；Nginx 本机验证通过：
  `/api/health` 返回 ok、首页正常返回（此前修复了镜像默认站点抢占 80 端口 + 脚本可执行位）
- 服务器环境：`.env`（DOMAIN 占位 + HTTP_ONLY=1）、`.env.production`（KV 线上密钥，未入库）
- **待用户操作**：
  1. 腾讯云控制台防火墙放行 TCP 80 与 443（当前公网 80 未通）
  2. 域名 `buducandy.cn` 实名通过后，DNS 加 A 记录指向 `124.156.171.195`
  3. 证书就绪后切 HTTPS（HTTP_ONLY=0 + deploy/certs）
- **待办**：GitHub Actions Secrets（TENCENT_HOST/USER/SSH_KEY/APP_DIR）配置自动部署；
  服务器 SSH 密钥登录未生效（Actions 前需修复或改用密码方案）

## 当前进度存档（2026-08-07 晚）

**已交付功能**：架构分析报告 + 迁移计划（docs/）、腾讯云部署全套物料（Docker/Nginx/GitHub Actions/RUNBOOK）、
门店排班（按周/按门店/早班晚班通班）、商品目录增删改、首页头部只显示概览工具 + 布局优化；
全部已推送到 GitHub（当前 main HEAD `360c32d`），Vercel 线上 https://budu11.vercel.app 保持可用。

**腾讯云服务器**：`124.156.171.195`（香港轻量 2核2G，实例 lhins-gkqyrkst，OpenClaw 龙虾镜像）
- Docker 29.1.3 + Compose 2.40.3 已装；`/opt/budu` 已部署并运行（api healthy + nginx）
- 服务器本机 `/api/health` 通过；公网 80/443 未放行（等 API 密钥或用户控制台操作）
- 登录方式：`ubuntu` + 密码（详见本机 `tools/TENCENT_SERVER_NOTES.txt`，**不提交 git**）
- 本地工具：`tools/plink.exe`、`pscp.exe`、`budu_deploy` 密钥（tools/ 已 gitignore）

**下一步（阻塞项）**：用户提供腾讯云 API 密钥 → 放行 80/443 → 验证公网 → 域名 DNS/证书/HTTPS →
GitHub Actions Secrets → 正式切换。

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
