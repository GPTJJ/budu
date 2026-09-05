# budu Sweet Card 数据整理 1.0

审计时间：2026-09-05（Asia/Shanghai）

任务模式：STRICT

模型记录：`MODEL_CONFIGURATION_NOT_VERIFIABLE`

## Gate 状态

`SWEET_CARD_DATA_ORGANIZATION_HOLD`

Candidate 已实现并通过本地构建、隔离迁移演练、业务合同测试和移动端浏览器回归。Candidate 尚未部署 Production；Migration 66 尚未应用；Production 数据未写入。按照项目 STRICT Gate，Production migration/deploy 必须取得明确 reviewer approval 后才能执行。

## 权威与版本

| 项目 | 当前证据 |
| --- | --- |
| Production baseline / runtime SHA | **VERIFIED** `fe4a7254a0ec9a68390cefe12b0766b3ec15ef93` |
| Production database | **VERIFIED** `budu_bj006` |
| Production migration | **VERIFIED** 65 applied / 0 failed |
| Candidate implementation SHA | **VERIFIED** `dcc2608f963c4fc80d4acb593a4b71e0c3ccb2af` |
| business purpose authority | `SweetCardBatch.businessPurpose` (`COMMERCIAL` / `ACCEPTANCE_TEST`) |
| archive authority | Candidate 增加 `SweetCardBatch.archivedAt DateTime?` |
| Migration changed | **YES** — additive Candidate Migration 66 |
| Production deploy | **NOT AUTHORIZED / NOT RUN** |

只读 schema 审计确认，Production baseline 没有 `archivedAt`、`archived`、`deletedAt`、正式 archive metadata contract 或 Batch lifecycle/DRAFT authority。因此 Candidate 只增加 nullable `archivedAt` 和查询索引；默认 `NULL`，没有历史 backfill，没有自动归档。

## 运营信息架构

默认视图为 **商业运营**。

| 视图 | 服务端 scope | 行为 |
| --- | --- | --- |
| 商业运营 | `businessPurpose=COMMERCIAL&archived=false` | 默认日常运营批次、卡片、使用记录和顶部统计 |
| 测试/验收 | `businessPurpose=ACCEPTANCE_TEST&archived=false` | 验收与测试事实独立展示 |
| 已归档 | `businessPurpose=ALL&archived=true` | 同时展示两种 purpose，并显示中文 purpose 与“已归档”标签 |

状态、绑定模式、载体和 purpose 均通过统一 label helper 显示中文；请求、筛选和表单提交仍使用原始 enum 值。

Operational endpoints 按 `businessPurpose + archivedAt` 过滤。`/sweet-cards/reconciliation` 继续使用 `ALL_REAL_FACTS`，不读取 archive scope，所以归档不会改变完整资金对账。

## 归档、恢复与权限

Candidate 新增：

- `POST /api/v2/sweet-cards/batches/:id/archive`
- `POST /api/v2/sweet-cards/batches/:id/restore`

服务端要求现有 `SWEET_CARD.manage` capability。普通 POS/cashier 没有该 capability，返回 403。每次成功变更在同一数据库事务内写入：

- `sweet_card.batch_archived`
- `sweet_card.batch_restored`

审计包含 actor、batch、timestamp、可选 reason、前后 `archivedAt`，并标记 `visibilityOnly: true`。并发条件更新只允许预期状态发生一次变化，重复/竞态请求返回 409。

归档与恢复只更新 `SweetCardBatch.archivedAt`。Card lifecycle、balance、binding、Credential、Ledger、Redemption、Refund、Order、Settlement 和 Payment 均不更新。UI 将操作放在批次卡片的二级“批次操作”中；归档使用指定确认文案。

## Hard delete 与 Card delete

**Hard delete: NOT AVAILABLE**

**Card delete: DISABLED**

