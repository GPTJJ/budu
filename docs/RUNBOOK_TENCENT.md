# BUDU 腾讯云部署运行手册

> 版本：v1.0　日期：2026-08-07
> 目标：把 BUDU 从 Vercel 迁到腾讯云，使用正式域名 + Docker + Nginx + HTTPS + GitHub Actions 自动部署。
> 数据策略（迁移期）：**继续使用 Upstash KV**，零数据迁移、随时可切回 Vercel；PostgreSQL 迁移在后续 P1–P2 阶段进行。

## 1. 部署架构

```text
用户浏览器
   │  HTTPS（443）
   ▼
Nginx（TLS 终止、HTTP→HTTPS、反代 /api 与静态页）
   │
   ▼
BUDU API 容器（Express 5，端口 3000，含构建好的前端）
   │
   ├── Upstash KV（现有生产数据，零迁移）或本地 JSON 卷
   └── 持久卷 /app/server/data（本地模式）
```

## 2. 前置准备（请先确认）

1. **域名**：一个已解析到腾讯云服务器的域名。若服务器在大陆，域名必须先完成 **ICP 备案**（未备案时 80/443 会被拦截）；若不想备案，请选**腾讯云香港轻量服务器**。
2. **服务器**：腾讯云轻量应用服务器，建议 2C4G、Ubuntu 22.04（大陆/香港按备案情况选）。
3. **GitHub 仓库**：`GPTJJ/budu`（本仓库）。
4. **SSL 证书**（二选一）：
   - 腾讯云免费证书：SSL 证书控制台申请 → 下载 **Nginx 格式** → 得到 `fullchain.pem` / `privkey.pem`；
   - 或 Let's Encrypt（certbot）：服务器上执行 `certbot certonly --standalone -d <域名>` 后把证书复制到 `deploy/certs/`。

## 3. 腾讯云资源开通

### 3.1 轻量服务器

- 镜像：Ubuntu 22.04 LTS；
- 规格：2C4G 起；
- 地域：大陆（需备案）或香港（免备案）。

### 3.2 防火墙/安全组

只放行：

| 端口 | 用途 |
| --- | --- |
| 22 | SSH |
| 80 | HTTP（跳转 HTTPS / ACME 验证） |
| 443 | HTTPS |

不要放行 3000 端口（由 Nginx 内部转发）。

### 3.3 DNS

在 DNSPod / 域名控制台添加 A 记录：

```text
主机记录：@  或 www
记录类型：A
记录值：<服务器公网 IP>
```

## 4. 服务器初始化

### 4.1 安装 Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# 重新登录使权限生效
docker --version
```

### 4.2 拉取代码

```bash
sudo mkdir -p /opt/budu
sudo chown -R $USER:$USER /opt/budu
cd /opt/budu
git clone git@github.com:GPTJJ/budu.git .
```

如果仓库是私有的，在 GitHub → Settings → Deploy keys 添加服务器公钥：

```bash
ssh-keygen -t ed25519 -C "budu-server" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

### 4.3 创建环境文件（敏感信息，不入 git）

`/opt/budu/.env`（compose 插值用）：

```bash
DOMAIN=budu.example.com
HTTP_ONLY=0
```

`/opt/budu/.env.production`（服务运行时读取）：

```bash
PORT=3000
JWT_SECRET=
COOKIE_SECURE=1
KV_REST_API_URL=你的Upstash地址
KV_REST_API_TOKEN=你的Upstash令牌
```

> **JWT_SECRET 留空**：服务会自动使用 Upstash 数据中的 `meta.secret`，现有登录 Cookie 全部有效（与 Vercel 行为一致）。若改为环境变量注入，请先用 `node scripts/backup-kv.mjs` 备份并从快照中取出原 `meta.secret` 填入，否则所有用户需要重新登录。

### 4.4 放置证书

```bash
mkdir -p /opt/budu/deploy/certs
# 把 fullchain.pem / privkey.pem 上传到该目录
```

## 5. 首次启动与验证

### 5.1 先纯 HTTP 验证（证书未就绪时）

临时把 `/opt/budu/.env` 中 `HTTP_ONLY=1`，然后：

```bash
cd /opt/budu
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:3000/api/health
```

浏览器访问 `http://<服务器IP>` 确认登录页可打开。此时无需域名即可验证。

### 5.2 切换到 HTTPS

1. 确认 `deploy/certs/fullchain.pem` 与 `deploy/certs/privkey.pem` 存在；
2. 把 `/opt/budu/.env` 改回 `HTTP_ONLY=0`；
3. DNS A 记录已指向服务器；
4. 重启：

