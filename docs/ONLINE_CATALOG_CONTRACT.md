# ONLINE-CATALOG-ADMIN-001 生产发布合约

> 状态：身份、账本、只读 preflight 与 golive 蓝绿部署编排均已实现；
> 生产模型来源已查明（§6），**尚未在生产执行部署**。

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

## 4. 部署编排（已实现，按生产实际使用的 golive 模型）

生产实际由 `golive-blue-green.py`（BUDU-OFFLINE-TO-MINI-001，owner-approval V5）创建，
不是通用 `bg_clone` 的候选模型。本合约按同一模型实现：

1. **artifact**：`m.artifact()` 校验归档标签、平台、revision label 与运行时文件摘要。
2. **preflight（只读）**：路由指向的当前容器 SHA/label/健康、数据库 91 条且无失败/回滚、
   两张新表不存在、发布锁不存在、磁盘 ≥ 12 GiB。
3. **import**：`m.bg_import` 落盘校验 sha256 后 `docker load`，`m.resolve_loaded_image` 复核。
4. **backup**：`pg_dump -Fc` 到回滚目录，`pg_restore -l` 统计 TABLE DATA 段数。
5. **migration（原子）**：锁 `_prisma_migrations`、断言账本 91 条与两张表不存在、
   执行迁移 SQL、写入账本记录、单事务提交；随后校验 92 条与账本逐项一致。
6. **candidate**：按 golive 方式从当前容器克隆——沿用挂载、GroupAdd、全部网络、环境变量，
   仅改 `GIT_SHA`、`BUDU_RUNTIME_MODE=standby`、role/revision 标签、`--restart no`；
   启动后等待 `BUDU_RUNTIME_STANDBY_READY` 并通过内部健康检查。
7. **promotion**：`SIGUSR2` 触发晋升，等待 `BUDU_RUNTIME_PROMOTION_COMPLETE` 与健康检查。
8. **cutover**：模板与生效 nginx 配置同时替换容器名（`m.replace_routes`），`nginx -t` + reload，
   公网健康检查确认 `gitSha`。
9. **retire**：停旧容器（保留镜像与容器），写 `.current-sha`，核对业务行数未变。
10. **rollback**：任一步失败 → 停候选 → 重启旧容器 → 恢复路由与 `.current-sha` → 公网健康。

执行入口：`.github/workflows/release-online-catalog.yml`。
`preflight_only=true`（默认）只构建归档并跑到只读 preflight，不触碰生产。

**实测（run `43213975231`，2026-11-12）**：identity、amd64 构建、归档校验、SSH、
只读 preflight 全部 PASS。preflight 读到：源容器 `budu-prod-e91561238b86-golive` 健康、
`GIT_SHA=e9156123`、账本 91 条无失败/回滚、两张新表不存在、磁盘 ≥ 12 GiB。
部署步骤未执行。

## 5. 发布前必须补齐

- [ ] CloudBase 凭据（`TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY`）配置到生产 OS 容器
- [ ] 真实 CloudBase 发布验证（建议先 TEST 环境）
- [x] 部署编排实现 + 测试
- [ ] 生产克隆上的完整演练（含失败回滚路径）
- [ ] live proof JSON（容器 ID/镜像、路由哈希、runtimeHash、resourcesHash、账本）
- [x] 独立 workflow 入口，且 `authorize_release_sha` 必须等于 release

## 6. 生产模型来源（2026-11-12 查明）

标准 `bg_clone` 路径在生产上返回 `SOURCE_LABELS_UNSUPPORTED`，因为当前生产容器不是
标准 post-transfer 候选，而是 **thin/golive 覆盖层**：

| 项 | 实测值 |
|---|---|
| 容器 | `budu-prod-e91561238b86-golive`（创建于 2026-10-26T12:01:36Z） |
| 镜像 | 587 MB / 44 层（全量镜像约 2.3 GB） |
| labels | `budu.production-role=golive-candidate`、`budu.thin-base=adcfa1926…`、`budu.thin-overlay-sha256=608ffd4c…`、`revision=e9156123…` |
| RestartPolicy | `no` |
| 网络 | `budu-bj-006-…-net` **和** `budu_default` 两个 |

来源已定位：`BUDU-OFFLINE-TO-MINI-001` 的 go-live 工具
`artifacts/golive-20261026/golive-blue-green.py`（sha256 `c1b28af8…13a3`），授权模型
`BUDU-OWNER-APPROVAL-V5`，生产回滚目录
`/opt/budu/.rollback-assets/offline-to-mini-001-e91561238b86/`。

该容器由 `docker create --restart no --label budu.production-role=golive-candidate` 创建，
沿用全部挂载、GroupAdd 与两条网络，通过 env-file 覆盖变量，再 `SIGUSR2` 晋升、替换 nginx。
因此标准 `validate_clone_source`（要求 `role=candidate`、单网络、`unless-stopped`）必然拒绝它。

本合约据此改为同一 golive 模型（见 §4），不再使用 `bg_clone`。
旧容器仍可按 `docker start budu-prod-e91561238b86-golive` + nginx 回切恢复。

## 7. 明确不做的事

- 不修改 `deploy-prod-transfer-cas.py`（哈希被现有合约锁定）。
- 不绕过 `SCHEMA_CHANGED` 检查去发“代码-only”版本。
- 不在未演练的情况下执行 `deploy`。
- 不手工在生产库建表：迁移记录必须由同一份 SQL 原子写入。
