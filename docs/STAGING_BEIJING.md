# 北京 staging 环境（2026-11-12 建立）

> 香港 TEST 服务器已停用，这里是在北京生产机上另起的**隔离 staging**。
> 只绑定 `127.0.0.1:3100`，不对公网开放；不使用生产数据库、不使用生产账号。

## 1. 拓扑

| 项 | 值 |
|---|---|
| 目录 | `/opt/budu-staging` |
| Compose 项目 | `budu-staging` |
| 容器 | `budu-staging-api-1`、`budu-staging-postgres-1` |
| 数据库 | 独立卷 `budu-staging_staging-pg`，库/用户 `budu_staging` |
| 端口 | `127.0.0.1:3100 → 3000` |
| 凭据 | `/opt/budu-staging/.env`（`chmod 600`，与生产完全独立） |
| 生产影响 | 无。独立网络、独立卷、独立端口、独立库 |

访问方式（不要给公网开口）：

```bash
ssh -N -L 3101:127.0.0.1:3100 -i ~/.ssh/budu_bj_migration ubuntu@154.8.195.42
# 本机打开 http://127.0.0.1:3101
```

## 2. 镜像策略（staging 专用）

服务器只有 2 核，且 `apt-get install chromium fonts-noto-cjk` 在这台机器上单次可超过 10 分钟。
因此 staging 使用 `app/Dockerfile.staging`：以**当前生产镜像** `budu-api:post-transfer-<sha>` 为基础，
只叠加 `npm install`、`prisma generate` 和应用代码。生产仍使用仓库根目录 `Dockerfile`，由 GitHub Actions 构建。

已知差异（必须有意识）：

- staging 镜像不是从零构建，不能替代“生产镜像能否构建”的验证；该项由 Actions 保证（构建失败会在部署前中止）。
- staging 的 `.dockerignore` 去掉了 `dist` 一行，并用本机构建好的 `dist.tar.gz` 覆盖；否则 `COPY dist` 会因忽略规则失败。

## 3. 更新 staging 的步骤

```bash
# 本地
git bundle create /tmp/x.bundle HEAD
tar czf /tmp/dist.tgz dist          # 需要先 npm run build
scp /tmp/x.bundle /tmp/dist.tgz ubuntu@154.8.195.42:/tmp/

# 服务器
cd /opt/budu-staging
git -C app fetch /tmp/x.bundle HEAD && git -C app checkout -q FETCH_HEAD
rm -rf app/dist && tar xzf /tmp/dist.tgz -C app
docker compose build && docker compose up -d api
docker compose exec -T api npx prisma migrate deploy
```

## 4. 迁移演练（每次新增迁移都做）

在有真实数据量的副本上验证，而不是只看空库：

```bash
PG=budu-bj-006-final-restore-20260822-055653z-pg           # 生产库容器
docker exec -u postgres $PG pg_dump -U budu_bj006 -d budu_bj006 -Fc -f /tmp/prod.dump
docker cp $PG:/tmp/prod.dump /tmp/prod.dump
docker cp /tmp/prod.dump budu-staging-postgres-1:/tmp/prod.dump
docker exec -u postgres budu-staging-postgres-1 createdb -U budu_staging budu_mig_rehearsal
docker exec -u postgres budu-staging-postgres-1 pg_restore -U budu_staging -d budu_mig_rehearsal \
  --no-owner --no-privileges /tmp/prod.dump

PW=$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2)
docker compose exec -T \
  -e DATABASE_URL="postgresql://budu_staging:$PW@postgres:5432/budu_mig_rehearsal" \
  api npx prisma migrate deploy
```

验收：`_prisma_migrations` 计数 +1，业务表行数完全不变，新表存在。演练后立即 `dropdb budu_mig_rehearsal`。

### 2026-11-12 演练结果（`online_catalog_admin`）

| 指标 | 迁移前 | 迁移后 |
|---|---|---|
| `_prisma_migrations` | 91 | **92** |
| `User` | 109 | 109 |
| `InventoryItem` | 229 | 229 |
| `StockBalance` | 6 | 6 |
| `ProcurementReturn` | 2 | 2 |
| `ReplenishmentOrder` | 21 | 21 |

新表 `online_categories`、`online_product_profiles` 均创建成功。演练库已删除。

## 5. 端到端验证

```bash
ssh -N -L 3101:127.0.0.1:3100 -i ~/.ssh/budu_bj_migration ubuntu@154.8.195.42 &

cd <repo>
BASE_URL=http://127.0.0.1:3101 E2E_USER=stagingowner E2E_PASS=*** \
  E2E_SHOT_DIR=/tmp/staging-shots NO_PROXY=127.0.0.1,localhost \
  node scripts/e2e-online-catalog-browser.mjs
```

2026-11-12 结果：11 项断言全部通过（登录、建分类、建商品、价格默认跟随、发布预览、无凭据发布 fail closed、无脚本错误）。

## 6. 安全与清理

- staging 只监听回环地址，安全组无需开放新端口。
- staging 账号是独立库里的测试账号，不复用生产密码。
- 演练库用完即删；生产 dump 不落地长期保存（验证后删除）。
- 彻底下线：`cd /opt/budu-staging && docker compose down -v`，再 `sudo rm -rf /opt/budu-staging`。