```bash
cd /opt/budu
docker compose up -d --build
```

浏览器访问 `https://<域名>`，确认：

- 自动跳转 HTTPS、证书可信；
- 登录/录入/报表/账号管理正常；
- `https://<域名>/api/health` 返回 `{"ok":true,...}`。

> 若域名解析未生效，可先改本机 hosts 验证，再把 DNS 切到正式值。

## 6. GitHub Actions 自动部署

仓库已包含 `.github/workflows/deploy.yml`：推送 `main` 后自动 SSH 到服务器拉取代码、构建、重启，健康检查失败自动回滚到上一版本。

### 6.1 配置 GitHub Secrets

仓库 → Settings → Secrets and variables → Actions → New repository secret：

| Secret | 说明 |
| --- | --- |
| `TENCENT_HOST` | 服务器公网 IP |
| `TENCENT_USER` | SSH 用户（root 或具有权限的普通用户） |
| `TENCENT_SSH_KEY` | SSH 私钥（与服务器 authorized_keys 配对） |
| `TENCENT_APP_DIR` | 服务器项目目录，默认 `/opt/budu` |

服务器上确保公钥在 `~/.ssh/authorized_keys`：

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo "ssh-ed25519 AAAA...你的公钥" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

之后每次推送 main，Actions 自动执行 `scripts/deploy-remote.sh`。手动部署也可在 Actions 页面点 Run workflow。

## 7. 数据备份与恢复

### 7.1 备份 Upstash 快照（迁移期）

在本机（或任意配置了 `.env.local` 的环境）：

```bash
node scripts/backup-kv.mjs
```

生成 `backups/kv-snapshot-YYYYMMDDHHmmss.json`（含全部用户/业绩/员工/报表数据，**含 JWT 密钥，切勿提交 git**），建议上传到 COS 私有桶。

### 7.2 本地 JSON 模式（若选择不用 Upstash）

- 数据在 docker 卷 `budu_data` 的 `/app/server/data/db.json`；
- 备份：`docker run --rm -v budu_data:/data -v "$PWD/backups":/backups alpine sh -c "cp /data/db.json /backups/db-$(date +%Y%m%d).json"`；
- 恢复：反向把备份文件复制回卷后 `docker compose restart api`。
- 建议加 crontab 每日备份并同步到 COS。

## 8. 日常运维

```bash
# 查看状态
docker compose ps

# 查看日志（API / Nginx）
docker compose logs --tail=200 api
docker compose logs --tail=100 nginx

# 手动重新部署（等 GitHub Actions 或手动执行）
git pull && docker compose up -d --build

# 重启服务
docker compose restart

# 证书过期处理
# 腾讯云证书：控制台续期 → 下载 Nginx 格式 → 覆盖 deploy/certs/ 后 docker compose restart nginx
# Let's Encrypt：certbot renew → docker compose restart nginx
```

## 9. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 大陆服务器 80/443 访问被拦截 | 域名未备案。完成 ICP 备案，或改用香港地域服务器 |
| HTTPS 打不开 | 证书文件缺失/路径不对 → `docker compose logs nginx`；确认 `deploy/certs/` 下有 fullchain.pem、privkey.pem |
| 登录后马上掉线 | `JWT_SECRET` 与线上不一致。留空使用 KV 中 meta.secret，或填入原值 |
| 页面能开但接口 502 | API 容器未起来 → `docker compose logs api`；注意 Upstash 网络是否可达 |
| Upstash 请求偏慢 | 腾讯云访问 Upstash 延迟较高，迁移期可接受；后续 P1–P2 迁到 PostgreSQL 后消除 |
| 自动部署失败 | 检查 GitHub Secrets 是否正确、服务器公钥是否在 authorized_keys、`TENCENT_APP_DIR` 是否可写 |

## 10. 回滚

- 代码回滚：Actions 自动回滚上一版本；手动执行 `git checkout <上一SHA> && docker compose up -d --build`；
- 数据回滚：用 `backups/` 快照恢复 KV（或本地 JSON）；
- 整个方案回退：域名 DNS 切回 Vercel（`budu11.vercel.app` 或自定义域名）即可，Upstash 数据完全一致。

## 11. 后续阶段（不在本手册范围）

- P1–P2：PostgreSQL + Prisma、KV→PG 数据迁移与对账；
- P3–P4：后端重构（RBAC/日志/安全链）、前端适配；
- P7：监控告警、每日备份演练；
- P8：企业微信接口。
