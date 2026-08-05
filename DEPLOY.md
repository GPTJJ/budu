# BUDU 部署与分享指南

从本版本起，BUDU 由「静态单文件」升级为「带账号登录 + 共享数据库」的 Web 应用：

- 登录后才能访问，账号密码存在服务端；
- 业绩录入、员工名单为**全团队共享**（所有登录用户看到同一份数据，多设备实时同步）；
- 报表等静态数据仍打包在前端构建产物中。

## 一、本机运行（日常使用）

```bash
npm install
npm run build      # 构建前端（首次或每次改代码后）
npm run server     # 启动服务（http://localhost:3000）
```

浏览器打开 http://localhost:3000 ，第一个注册的账号自动成为管理员。

## 二、局域网分享（同事在同一网络）

服务默认监听 0.0.0.0，同事直接访问：

```
http://<本机IP>:3000
```

查看本机 IP：`ipconfig`（找 IPv4 地址，例如 192.168.31.22）。

> 注意：需要这台电脑保持开机、服务保持运行；Windows 防火墙如拦截请放行 3000 端口。

## 三、公网分享（任意设备、异地可访问）

### 方案 A：内网穿透（最简单，无需服务器）

**一键启动（已内置脚本）**：

```bash
node scripts/start-public.mjs
```

脚本会同时启动本地服务（3000 端口）和 serveo 公网隧道，并自动打印公网网址。

手动方式：在运行服务的电脑上执行任一穿透工具，把本地 3000 端口映射为公网地址：

- serveo（无需注册，已在本机验证可用）：`ssh -R 80:localhost:3000 serveo.net`
- cpolar：`cpolar http 3000`（免费版有随机域名，国内访问较稳定，需注册）
- natapp / 花生壳：按提示映射 TCP/HTTP 3000 端口

获得 https 地址后发给同事即可（https 域名下建议同时设置 `COOKIE_SECURE=1` 环境变量）。

### 固定域名（推荐：cpolar 基础版，99 元/年）

1. 注册 cpolar：https://www.cpolar.com （手机号注册），开通**基础版**（99 元/年，可保留 3 个子域名，国内访问快）；
2. 控制台 →「预留」→ 创建二级域名（如 `budu.cpolar.top`）；
3. 控制台 →「验证」复制 authtoken；
4. 编辑 `tools/cpolar-budu.yml`：填入 authtoken 和预留的域名；
5. 运行 `node scripts/start-public.mjs`，脚本检测到 cpolar 配置后自动使用固定域名 `https://budu.cpolar.top`。

也可手动启动：`tools\cpolar-portable\cpolar\cpolar.exe --config tools\cpolar-budu.yml start budu`

> 免费隧道（serveo / loca.lt / trycloudflare）均为随机域名：本机重启或隧道断开后网址会变化，且首次访问会有一个提示页，点「Continue / 继续访问」即可。长期稳定使用请用 cpolar 固定域名（如上），或直接上云服务器（方案 B）。

### 方案 B：云服务器 / VPS（推荐长期使用）

1. 准备一台有公网 IP 的服务器（阿里云 / 腾讯云轻量均可）；
2. 上传整个项目（或只上传源码 + `dist/`），服务器安装 Node.js 18+：
   ```bash
   npm install --omit=dev
   npm run build      # 若未上传 dist
   npm start
   ```
3. 用 pm2 守护进程：`npm i -g pm2 && pm2 start server/index.js --name budu`
4. （可选）用 nginx 反代并配置 HTTPS（Let's Encrypt），此时设置 `COOKIE_SECURE=1`。

### 方案 C：云托管平台（Render / Railway / Fly.io）

- 启动命令：`npm run build && node server/index.js`
- 环境变量：`PORT`（平台自动注入）、`JWT_SECRET`（自定义随机串，避免重启后旧登录失效）。
- 注意免费实例休眠会导致冷启动慢。

## 四、GitHub + Vercel 部署（推荐：免费、无需自己维护服务器）

项目已适配 Vercel Serverless：前端由 Vercel 托管，登录/数据接口走 `api/` 函数，
数据存储在 **Upstash Redis（Vercel KV）**，不再依赖本机 JSON 文件。

### 第 1 步：推送到 GitHub（用 GitHub Desktop）