原因：当前 Batch schema 没有 DRAFT/未发行 authority，批次创建合同要求立即生成 1–500 张 Card，且 `SweetCardAuditLog.batchId` 以 `onDelete: Restrict` 保留审计链。不能把“空批次”猜测成 DRAFT。因此本 Candidate 没有新增 Batch DELETE endpoint，也没有“删除空批次”按钮。即使通过数据库直接构造 0-card Batch，HTTP DELETE 仍不存在。Card/Credential/Ledger DELETE 也没有新增。

## VOID 审计结果

**VOID: EXISTING CONTRACT ONLY**

现有服务端 endpoint 为 `POST /api/v2/sweet-cards/cards/:id/void`，要求 `SWEET_CARD.void` capability。合同允许当前持久化状态不是 `EXHAUSTED` 或 `VOID` 的卡作废；它把 Account 状态设为 `VOID`、增加 version、撤销未撤销 Credential 并记录 `CARD_VOID`，随后写入 `sweet_card.void` Audit。

现有 VOID 不清零 balance，不新增或修改 Ledger，不删除 Issue/Card/Order/Redemption/Refund。Candidate 没有改变该经济语义，只把入口从卡片主列表移至详情页二级“卡片危险操作”，增加明确二次确认。UI 对 `VOID`、`EXHAUSTED`、有效状态 `EXPIRED` 不显示入口。

## Production 经济基线

以下事实来自本 Gate 的 Production 只读查询。Candidate 工作没有连接 Production 执行写请求。

| 指标 | 当前 Production |
| --- | ---: |
| Card accounts | 16 |
| Credentials | 17 |
| Bindings | 2 |
| Ledger rows | 29 |
| Redemption rows | 9 |
| Refund rows | 4 |
| ISSUE | 400,150 cents |
| REDEEM | 160 cents |
| REFUND | 100 cents |
| REVERSAL | 0 cents |
| Full balance | 400,090 cents |
| Full Ledger sum | 400,090 cents |
| Ledger delta | **0 cents** |
| Commercial-only outstanding | 250,000 cents |
| Acceptance-only outstanding | 150,090 cents |

生产六类经济表只读快照 digest：`e581fd22c71cc266f9f33b11092cfc9e833997c35454c5e8b232f25d84cec350`。

Production before 已 **VERIFIED**。Production after 为 **UNVERIFIED**，因为 Candidate 尚未部署；当前阶段的可验证结论是 Production 没有发生由本任务引起的 mutation。隔离 PGlite 演练证明 archive/restore 前后 Account、Credential、Binding、Ledger、Redemption、Refund 逐表快照相等，合成 Ledger/balance 均为 2,000 cents，delta 0。

## 当前批次只读清单

### COMMERCIAL（2）

| Batch | Cards | 当前卡状态摘要 | Balance |
| --- | ---: | --- | ---: |
| `BUDU-SC-202609-A01` | 10 × 20,000 cents | 9 CREATED / 1 VOID | 200,000 cents |
| `budu` | 1 × 50,000 cents | 1 FROZEN | 50,000 cents |

`BUDU-SC-202609-A01` 仍为 `COMMERCIAL`。本任务没有归档、作废或修改其 10 张卡。上表状态是本次只读审计观察到的当前真实状态，不以旧 checkpoint 覆盖。

### ACCEPTANCE_TEST（5）

| Batch | Cards | 当前卡状态摘要 | Balance |
| --- | ---: | --- | ---: |
| `PROD-P7...` | 1 × 50 cents | EXHAUSTED | 0 cents |
| `P10C...` | 1 × 100 cents | VOID | 90 cents |
| `测试` | 1 × 50,000 cents | CREATED | 50,000 cents |
| `9.4` | 1 × 50,000 cents | CREATED | 50,000 cents |
| `测试` | 1 × 50,000 cents | ACTIVE | 50,000 cents |

Production archived count 当前为 **0 / authority not deployed**。Migration 66 应用后所有现有批次仍为 `archivedAt = NULL`，不会自动进入已归档视图。

## 权限矩阵

