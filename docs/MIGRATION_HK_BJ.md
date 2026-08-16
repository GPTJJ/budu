# BUDU 香港（测试）→ 北京（生产）迁移与回滚手册

> 前置：北京服务器已购买并装好 Docker；GitHub 已配置 `BJ_*` Secrets；备案通过后恢复 `buducandy.cn` DNS。

## 一、阶段与操作

### 阶段 0：备案期间（现在）

- 香港（124.156.171.195）只作为测试环境，团队用独立测试域名访问。
- 香港服务 `APP_ENV=test`，连接独立测试 KV 与独立测试 PG，不碰生产数据。
- 代码 push 到 main 后，用 GitHub Actions `Deploy to HK Test` 手动触发（或配好 HK secrets 后改为 push 自动部署）。

### 阶段 1：北京服务器准备（备案通过前即可做，不影响团队）

1. 北京服务器安装 Docker / Docker Compose，克隆仓库到 `/opt/budu`，准备 `.env.production`（APP_ENV=prod、生产 KV、生产 PG）。
2. GitHub Actions `Deploy to Beijing Prod` 手动触发，把同一 commit 部署到北京；校验 `/api/health`（env=prod、dbOk=true、gitSha 正确）。
3. 此时 `buducandy.cn` 仍解析到香港，团队无感知。

### 阶段 2：数据迁移

1. 香港 PG 导出并恢复到北京（见下方脚本）。
2. 生产 KV：新建独立 Upstash 命名空间；用 `scripts/migrate-upstash.mjs` 把现有生产账号数据一次性导入（测试 KV 保持不动）。
3. COS 文件：用 `scripts/upload-cos.mjs` 或对象存储控制台按需同步。
4. 北京执行 `prisma migrate deploy`，抽查订单/库存/账号数据行数与香港一致。

### 阶段 3：切换正式域名（备案通过后）

1. 记录香港 IP 与北京 IP。
2. 在 DNS 控制台把 `buducandy.cn`（和 www）A 记录从香港 IP 改到北京 IP。
3. 先在本机 hosts 指向北京 IP 灰度验证登录与核心页面，再全量切换。
4. 香港服务至少保留 7 天作为回滚点。

## 二、PG 迁移脚本

```bash
# 预览（不执行）
bash scripts/migrate-pg-hk-to-bj.sh <香港IP> <香港用户> /opt/budu <北京IP> <北京用户> /opt/budu

# 真正执行
bash scripts/migrate-pg-hk-to-bj.sh <香港IP> <香港用户> /opt/budu <北京IP> <北京用户> /opt/budu --apply
```

## 三、回滚预案

- 域名层回滚（最快）：把 `buducandy.cn` A 记录改回香港 IP，秒级生效，团队立即回到旧环境。
- 数据层回滚：迁移前在北京做一次 `pg_dump`，异常时用该备份覆盖北京库，再重跑 `prisma migrate deploy`。
- 代码回滚：`deploy-remote.sh` 内置健康检查失败自动回滚到 `.current-sha`；也可在北京手动 `git checkout <上一版> && docker compose up -d --build`。

## 四、校验清单

- `https://buducandy.cn/api/health` 返回 `env=prod`、`dbOk=true`、正确 `gitSha`。
- 三环境（dev/test/prod）数据库互不串连，`.env.*` 未提交到 Git。
- Sentry 能收到前端与后端错误；企业微信部署失败通知正常。