1. 打开 GitHub Desktop → File → Add local repository… → 选择本项目文件夹 `C:\Users\Administrator\Desktop\budu`；
2. 首次推送：Publish repository → 填仓库名（如 `budu-dashboard`）→ 公开或私有均可（建议私有，含代码）→ Publish；
3. 确认推送成功（Fetch origin 不再有未推送提交）。

> `server/data`（含账号密码与密钥）、`tools/`（穿透工具）、`dist/`、`node_modules` 已加入 `.gitignore`，不会被上传。

### 第 2 步：导入 Vercel 并部署

1. 打开 https://vercel.com ，用 GitHub 账号登录；
2. Add New… → Project → Import 刚推送的 `budu-dashboard` 仓库；
3. 框架自动识别为 Vite，构建命令 `npm run build`、输出目录 `dist` 无需修改；
4. 点 Deploy，等待完成，得到网址 `https://budu-dashboard.vercel.app`（可改项目名）。

### 第 3 步：创建 KV 数据库并配置环境变量

方式一（推荐，已在本项目验证通过）：CLI 一条龙

```bash
npx vercel integration add upstash/upstash-kv      # 需在浏览器同意一次条款
npx vercel integration-resource connect <资源名> <项目名> --yes   # 自动注入 KV_REST_API_* 环境变量
```

方式二：Vercel 项目 → Storage → Create Database → 选择 **Upstash (KV)** → 免费档，
创建后项目会自动注入 `KV_REST_API_URL` / `KV_REST_API_TOKEN`（代码两者命名都兼容）。

无论哪种方式，还需手动添加两个环境变量（Production）：
- `JWT_SECRET`：随机串（`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`）
- `COOKIE_SECURE=1`

添加后重新 Deploy（Deployments → Redeploy）。

### 第 4 步：把本机数据迁移到云端（可选但建议）

先拉取线上环境变量再运行迁移脚本（已在本项目验证通过）：

```powershell
npx vercel env pull        # 生成 .env.local（含 KV_REST_API_URL / KV_REST_API_TOKEN）
node scripts/migrate-upstash.mjs
```

迁移内容包括：已有账号（含管理员 budu）、业绩录入、员工名单。迁移完成后，
同事用相同账号登录 Vercel 网址即可看到同一份数据。

### 第 5 步：验证

- 打开 Vercel 网址 → 注册/登录 → 录入一条业绩 → 手机 4G 网络访问同一网址应能看到；
- 以后每次代码修改：推送 GitHub → Vercel 自动重新部署（或手动 Redeploy）；
- 本地开发仍用 `npm run server`（未设置 UPSTASH 变量时自动使用本地 JSON 文件，互不影响）。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `PORT` | 服务端口，默认 3000 |
| `JWT_SECRET` | 登录令牌密钥；不设置时自动生成并保存在 `server/data/db.json` |
| `COOKIE_SECURE` | 设为 `1` 时 Cookie 仅通过 HTTPS 发送（公网部署建议开启） |
| `KV_REST_API_URL` / `UPSTASH_REDIS_REST_URL` | KV 数据库地址（Vercel 连接 KV 后自动注入） |
| `KV_REST_API_TOKEN` / `UPSTASH_REDIS_REST_TOKEN` | KV 数据库令牌（Vercel 连接 KV 后自动注入） |

## 数据与账号

- 本地模式：数据保存在 `server/data/db.json`（用户、业绩录入、员工名单）；**备份 = 复制这个文件**；
- Vercel 模式：数据保存在 Upstash KV（云端），备份可在 KV 控制台导出，或通过迁移脚本反向拉取；
- 第一个注册的用户是管理员，后续注册用户为普通成员（当前版本所有用户共享同一份数据）；
- 旧版本浏览器 localStorage 里的业绩录入 / 员工名单，会在新用户首次登录时自动迁移到服务端；
- 多人同时编辑时采用“最后保存者生效”的整包覆盖策略，日常小团队使用没有问题。

## 常见问题

- 页面打不开 → 先确认 `npm run server` 正在运行，再确认防火墙/端口放行。
- 登录后数据为空 → 首次登录会自动迁移旧数据；若无旧数据属正常，重新录入即可。
- 忘记密码 → 暂无自助找回，管理员可编辑 `server/data/db.json` 删除对应用户后再注册（或联系维护者重置）。