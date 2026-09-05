# budu Sweet Card 数据整理 1.0

审计与上线时间：2026-09-05（Asia/Shanghai）

任务模式：STRICT

模型记录：`MODEL_CONFIGURATION_NOT_VERIFIABLE`

## Gate 状态

`SWEET_CARD_DATA_ORGANIZATION_1_0_COMPLETE`

Production Gate 经 reviewer 明确批准后执行完成。GitHub Actions run：
<https://github.com/GPTJJ/budu/actions/runs/33949844005>

## Production authority

| 项目 | VERIFIED 当前事实 |
| --- | --- |
| Runtime SHA | `1d0899ac3b576f5a8045e49a929b4cf3939add35` |
| Runtime container | `budu-prod-1d0899a-sweet-card-data-org` |
| Database | `budu_bj006` |
| Migration | 66 applied / 0 failed |
| business purpose authority | `SweetCardBatch.businessPurpose` (`COMMERCIAL` / `ACCEPTANCE_TEST`) |
| archive authority | `SweetCardBatch.archivedAt DateTime?` |
| Migration changed | YES — additive Migration 66 |
| Writer count | 1 |
| Sweet Card commercial flag | ENABLED |
| Xidan authorized operator count | 3 |

Migration 66 只增加 nullable `archivedAt` 与查询索引。没有历史 backfill、自动归档或经济字段修改。上线时 7 个现有批次均保持 `archivedAt = NULL`。

## 运营视图

| 视图 | 服务端 scope | 行为 |
| --- | --- | --- |
| 商业运营 | `businessPurpose=COMMERCIAL&archived=false` | 默认视图；只显示商业、未归档批次及相应卡片、使用记录和统计 |
| 测试/验收 | `businessPurpose=ACCEPTANCE_TEST&archived=false` | 独立显示验收与测试事实 |
| 已归档 | `businessPurpose=ALL&archived=true` | 显示全部 purpose 的已归档批次及中文 purpose 标签 |

状态、绑定模式、载体和 purpose 统一由 label helper 显示中文；API、筛选与表单仍提交原始 enum。`/sweet-cards/reconciliation` 始终使用 `ALL_REAL_FACTS`，不读取 archive scope。

## 归档、恢复与删除边界

- `POST /api/v2/sweet-cards/batches/:id/archive`
- `POST /api/v2/sweet-cards/batches/:id/restore`
- 权限：现有 `SWEET_CARD.manage`；管理员 ALLOW，普通 POS/cashier 403。
- 同一事务写 `archivedAt` 与 `sweet_card.batch_archived` / `sweet_card.batch_restored` Audit；重复或竞态状态变更返回 409。
- 归档只改变批次可见性。Card lifecycle、balance、Credential、Ledger、Redemption、Refund、Order、Settlement、Payment 均不更新。
- Batch hard delete：`NOT_AVAILABLE`。当前 schema 没有可靠 DRAFT authority，且 Audit FK 保持 `onDelete: Restrict`。
- Card delete：`DISABLED`，没有新增 DELETE endpoint。
- VOID：`EXISTING_CONTRACT_ONLY`。入口移至详情页二级危险操作并增加确认；既有状态机、资金与审计合同未修改。

隔离真实 PostgreSQL API 验证：archive 200、restore 200、普通 POS archive 403、Batch DELETE 404、Card DELETE 404、既有 VOID 200、Ledger delta 0。

## Production 经济核对

| 指标 | 上线前 | 上线后 |
| --- | ---: | ---: |
| Card accounts | 16 | 16 |
| Credentials | 17 | 17 |
| Bindings | 2 | 2 |
| Ledger rows | 29 | 29 |
| Redemption rows | 9 | 9 |
| Refund rows | 4 | 4 |
| ISSUE | 400,150 cents | 400,150 cents |
| REDEEM | 160 cents | 160 cents |
| REFUND | 100 cents | 100 cents |
| REVERSAL | 0 cents | 0 cents |
| Full balance | 400,090 cents | 400,090 cents |
| Full Ledger sum | 400,090 cents | 400,090 cents |
| Ledger delta | **0 cents** | **0 cents** |
| Commercial-only outstanding | 250,000 cents | 250,000 cents |
| Acceptance-only outstanding | 150,090 cents | 150,090 cents |

上线前后经济 digest 均为 `367cb2c54abea909af01e3c710fa8ab5531ad2a9628250e1597865d620b8eff3`。Payment provider states 与 Refund count 也逐项相等。商业运营视图只统计两个 `COMMERCIAL` 批次，因此不会计入验收/测试的 150,090 cents；Full Ledger 继续包含全部真实事实。

## 当前批次

### COMMERCIAL（2）

| Batch | Cards | 状态摘要 | Balance |
| --- | ---: | --- | ---: |
| `BUDU-SC-202609-A01` | 10 × 20,000 cents | 9 CREATED / 1 VOID | 200,000 cents |
| `budu` | 1 × 50,000 cents | 1 FROZEN | 50,000 cents |

### ACCEPTANCE_TEST（5）

| Batch | Cards | 状态摘要 | Balance |
| --- | ---: | --- | ---: |
| `PROD-P7...` | 1 × 50 cents | EXHAUSTED | 0 cents |
| `P10C...` | 1 × 100 cents | VOID | 90 cents |
| `测试` | 1 × 50,000 cents | CREATED | 50,000 cents |
| `9.4` | 1 × 50,000 cents | CREATED | 50,000 cents |
| `测试` | 1 × 50,000 cents | ACTIVE | 50,000 cents |

Archived batch count：0。上线没有自动归档、作废或改动任何卡。

## Canonical restore artifact

| 项目 | VERIFIED |
| --- | --- |
| Path | `/opt/budu/.rollback-assets/sweet-card-data-org-1d0899a-20260905T063746Z/current-canonical-budu_bj006-m66-data-organization.dump` |
| SHA-256 | `cd9283c929d0dc17c768c2dea92b1ed2a896f8d08386d11f77ba9083c7aef374` |
| pg_restore listing | 6,103 entries |
| Restore identity | `budu_restore_m66` / 66 applied / 0 failed / 7 batches / 0 archived |
| Marker | `CURRENT_CANONICAL_RESTORE_ARTIFACT` |

Gate 同时创建 fresh pre-promotion M66 backup，并先恢复到隔离 PostgreSQL 运行真实 API 集成；最终 dump 再次通过 `pg_restore --list`、SHA-256 和独立数据库 restore identity 校验。旧 backup 均保留。

## Regression A–Q

| 范围 | 结果 |
| --- | --- |
| 默认 COMMERCIAL、验收视图、已归档视图 | PASS |
| Archive / restore / Audit / 409 concurrency | PASS |
| 普通 POS archive 403 | PASS |
| Card lifecycle、Balance、Ledger 不变 | PASS |
| Batch hard delete / Card delete 边界 | PASS |
| VOID 既有合同 | PASS |
| 商业报表排除 ACCEPTANCE_TEST | PASS |
| Full Ledger 包含全部真实事实 | PASS |
| 320/340/375/390/430px mobile | PASS |
| Sweet Card suite | 49/49 PASS |
| Sweet Card 管理 UI | 7/7 PASS |
| Sweet Card POS mobile | 7/7 PASS |
| Account permissions | 17/17 PASS |
| POS core | 10/10 PASS |
| Payment foundation | 22/22 PASS |
| Cash / WeChat / Alipay / reconciliation | PASS |
| Production build / public health | PASS |

截图：

- `output/playwright/sweet-card-commercial-mobile.png`
- `output/playwright/sweet-card-archived-mobile.png`
