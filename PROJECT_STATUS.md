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
node scripts/smoke-render.mjs       # SSR 冒烟测试（10 个组件）
node scripts/start-public.mjs       # 本机 + 公网隧道（临时用）
node scripts/migrate-upstash.mjs    # 本地数据 → 线上 KV
npx vercel env pull                 # 拉取线上环境变量
```

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
- 人员管理按日视图：工资/工时/提成/营业额与所选日期关联，仅值班员工显示；支持删除任意员工（含报表员工），删除后从人员管理/值班选择/员工绩效中隐藏，历史业绩记录保留，并同步到服务端
- 系统设置：中英文界面切换（侧边栏「系统设置」→「界面语言」，选择后立即生效并保存在本机浏览器）
- 账号菜单：左下角用户卡片点击后即可修改密码、本地上传头像、退出登录、切换账号（头像自动裁剪并随账号保存到服务端）
- 权限与账号管理：第一个注册账号自动成为最高权限（owner）；左下角账号菜单新增「账号管理」（仅最高权限可见），可查看已注册账号、调整角色、重置密码、删除账号；不能删除/降级自己，且至少保留一个最高权限账号
- Vercel + Upstash KV 生产部署；GitHub 自动部署流水线

## 待办/可扩展方向（用户未确认）

- 管理员管理账号（增删用户/重置密码）
- 数据导出/导入（JSON 文件）
- cpolar 固定域名（工具已下载在 tools/，模板 tools/cpolar-budu.yml）
- 登录过期处理、多用户冲突策略（当前最后保存者生效）

## 环境变量（Vercel 项目 gptjjs-projects/budu11 已配置）

- `KV_REST_API_URL` / `KV_REST_API_TOKEN`（Upstash KV，自动注入）
- `JWT_SECRET`（生产密钥，勿泄露）
- `COOKIE_SECURE=1`

## 新会话恢复指令模板

> 继续开发 /Users/apple/Desktop/budu OS 的 BUDU 项目。
> 先读 PROJECT_STATUS.md 和 DEPLOY.md，再按需求继续。

## 部署流水线

改代码 → `git add -A && git commit -m "说明" && git push origin main` → Vercel 自动构建部署（约 1-2 分钟）→ 网址不变 https://budu11.vercel.app
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
