# NEXT_FIX_1 — Transfer Lifecycle CAS Guard

2026-09-26，候选审查交接。实现与测试完成；用户已明确授权豁免已记录的基线失败并创建本地commit，**RESULT = READY_FOR_REVIEW**。没有生产部署或写入。

## Baseline / branch

- BASE_BRANCH: `origin/workbuddy/wechat-shipping-info-sync`
- BASE_SHA: `fc57da5a6e6611c66ed1db286336dc0e1752d69c`
- WORK_BRANCH: `codex/transfer-cas-guard`
- Remote: `https://github.com/GPTJJ/budu.git`
- Authoritative base: fresh fetch 后 origin/main=`d3ca1e6...`，是发布分支祖先；left/right=0/281，发布分支tip与live health相同。没有用旧main覆盖已上线功能，也未合并其它未发布候选。
- 当前主工作区 feat/pos-wechat-refund@788458a... 不是生产主线；既有untracked文件保留且未纳入本候选。
- 2026-09-26 22:47 +08:00 只读复核：Production fc57da5a6e66；DB budu_bj006 / PostgreSQL16.14；migration85 applied/0 failed；48 Transfer中非shipped带shippedAt=0；PG应用client172.20.0.3共5 idle sessions。磁盘81%，available11,589,020 KiB。
- 本轮无新backup/rollback；生产rollback readiness没有重做演练，未来部署Gate需重新验证。

## Root cause / behavior

**ROOT_CAUSE:** withdraw/reject预读pending后，仅按id执行update。ship虽已使用pending/deletedAt CAS，仍可能被后续stale writer覆盖。

**BEFORE_BEHAVIOR:** 实际生产handler +真实本机PostgreSQL +读取屏障已复现：

```
winner=ship loser=withdraw loserHttp=200 final=canceled
winner=ship loser=reject   loserHttp=200 final=rejected
```

这是离线可达风险，不是生产已发生数据损坏。

**AFTER_BEHAVIOR / CAS_RULE:** withdraw与reject均执行单条原子updateMany，条件为`id = target AND status = 'pending' AND deletedAt IS NULL`；count不为1返回HTTP409，成功后重新读取既有include并serialize。withdrawnBy/withdrawnAt/updatedAt只在赢得CAS时落库。

ship的CAS、事务、权限、实发数量及通知逻辑不变。**唯一ship改动**是非pending预检查400→409：用户Gate4第11/12项明确要求已canceled/rejected的ship返回409；修复前测试直接证明返回400，故这是本次验收所必需的合同调整。

Existence和权限判断次序保持原样：不存在404；已删除withdraw409，ship/reject仍404；正常权限拒绝403。没有将已删除实体重新暴露出来。

## Files changed / why

| File | Why changed |
| --- | --- |
| server/v2.js | reject/withdraw用现有schema进行CAS；三条生命周期路径统一终态冲突409；业务代码15新增/7删除 |
| scripts/test-transfer-lifecycle-cas.mjs | 真实PG与生产Express handler的60项确定性并发/终态/删除/权限/副作用验收；无timing sleep |
| scripts/test-inventory-workflow.mjs | 仅更新已发货撤回的预期400→409，匹配用户明确HTTP合同；未修改既有通知失败断言 |
| scripts/run-tests.mjs | 新回归注册至普通与critical测试清单，防止后续漏跑 |
| docs/checkpoints/2026-09-26-transfer-lifecycle-cas.md | 本任务基线、证据、失败归因和交接 |

DB_SCHEMA_CHANGE=NO；MIGRATION_REQUIRED=NO。没有新表/version字段/分布式锁/Redis锁/advisory lock/空migration。

NO_UI_CHANGE=YES；NO_DB_SCHEMA_CHANGE=YES；NO_CLOUDBASE_CHANGE=YES；NO_PAYMENT_CHANGE=YES；NO_SWEET_CARD_CHANGE=YES；NO_APPROVAL_CHANGE=YES；NO_PARTNER_CHANGE=YES；NO_SHIPPING_CHANGE=YES（指Online/Legacy物流同步；Transfer ship仅终态HTTP409）。

## Tests before / after

测试仅使用本机127.0.0.1:55437、独立PostgreSQL16.14。运行环境白名单隔离、APP_ENV/NODE_ENV=test，未继承生产/外部服务凭据。现有helper为每个需要DB的测试创建唯一database，并应用当前85个既有migration；**这是本机测试初始化，不是production migration或schema变更**。node_modules复用匹配基线的依赖，未改package或lockfile。

| Suite | TESTS_BEFORE | TESTS_AFTER | Conclusion |
| --- | --- | --- | --- |
| 新CAS验收60项 | 40 PASS /20 FAIL | **60 PASS /0 FAIL /0 SKIP** | 所有新增验收通过 |
| Transfer既有11文件 | 49 PASS /1 FAIL | 49 PASS /1 FAIL | 同一既有通知预期失败；无新增失败 |
| 扩展主测试8文件 | 23 PASS /9 FAIL /1 SKIP | 23 PASS /9 FAIL /1 SKIP | 原始release与候选复现相同失败，未伪装全绿 |
| Transfer与权限WebKit | 未改UI | **20 PASS /0 FAIL** | 现有流程、发货数量、导出及权限展示通过 |
| Production build（本机） | 未重跑旧build | **PASS** | npm run build |
| Static diff / schema | — | **PASS** | git diff --check；schema/migrations差异为空 |

注意node:test会把直接执行脚本计为1项、嵌套失败计入父子统计；以上为runner原始统计，不当成独立业务场景总数。没有通过删除/跳过/放宽校验使测试变绿。

