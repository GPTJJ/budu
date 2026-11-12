# 小程序商城管理 · 生产发布检查单

> 候选：`codex/online-catalog-admin-002` @ `22ffebe`（校验和：`git rev-parse HEAD`）
> 生产基线：`e91561238b86`（`/api/health` 实测，V2.20）
> 环境：只有北京生产（`154.8.195.42` / `/opt/budu`），**没有测试环境**

## 执行记录（2026-11-12）

- 结果：`DEPLOY_COMPLETE`，release `1d195a036a468d787f696b019477d6212f3d1a00`
- 新容器 `budu-prod-1d195a036a46-golive` healthy；旧容器已停并保留
- 迁移 92 条，failed 0，rolledBack 0；业务行数不变；`/online-catalog` 200
- 详见 `budu-online-catalog-release-20261112/RESULT.md`

## 0. 发布通道约束（2026-11-12 实测）

`Deploy to Beijing Prod` 的 post-transfer 画像**明确禁止任何 Prisma 变更**：

```
{"result": "RELEASE_ABORTED", "code": "SCHEMA_CHANGED"}
```

判定位置：`scripts/deploy-prod-transfer-cas.py:1159`，即
`git diff EXPECTED_OLD_SHA..release -- prisma` 必须为空。该次运行在 identity 阶段即中止，
**未 checkout、未构建、未替换生产容器、未迁移**（run `43202483127`）。

只有下列带专用合约的发布才允许改 schema，且每条都钉死分支名、SHA、SQL 哈希与文件白名单：

- `deploy-prod-store-pickup.py`（`store_pickup_enabled`）
- `deploy-prod-purchase-return.py`
- 采购/物料/物流/移动端热修各自的 `validate_*_identity`

本功能需要新增一套同等级别的迁移发布合约，或在既有合约里显式扩展；**不能**通过普通
`Deploy to Beijing Prod` 发出去。合约至少包含：

1. 精确的 base / business SHA 与分支名；
2. `prisma/migrations` 全量 ledger 哈希，且只允许多出本迁移；
3. 新迁移 SQL 的 sha256 钉死；
4. 一份 live proof（资源/运行时/ledger 快照）；
5. 独立测试脚本，接入发布前测试链。

## 0.1 发布前必须就位

- [ ] CloudBase 凭据已配置到生产 OS 容器：`TCB_ENV_ID` / `TCB_SECRET_ID` / `TCB_SECRET_KEY`
- [ ] 生产库备份完成（见 §1）
- [ ] CloudBase `products` 与 `_meta` 快照已导出
- [ ] 发布窗口内无人操作 POS / 小程序下单（迁移本身只加表，但发布要重启容器）

## 1. 备份

```bash
ssh ubuntu@154.8.195.42
PG=budu-bj-006-final-restore-20260822-055653z-pg
mkdir -p ~/.budu-backups
docker exec -u postgres $PG pg_dump -U budu_bj006 -d budu_bj006 -Fc \
  > ~/.budu-backups/pre-online-catalog-$(date -u +%Y%m%dT%H%M%SZ).dump
ls -lh ~/.budu-backups | tail -2
```

CloudBase 快照：在控制台 → 云开发 → 数据库 → `products` / `_meta` → 导出 JSON（或发布前先读一遍并保存）。
至少确认：`products` 文档数 = 28。

## 2. 发布

`Actions → Deploy to Beijing Prod → Run workflow`：

| 输入 | 值 |
|---|---|
| `expected_production_sha` | `e91561238b866284bb6621a57fc02926fba01ec8` |
| `approved_business_sha` | 候选 HEAD 的完整 40 位 SHA |
| `authorize_release_sha` | 同上（必须与 workflow 的 `GITHUB_SHA` 一致） |
| ref | `codex/online-catalog-admin-002` |

控制器会先做 `identity` / `inspect-artifact` / `preflight`，任何一项不匹配都会在**替换生产容器前**中止。

## 3. 迁移（发布后立即执行，约 1 分钟）

发布控制器**不会**自动迁移。新容器起来后立刻在 `/opt/budu` 执行（用生产库容器，不要用 compose 里的 postgres）：

```bash
cd /opt/budu
docker compose exec -T api npx prisma migrate deploy
```

预期：只应用 `20261112120000_online_catalog_admin`，输出 `All migrations have been successfully applied.`

校验（生产库容器）：

```bash
docker exec -u postgres budu-bj-006-final-restore-20260822-055653z-pg \
  psql -U budu_bj006 -d budu_bj006 -X -c \
  "select to_regclass('online_categories'), to_regclass('online_product_profiles');"
```

## 4. 验收

```bash
curl -s https://buducandy.cn/api/health   # gitSha 应为候选 HEAD，dbOk=true
```

1. 打开 `https://buducandy.cn/online-catalog`，用管理员账号登录。
2. 页面顶部**不应**再出现“CloudBase 发布凭据未配置”。
3. 点“导入现有”，核对报告：`created` 应为 28 左右，`combo` 应含 `bb`，`unmatched` 应为空或明确可解释。
4. 选一个商品，只改副标题 → 保存 → 预览 → 发布。
5. 小程序下拉刷新（或等 60 秒）确认菜单显示新副标题。
6. 抽查 POS：商品列表与售价未变化（线上价与 POS 价是两套值）。

## 5. 回滚

| 层 | 操作 |
|---|---|
| 代码 | 重新发布 `e9156123`（控制器支持指定 SHA），或按 `.current-sha` 回退 |
| 数据库 | 新表不被订单/支付读取，代码回滚后保留即可；如需清理：`drop table online_product_profiles, online_categories;` 并删除对应迁移记录 |
| CloudBase | 按 §1 快照恢复被改动的 `products` 文档；不要整集合覆盖 |
| policy | 按 `externalProductId` 精确删除新商品的 `online_product_policies` 记录 |

## 6. 已知风险

- 迁移窗口内若有人打开 `/online-catalog` 会 500，**不影响** POS/小程序下单。
- 服务器磁盘 86%（余 11G）；生产发布会再导入约 2.3G 镜像。建议发布前确认余量 ≥ 6G。
- 组合商品（`bb`）本期不管理，只能在 CloudBase 里手工维护。
- 自定义名称的新分类会分配 `p1/p2…` 形式的 `mpId`；只有四个固定分类用 `c/s/g/b` 前缀。