| Actor | 查看三视图 | Archive / restore | VOID | Hard delete | Card delete |
| --- | --- | --- | --- | --- | --- |
| Sweet Card 管理员（对应 capability） | ALLOW | ALLOW (`manage`) | ALLOW (`void`) | NOT AVAILABLE | DISABLED |
| 普通 POS / cashier | DENY 管理页 | **403** | 403 | NOT AVAILABLE | DISABLED |
| 未登录 / spoof body principal | DENY | 401/403 | 401/403 | NOT AVAILABLE | DISABLED |

权限结论由集中 capability 单元测试、路由强制 `requireAdmin(...MANAGE)`、无 DELETE 路由静态合同验证。由于本机没有 loopback PostgreSQL，完整 Express+Prisma 归档 API 集成分支未运行；Migration 和数据不变量使用隔离 PGlite 执行，Production 未被用作测试库。

## Test matrix A–Q

| Case | Result | Evidence |
| --- | --- | --- |
| A 默认只显示 COMMERCIAL 非归档 | PASS | UI 浏览器 + scope API contract |
| B 测试/验收可见 | PASS | UI 浏览器 + scope API contract |
| C 已归档可见且含两种 purpose | PASS | UI 浏览器 |
| D 归档后商业视图隐藏且 Full Ledger 不变 | PASS (isolated) | PGlite snapshot equality + UI |
| E 恢复后回到运营视图 | PASS (isolated) | PGlite + UI |
| F 普通 POS archive API 403 | PASS (contract) | centralized cashier capability DENY + server guard；真实 PG API 分支待 Production Gate 前隔离复核 |
| G archive 不改 Card lifecycle | PASS (isolated) | Account snapshot equality |
| H archive 不改 Balance / Ledger | PASS (isolated) | economic table snapshot equality, delta 0 |
| I 有 Card 的 Batch hard delete DENY | PASS | endpoint 不存在 |
| J 有经济/业务引用 hard delete DENY | PASS | endpoint 不存在；Audit FK RESTRICT |
| K safe empty DRAFT delete | N/A | schema 无 DRAFT authority，不提供 delete |
| L Card DELETE | PASS | endpoint 不存在 |
| M VOID 沿用现有资金合同 | PASS | existing transition/audit tests + source audit |
| N 商业报表排除 ACCEPTANCE_TEST | PASS | purpose regression + scoped operational API |
| O Full Ledger 包含全部真实事实 | PASS | reconciliation contract；Production delta 0 |
| P Mobile | PASS | 320/340/375/390/430px，无横向溢出 |
| Q Cash / WeChat / Alipay / POS | PASS | regression results below |

## Regression evidence

- Production build: PASS
- Existing Sweet Card suite: 49/49 PASS
- Sweet Card data organization: PASS (`PGLITE_ISOLATED_MIGRATION_AND_CONTRACT`)
- Sweet Card 管理 UI: 7/7 PASS
- Sweet Card POS mobile: 7/7 PASS
- Account permissions: 17/17 PASS
- POS core: 10/10 PASS
- POS/payment-access/order-summary additions: 5/5 PASS
- Cash/payment foundation: 22/22 PASS
- WeChat + Alipay provider/config/callback/reconciliation: 91/91 PASS
- `git diff --check`: PASS

截图：

- `output/playwright/sweet-card-commercial-mobile.png`
- `output/playwright/sweet-card-archived-mobile.png`

## Production Gate 前置检查

Reviewer 明确授权后，Production Gate 必须重新验证 current runtime SHA、65/0 migration、fresh backup 与 restore listing/SHA-256、rollback baseline、Sweet Card commercial health 和 single writer；在隔离 PostgreSQL 运行完整 Express+Prisma archive/restore/403 integration 后再应用 Migration 66。部署后复核 health、database identity、66/0、经济快照/delta、商业批次、权限、Cash、WeChat、Alipay 和 POS，才可把状态更新为 `SWEET_CARD_DATA_ORGANIZATION_1_0_COMPLETE`。