**KNOWN_BASELINE_FAILURE（同基线复核，无关项没有修复）：**

1. `test-inventory-workflow.mjs:137` 期待旧fallback中同时有group与developer；当前通知路由合同已变化。该断言在任何修复前已失败，导致该脚本后续断言未执行。新CAS suite与box-piece workflow另行覆盖本次状态/数量/通知行为。
2. `test-store-directory.mjs:42` 期待部署脚本文本`authority-aware green deployment`，当前脚本不含该精确字符串；与本次v2状态更新无关。
3. `test-order-purpose-native.mjs:33` 硬编码迁移数量83，当前移除目标migration后实际84；未改迁移历史或数量断言。
4. `test-notification-center.mjs` 旧公众号token模拟返回不符合当前适配器；另原schema式迁移前置失败，后续通知DB断言连带失败。前置失败具体兼容原因未在本任务扩展修复。两份源码基线执行结果一致。
5. 扩展suite的1个可选DB烟测SKIP保留原状；不是本次新增并发测试的skip。

## Concurrency test results

| Case | Result |
| --- | --- |
| 正常pending→ship/withdraw/reject | 三项PASS，DTO字段完整 |
| ship赢，withdraw/reject先读pending | 后者409，shipped状态、shippedBy/At、item数量及通知不变 |
| withdraw/reject赢，ship先读pending | ship409，无shippedAt/By、无实发数量、无发货通知 |
| withdraw vs reject双向 | 输者409，首次提交记录逐字段不变 |
| 三种操作并发重复 | 首次提交200，旧快照请求409 |
| 三种操作顺序重复 | 第二次409，首次actor/time/items不变 |
| shipped/canceled/rejected ×三操作 | 全部409，不覆盖终态 |
| 已deleted ×三操作 | 保持既有404/409合同，零状态推进 |
| 预读pending后deleted ×三操作 | 全部409，deleted记录逐字段不变 |
| missing ×三操作 | 404 |
| 9种现有principal ×三操作 | 27项PASS：developer/admin/finance、调出manager、调入manager、创建staff、其它staff、跨店授权staff、module受限manager |

屏障通过Prisma query extension在真实findUnique/findFirst读取完成后暂停一次；胜者走同一生产HTTP handler并提交真实PG，再放开败者。没有替换updateMany、事务、SQL或实际权限函数。测试app仅注入已认证principal；会话及外层module控制由已有role-module API suite另行验证。

**Can shipped ever be overwritten by reject after this fix? NO**，限这条修复后的业务路径：WHERE要求pending，真实PG确定性交错证明输者409且完整记录不变。

**Can shipped ever be overwritten by withdraw after this fix? NO**，同一原子条件及对应PG/HTTP测试证明。这里不声称任意管理员直接SQL或未来新增writer也受此次应用守卫控制。

## Static writer review

**ADDITIONAL_TRANSFER_WRITER_FOUND = NO（同一pending/shipped/canceled/rejected状态竞争范围）。**

- `server/v2.js`：create默认pending；TEST创建亦默认pending；ship、withdraw、reject是已有记录的三条生命周期终态writer，当前都使用pending/deletedAt CAS。
- `server/developer-safe-delete.js`：受独立权限控制的delete/restore只写deletedAt/By/reason并审计，不写status；删除竞争已由新测试覆盖。
- `server/order-purpose-service.js`：仅purpose更正或受控测试记录删除；没有新的status终态writer。
- `scripts/migrate-kv-to-pg.mjs`：历史离线导入只在ID不存在时create；不是运行中的已有Transfer状态覆盖入口，未运行。
- `src/utils/inventory.js`：旧compatibility数据转换，不写PG TransferRequest；未修改。
- Migration SQL及测试fixture中的历史写入不等于在线writer，未改动。

## Commit / production / remaining risk

COMMIT_SHA=包含本交接文件的提交（用 `git log -1 --format=%H -- docs/checkpoints/2026-09-26-transfer-lifecycle-cas.md` 获取；完整SHA另记录在本机 completion-status.json 与最终回复，避免自引用SHA）。PRODUCTION_DEPLOYED=NO；PRODUCTION_WRITE_OPERATIONS=0。没有push/merge/deploy/restart/prune或生产测试单；没有触达CloudBase/支付/退款/实际通知接口。

附件Gate9要求“全部测试通过后”创建commit；虽然新验收60/60、浏览器20/20和build均通过，但现有回归不是全绿。其无关修复超出授权范围，不能自行改通知/部署/历史migration测试来满足门槛。当前候选已具体可审查；用户随后明确答复“允许本地 commit，保留基线失败记录”。仅此Gate9基线失败豁免获得授权；失败仍保留，不改成PASS，不扩大修复或发布范围。

候选未部署，生产风险仍存在。源码核验的旧数据没有已发生矛盾，不修改任何生产历史。CAS之后读响应不是新的持久化authority；未来部署需新基线及独立发布/回滚验证。

本候选将完成本地commit；未push的commit不可从远端或其它设备恢复。本机未跟踪的node_modules软链接/构建产物及临时证据不纳入commit。原工作区既有未提交内容保持原样。全部日志保留本机，测试PostgreSQL已关闭。

本地完整证据目录：`/private/tmp/budu-transfer-cas-20260926`。主要文件：before-cas.log、after-cas.log、baseline-transfer.log、after-transfer.log、baseline-foundation.log、after-foundation.log、browser.log、build.log、production-baseline.txt、transfer-writer-scan.txt。
