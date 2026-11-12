# ONLINE-CATALOG-ADMIN-001 生产发布合约

> 状态：身份、账本、只读 preflight 与蓝绿部署编排均已实现；
> **真实 preflight 被生产模型的 `SOURCE_LABELS_UNSUPPORTED` 阻断（见 §6），尚未部署。**

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

## 4. 部署编排（已实现，未在生产执行）

复用 `deploy-prod-transfer-cas.py` 的蓝绿原语，顺序如下：

1. **artifact**：`m.artifact()` 校验归档标签、平台、revision label 与运行时文件摘要。
2. **preflight（只读）**：旧容器身份/健康、路由形状、数据库 91 条且无失败/回滚、
   两张新表不存在、发布锁不存在、磁盘 ≥ 12 GiB。
3. **import**：`m.bg_import` 落盘校验 sha256 后 `docker load`，`m.resolve_loaded_image` 复核。
4. **backup**：`pg_dump -Fc` 到回滚目录，`pg_restore -l` 统计 TABLE DATA 段数并记 sha256。
5. **migration（原子）**：锁 `_prisma_migrations`、断言账本 91 条与两张表不存在、
   执行迁移 SQL、写入账本记录、单事务提交；随后校验 92 条与账本逐项一致。
6. **candidate**：`m.bg_clone` 克隆旧容器为 standby → 内部健康 → `m.bg_lifecycle('standby')`
   → Prisma 读写探测。
7. **cutover**：写者归零 → 停旧容器 → `m.bg_promote` → `m.bg_lifecycle('active')`
   → `m.replace_routes` → 公网健康 → 写者唯一性校验。
8. **verify**：`User`/`InventoryItem`/`StockBalance`/`ProcurementReturn`/`ReplenishmentOrder`
   行数与迁移前一致；新表关键列齐全；`.current-sha` 指向 release。
9. **rollback**：任一步失败 → 停候选 → 重启旧容器 → 恢复路由与 `.current-sha` → 公网健康。
   迁移只新增表，旧代码可安全运行；新表与账本记录保留，便于下次重试。

执行入口：`.github/workflows/release-online-catalog.yml`。
`preflight_only=true`（默认）只构建归档并跑到只读 preflight，不触碰生产。

## 5. 发布前必须补齐

- [ ] CloudBase 凭据（`TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY`）配置到生产 OS 容器
- [ ] 真实 CloudBase 发布验证（建议先 TEST 环境）
- [x] 部署编排实现 + 测试
- [ ] 生产克隆上的完整演练（含失败回滚路径）
- [ ] live proof JSON（容器 ID/镜像、路由哈希、runtimeHash、resourcesHash、账本）
- [x] 独立 workflow 入口，且 `authorize_release_sha` 必须等于 release

## 6. 生产模型阻断（2026-11-12 实测）

`preflight` 在真实生产上返回：

```
{"result": "BLOCKED", "code": "SOURCE_LABELS_UNSUPPORTED"}
```

原因是当前生产容器不是标准 post-transfer 候选，而是 **thin/golive 覆盖层**：

| 项 | 实测值 |
|---|---|
| 容器 | `budu-prod-e91561238b86-golive` |
| 镜像 | 587 MB / 44 层（全量镜像约 2.3 GB） |
| labels | `budu.production-role=golive-candidate`、`budu.thin-base=adcfa1926…`、`budu.thin-overlay-sha256=608ffd4c…`、`revision=e9156123…` |
| RestartPolicy | `no`（克隆契约要求 `unless-stopped`） |
| 网络 | `budu-bj-006-…-net` **和** `budu_default` 两个 |

`deploy-prod-transfer-cas.py` 的 `validate_clone_source` 要求 labels 恰为
`{revision, budu.production-role=candidate}`、单网络、`unless-stopped`；
`bg_clone` 的 `clone_parity` 也要求网络集合一致。两者都无法处理当前 golive 容器。

**影响不止本功能**：标准 `Deploy to Beijing Prod` 同样会在 preflight 之后因同一原因失败，
即当前生产形态与仓库内所有发布工具都不匹配。这个 golive 容器不是本仓库任何脚本创建的
（全分支检索无 `golive` 关键字），需要确认它的来源与配套的 thin 覆盖层构建流程。

本功能只有在以下任一条件满足后才能继续：

1. 找到/补齐创建 golive 容器的工具，按同一模型构建 thin 覆盖层；
2. 经批准把生产切回标准全量镜像模型（本合约的 `bg_clone` 路径即可直接使用）；
3. 由发布负责人按其现有流程执行迁移与发布。

## 7. 明确不做的事

- 不修改 `deploy-prod-transfer-cas.py`（哈希被现有合约锁定）。
- 不绕过 `SCHEMA_CHANGED` 检查去发“代码-only”版本。
- 不在未演练的情况下执行 `deploy`。
- 不手工在生产库建表：迁移记录必须由同一份 SQL 原子写入。
