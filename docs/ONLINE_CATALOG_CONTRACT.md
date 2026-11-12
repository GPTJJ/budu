# ONLINE-CATALOG-ADMIN-001 生产发布合约

> 状态：**身份与账本门禁已实现并通过测试；部署编排尚未实现，`deploy` 模式一律 fail closed。**
> 不能用于生产发布，直到第 6 节的门槛全部满足。

## 1. 为什么需要单独合约

普通 `Deploy to Beijing Prod` 的 post-transfer 画像在 identity 阶段硬性要求
`git diff EXPECTED_OLD_SHA..release -- prisma` 为空。本功能新增两张表，必然触发：

```
{"result": "RELEASE_ABORTED", "code": "SCHEMA_CHANGED"}
```

仓库里允许改 schema 的发布都带独立合约（门店自提、采购退货等），每条钉死分支、
SHA、SQL 哈希、迁移账本与文件白名单。本合约沿用同一模式，不改动
`deploy-prod-transfer-cas.py`（其哈希被其他合约锁定）。

## 2. 钉死的身份

| 项 | 值 |
|---|---|
| 基线 `BASE` | `e91561238b866284bb6621a57fc02926fba01ec8`（当前生产） |
| 业务提交 `BUSINESS` | `62a2ac65e346a35f58e803ae07751b882254e48b` |
| 分支 | `codex/online-catalog-admin-002` |
| 迁移 | `20261112120000_online_catalog_admin` |
| SQL sha256 | `cb87993f9e3b1fd74478657ee8f7cd3e4efdf570e27f66d0827cb9a871368437` |
| 迁移数 | 91 → 92 |
| 控制器 sha256 | `e4206fa68019770ef82a8a37c3359c75164d18a749f555f0e844c6eeada02e03` |

业务范围 = `BUSINESS_FILES`（16 个文件，见脚本常量）；工程范围 = 本合约脚本、
测试脚本、本文件。任何多出或缺失的文件都会 `BLOCKED`。

## 3. 已实现的门禁（`identity`）

```bash
python3 scripts/deploy-prod-online-catalog.py identity \
  --repo . --release-sha "$(git rev-parse HEAD)"
```

校验项：

1. SHA 40 位且等于 HEAD；分支精确匹配；工作区干净（含未跟踪文件）。
2. `BASE → BUSINESS → release` 线性祖先关系，且 `BUSINESS..release` 无 merge。
3. `BASE..BUSINESS` 文件集合 == 白名单；`BUSINESS..release` 文件集合 == 工程白名单。
4. 控制器字节未变。
5. 迁移账本：BASE 91 条、当前 92 条，只多出本迁移；历史迁移字节逐一相同；本迁移 SQL 哈希钉死。
6. `git diff --check` 无空白错误。

测试：`python3 scripts/test-online-catalog-release.py`（篡改 SQL 哈希、多出文件、deploy 模式均被拒绝）。

## 4. 尚未实现的部署编排（下一阶段）

必须复用 `deploy-prod-transfer-cas.py` 的蓝绿原语，顺序如下：

1. **artifact**：复用 `m.artifact()` 校验镜像归档与 release SHA 绑定。
2. **preflight（只读）**：
   - `m.validate_clone_source` / `m.mount_readability` / `m.b1_storage`；
   - 生产容器身份（label、GIT_SHA、镜像 ID）与 `EXPECTED_OLD_SHA`；
   - 生产库 `_prisma_migrations` == 91、无失败/回滚记录、两张新表**不存在**；
   - 发布锁不存在、回滚目录不存在、磁盘余量（≥ 12 GiB）。
3. **migration（原子）**：
   - `LOCK TABLE "_prisma_migrations" IN SHARE ROW EXCLUSIVE MODE`；
   - 断言账本 91 条且无未完成记录、两张新表不存在；
   - 执行本迁移 SQL；
   - 插入 `_prisma_migrations` 记录（checksum = SQL sha256）；
   - 单事务提交；超时/中断必须可判定，不允许半应用。
4. **backup**：迁移前 `pg_dump -Fc`，并用 `pg_restore -l` 验证可读（记录字节数与 sha256）。
5. **blue-green**：`m.bg_clone` → `m.bg_lifecycle('standby')` → Prisma/表探测 →
   `m.bg_lifecycle('active')` → `m.bg_promote` → `m.replace_routes` → `m.health(public)`。
6. **verify**：`User`/`InventoryItem`/`StockBalance` 行数与迁移前一致；新表列结构符合
   Prisma 模型；`/online-catalog` 返回 200；旧容器停止但镜像保留。
7. **rollback**：候选不健康时恢复旧容器；迁移只新增表，旧代码可安全运行；
   回滚后保留新表并记录，不删除 `_prisma_migrations` 记录。
8. **evidence**：写 `.rollback-assets/blue-green-<sha>/` 下的 manifest 与结果 JSON。

## 5. 发布前必须补齐

- [ ] CloudBase 凭据（`TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY`）配置到生产 OS 容器
- [ ] 真实 CloudBase 发布验证（建议先 TEST 环境）
- [ ] 部署编排实现 + `test-online-catalog-release.py` 扩展
- [ ] 在生产克隆上完整演练（含失败回滚路径）
- [ ] live proof JSON（容器 ID/镜像、路由哈希、runtimeHash、resourcesHash、账本）
- [ ] 独立 workflow 或人工执行入口，且 `authorize_release_sha` 必须等于 release

## 6. 明确不做的事

- 不修改 `deploy-prod-transfer-cas.py`（哈希被现有合约锁定）。
- 不绕过 `SCHEMA_CHANGED` 检查去发“代码-only”版本。
- 不在未演练的情况下执行 `deploy`。
- 不手工在生产库建表：迁移记录必须由同一份 SQL 原子写入。
