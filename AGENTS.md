# budu Master Instructions v2

适用于参与 budu 开发、审计、发布和生产维护的 ChatGPT、Work、Codex 及其他 Agent。
Data Authority 1.0 已 LIVE；**保持唯一数据权威、保护现有生产能力、最小安全变更**是永久工程基线。
本文件规定工程边界，不授予生产操作权限，也不固化任何 Production SHA、数据库或迁移数量。

## BUDU Codex Skills

- Any BUDU engineering task: consult/use `budu-task-router`.
- New or resumed context: use `budu-context`.
- Data identity or source-of-truth changes: use `budu-data-authority`.
- Frontend or mobile work: use `budu-mobile-ui`.
- After code changes: use `budu-regression`.
- Deployment work: use `budu-production-deploy`.
- Payment or refund work: MUST use `budu-payment-safety` in STRICT mode.
- Sweet Card, gift-card, redemption, balance, binding, loss, or replacement work: use `budu-sweet-card` (and `budu-payment-safety` whenever value or settlement is involved).
- Device, conversation, or task handoff: use `budu-handoff`.

Detailed workflows belong in the skills under `.agents/skills/`; keep this file concise.

执行前主动发现根目录及目标子目录 `AGENTS.md`、`.agents/skills/`、Handoff、
`docs/DATA_AUTHORITY.md`、Authority Matrix / Writer Map、项目规范、Runbook 和已有 tests。
按实际任务选择适用 Skill 并读取 `SKILL.md`，不得凭习惯绕过已建立约束。
若当前 checkout 缺少 Skill，先查可信仓库分支或已安装位置；仍缺失或不适用则记录后按现有规则继续，
但不得跳过必要安全 Gate。根规则与子目录规则存在无法安全合并的冲突时，STOP 并报告，不得覆盖。

## 用户指令约定

- 用户发送【push】时：把当前工作区未提交的任务进度（代码、文档、配置等，排除临时与工具目录）提交并推送到 GitHub；先 `git fetch`，如有远端新提交先 `rebase` 再推送，避免覆盖他人改动。
- 该约定仅覆盖本任务已识别、已授权的改动；来源不明的 dirty files 必须保留并排除。使用 normal push，不得擅自 force push。
- 用户未明确要求 push 时，不因 handoff 或得到 clean working tree 而擅自推送。

## 1. Session Bootstrap 与证据优先级

每次任务开始先读适用规则，以及存在的 `docs/BUDU_STATUS.md` / `docs/PROJECT_STATUS.md`；
检查 remote、branch、HEAD、upstream、working tree、候选及相关 release/checkpoint。
默认顺序：**READ → VERIFY → PLAN → CHANGE → TEST → RECONCILE → REPORT**。

- **Repository / Production Facts > Memory**：Memory、旧聊天、旧截图和历史报告只提供经验、偏好和背景，不证明当前事实。
- 每次关键任务实时核验 Production SHA、branch / candidate SHA、DB、schema、migration、writer、rollback baseline、release asset、CI result、image identity、disk 和 current authority。
- 生产安全相关事实必须由当前 runtime / DB / provider 直接证明；不得假定本地 HEAD、文档或参考 SHA 就是生产。未验证项标记 `UNVERIFIED`，不得据此执行依赖这些事实的变更。
- 纯文档任务不为填报告而扩大到生产操作；Production facts 未查就明确标记未查。历史 SHA 无论来自用户还是仓库，都不能成为永久生产真理。
- 旧文档与直接生产证据冲突时，以实时事实为准，报告 drift；若影响安全执行，标记 `AUTHORITY CONFLICT` 并 STOP 受影响操作，不得凭猜测选边。
- 优先从 GitHub / CI / Production / DB / runtime / logs 获取证据；只有信息仅在 Agent 私有聊天且无法外部核验时，才向用户索要最少必要报告。

证据状态必须区分：`VERIFIED`（本次直接证明）、`OBSERVED`（源码/配置/日志观察）、
`INFERRED`（推导）、`UNVERIFIED`（证据不足）、`STALE`（已过期）、`BLOCKED`（不能安全继续）。
不得把观察或推断写成已验证，也不得弱化状态词掩盖未知。

## 2. Data Authority 1.0 / Single Source of Truth

商品、订单、支付、退款、Sweet Card、库存、调拨、采购、合作商、薪资、工时、审批、权限、
通知、物流、小程序和 POS 等业务，每个事实必须只有一个最终 Authority。
开始前调查现有权威数据、模型、服务、数据库、API、状态机、配置、业务链、mapping 和 tests，优先复用。
涉及共享业务先查 Authority Matrix / Writer Map / Data Authority 文档与当前代码，确认 canonical authority、stable identity、writer 和状态机。

任何会改变业务数据的新功能，实施前必须明确记录：

```text
AUTHORITATIVE_SOURCE =
WRITER =
STABLE_ID =
STATE_TRANSITION =
CONCURRENCY_GUARD =
ROLLBACK / REVERSAL =
```

无法回答则 **STOP**。禁止复制第二套权威商品、订单、库存、用户身份或支付事实；禁止重新引入 dual authority。
页面显示、字段名称、snapshot、cache、mirror、前端状态、localStorage、CloudBase 副本或临时表不得替代 canonical fact。
不得让两个系统同时最终决定同一个业务事实。

## 3. Stable Identity First 与 SKU

- 商品稳定身份是 **`InventoryItem.id`**；SKU 是业务编码，**SKU ≠ Product Identity**。名称、展示文案、SKU 文本、员工姓名、商品名和门店显示名均不得代替 stable ID。
- 历史业务使用 **stable ID + immutable snapshot** 保存当时事实；订单、调拨、采购、Sweet Card 等关系不得因商品改名或 SKU 变化而断裂。
- SKU 可受控迁移，但不得因此新建商品 identity、改变已有 `InventoryItem.id` 或用新 SKU 回写/重写历史 snapshot。
- SKU 最终业务规则须由用户确认，再形成唯一 **SKU Generator / Validator**；新商品按统一规则自动生成，保证唯一、可验证、可追踪、格式统一，禁止各页面、POS、小程序或员工各自生成。
- 规则未确认前，不得自创编码体系。迁移前核验现有导入、搜索、销售渠道与跨系统 mapping，保持当前运行链及历史引用完整。

## 4. 分工、授权与 Handoff

| 角色 | 职责 |
| --- | --- |
| 用户 | 业务目标、优先级、最终业务规则和高风险决策 |
| ChatGPT | Orchestrator / 总控：需求、可行性、架构、Authority、风险、Agent 分工、Gate 和最终判断 |
| Work | 执行总控：多步骤工作流、浏览器、电脑、文件、GitHub、服务器及协调 Codex |
| Codex | 工程执行：仓库调查、代码、测试、Git、CI、release engineering 和已授权 Production deploy |

一个任务只有一个 Orchestrator；不得让多个 Agent 各自决定同一业务架构。
用户仅提出需求时先评估必要性、可行性、风险和范围；明确确认具体任务后可执行该范围。
复杂任务按 Gate 执行；未授权后续 Gate 时等待授权。已有端到端授权（如“全自动执行”“跑到完成”“除扫码外不要中断”）时，
不要为每个 Gate、commit、测试或普通 CI 重复确认。

仅在需要扫码/设备登录/OAuth、真实业务规则决策、不可逆数据修改、destructive migration、删除真实业务数据、
实质扩大范围、无法安全 rollback 或新增高风险 Production 授权时暂停向用户确认；安全异常仍按 STOP 条件处理。
高风险操作前必须核验目标、范围、备份与回滚基线，已获授权的普通步骤不重复索取许可。
确认后环境支持 Work/Codex handoff 或插件/电脑控制时，优先直接发送最终指令给执行 Agent；
只有工具受限才要求最少手动操作，不让用户反复搬运长指令。

## 5. Minimal Change 与 Data Authority Impact Review

只修改当前目标必需内容，保持 diff 小、原因明确、可审计、可回滚。
禁止顺手重构、升级依赖、改 UI、清技术债、修其他 race 或整理无关代码，除非直接阻断当前目标。
优先成熟、稳定、清晰、可维护、自动化的最小正确方案，不为技术复杂性扩大架构。

涉及数据写入的新功能上线前，检查是否新增 writer、第二权威、stable identity 变化、历史 snapshot 改写、dual write、
transaction 破坏或 existing reconciliation 破坏。破坏 Data Authority 1.0 的变更禁止上线。
新增 SKU、库存、会员、积分、支付、订单、小程序、POS、Partner 或 Sweet Card 功能必须服从现有 Authority Matrix；
若需改变 Authority，必须显式执行 **Authority Transfer**，禁止静默创造第二权威。

## 6. Inventory 1.0

实施前先审计现有库存模型与 writer，不得假定需要重建。
目标是统一库存 movement authority：**Inventory Movement / Stock Ledger（`StockLedger` / `Movement`）为 movement facts，
`StockBalance` 为当前余额 / projection**；这是待审计确认的实施方向，不宣称当前已经实现，也不授权另建第二账本。

POS sale、purchase receipt、transfer out / transfer receipt（in）、internal use、waste/write-off、
stocktake gain/loss 和 return-to-stock 都必须进入统一库存权威链。
禁止 POS、调拨、采购、报损、公司领用、小程序各自任意修改库存余额。
库存 mutation 必须幂等、可审计、可追踪 `refId`，包含 actor / timestamp / reason，并具备 concurrency guard。

## 7. 小程序 / CloudBase 边界

不得默认小程序、CloudBase、静态 menu、客户端 subtotal 或缓存就是 canonical authority。
跨小程序、budu OS、POS、Sweet Card、商品中心的业务必须按 Authority Matrix 确认唯一最终事实。
CloudBase 若为副本，不得反向覆盖 canonical state；若仍为某明确域的 Authority，必须在矩阵中明确。
禁止 CloudBase 与 PostgreSQL 同时最终决定同一个业务事实。

## 8. Financial / Payroll Integrity、RBAC 与审计

- 支付、退款、Sweet Card、薪资、提成、工时是高完整性数据，必须保持 authoritative ledger、reconciliation、audit trail、idempotency 和 server-side validation。
- 不得为“修页面”直接改已完成账本、已发工资、历史支付或退款结果；账面与展示不一致先查 Authority。
- 前端隐藏按钮不等于权限控制；敏感操作必须 server-side auth，并检查实际 developer、super_admin、admin、finance、HR、store manager、staff、partner 等角色边界。
- 历史更正、权限修改、删除、退款、财务/库存变化、报损、公司领用、关键状态变化和测试数据清理必须记录 **actor、timestamp（time）、reason、before、after、reference**；禁止无痕修改。

## 9. Atomicity / Idempotency / Concurrency

状态变更、审批、支付、退款、发货、调拨、库存、结算、Sweet Card、采购、删除默认检查：
transaction、CAS / conditional update、expected status/version、idempotency key、duplicate submission、concurrency race 和 side-effect ordering。
禁止 read → stale write、last-write-wins、loser 覆盖 winner。
优先使用 `id + expected status/version` 的 conditional update，且 `count == 1` 才成功。
loser 返回 `409 / conflict`，不得留下 log、notification、ledger、node、comment、余额变化或任何其他 side effect。

## 10. Tests 与失败分类

优先 targeted tests，必要时才跑大型 Gate；不要重复消耗已有 exact SHA、可信 CI、真实 PostgreSQL 和 production validation 证据的测试。
关键并发必须优先在 **真实 PostgreSQL** 做 **deterministic contention test**；PGlite / mock 只能补充，不能替代。
禁止仅用 `Promise.all` 碰运气复现 race。

CI 红灯必须分类：`CANDIDATE_REGRESSION`、`BASELINE_EXISTING`、`TEST_INFRASTRUCTURE_BASELINE`、`UNKNOWN`。
只有 `CANDIDATE_REGRESSION = 0` 且 `UNKNOWN = 0`，并有证据支持 baseline failure，才可继续 release。
禁止关闭测试、删除 guard、修改 expectation 或吞掉失败来“变绿”。

**Never Weaken Safety to Pass**：不得删除校验、放宽权限、忽略 version、取消 CAS/事务、降低 disk threshold、
关闭 rollback/identity guard 或绕过检查来完成任务。正确修复超出授权范围时 STOP 并报告真实阻断。

## 11. Production Safety 与 exact SHA

无明确 Production 授权，禁止 deploy、写 Production DB、migration、restart、改 nginx/firewall/env/secret、
删除生产文件/volume/rollback asset；不得发送未经授权的真实业务通知。
任何 Production change 必须具备 **preflight + exact source identity + rollback path + post-deploy validation**。

正式发布锁定已授权 **exact SHA**，不得以 `latest`、未经验证 branch HEAD、新 commit 或旧 candidate 替代。
Production 有新部署后，旧 candidate 必须 reconciliation，不能覆盖新功能；落后候选先 STOP 发布。

## 12. Official Release Controller 与 Single Writer

优先使用已验证的正式 release controller；不得临时手写发布脚本、绕过 guard 或手工切换。
只有现有 controller 被证明不满足需求，并完成独立 release-engineering 修复后，才可在授权范围内变更发布路径。
必须保留 exact SHA、image/source identity、resource profile parity、disk guard、rollback asset、single writer、
candidate health、candidate application real DB probe 和 post-switch validation。

Production 必须保持明确 single-writer authority，切换不得让两个 production writer 同时处理权威写入。
若现有架构采用 **STOP OLD → START CANDIDATE → CHECK → REAL DB PROBE → SWITCH**，必须保留该 invariant，
不得为零停机私改为双 writer。

## 13. Real DB Probe 与 Startup Writes

不能仅凭 `DATABASE_URL` 存在、`/api/health dbOk`、PostgreSQL container alive、DNS 或 TCP 可达判断应用数据库健康。
关键 release / recovery 必须从 **application runtime** 执行真实只读查询，例如 **Prisma `SELECT 1`**。
即使 `/api/health` 后续升级成真正 DB probe，也须先以当前代码/生产证据确认，不依赖记忆。

仅允许 current production baseline 已存在且候选未扩大范围的正常 startup writes，
如既有 template ensure、同步任务、reminder job；必须按当前 baseline 实证确认。
禁止未知 startup writer、新增 seed、release script 主动业务写、测试业务数据或未审核 bootstrap。
发现未知 DB mutation 必须 **STOP / rollback**。

## 14. Migration / Schema

schema 与 migration 变化必须显式声明；禁止以“应用启动自动处理”为由隐式执行 migration。
`MIGRATION_REQUIRED = NO` 时若 release path 准备执行 migration，立即 **STOP**。
不可逆 migration 必须有 backup、reconciliation、rollback / restoration plan 和用户授权。
生产历史数据修改须先有 fresh backup、dry-run、reconciliation 和可执行恢复方案；不得越权执行。

## 15. Disk / Infrastructure 与服务器恢复

磁盘不足先只读分析；清理只删除已证明安全的失效资源，核验未被运行、路由、引用或保护。
禁止 `docker system prune -a`、`volume prune`、其他 broad prune、删除未知 containerd 数据、PostgreSQL 数据或 current / rollback images。
不得降低 disk guard 以通过发布。

服务器升级、重启、关机前确认 DB、application、restart policy、snapshot / backup、rollback。
恢复后必须验证 application、PostgreSQL、real DB query、migration、writer、disk，不能只看网页 health。

## 16. Secrets

绝不输出、提交或写入 Memory、Git、日志、报告中的私钥、数据库密码、Webhook Secret、Token、证书私密内容或完整 `DATABASE_URL`。
只记录 fingerprint、hash、脱敏值或 secret source。

## 17. Multi-Agent / Multi-Branch Safety

Work、Codex、WorkBuddy 等并行工作前确认 Production baseline、branch、worktree、candidate 和 task scope。
不得两个 Agent 同时修改和部署同一生产目标；遵守一个任务一个 Orchestrator。
未知 dirty worktree 禁止 `git clean`、`reset --hard`、stash、删除 unknown files；保留原工作区，优先新建 clean independent worktree。
不得用未经核验的其他 Agent 状态替代本次证据，也不得覆盖他人未完成工作。

## 18. 风险等级与 STOP Conditions

| 级别 | 定义 |
| --- | --- |
| P0 | 资金、权限、数据损坏、生产不可用等立即风险 |
| P1 | 破坏 authoritative fact、并发覆盖、双 writer、错误资金/状态的高优先问题 |
| P2 | 不影响当前 authoritative fact 的历史漂移、Legacy、可观测性或运维技术债 |

不得为“完成”将真实 P1 降为 P2；`P0_OPEN > 0` 或 `P1_OPEN > 0` 时不得宣布关键 Data Authority 项目 LIVE。
出现 Production 与预期不一致、Authority 不明、schema/migration drift、资金/权限异常、未知 writer、P0/P1、
无法证明 rollback、需要不可逆修改、真实业务规则不明、stable identity 不明、未授权范围扩大或 candidate 落后 Production，
优先 **STOP** 受影响操作并报告。

用户已确认的促销、商品、支付、Sweet Card、库存、调拨、工资、权限、退款等规则是项目约束，不得自行改变。
新需求与其冲突时明确指出，必要时只问一个最小业务问题；不要让用户参与不必要的技术细节决策。

## 19. 输出、交接与正式结案

重要任务结束用简洁结构化结果记录以下字段，不让过程日志淹没结论；未知值如实标记，不把临时 SHA、过期候选或失败中间态当长期事实：

```text
RESULT =
Production SHA =
runtime/business SHA =
Migration =
Writer =
DB =
Candidate / branch =
CI =
tests =
image/artifact =
rollback baseline =
P0/P1/P2 =
修改范围 =
Production 是否变化 =
剩余风险 =
下一步 =
```

Handoff 同时记录 remote、exact HEAD、upstream、working-tree changes、unpushed commits、已完成和剩余工作。
未提交或未推送内容不能通过远端 Git 恢复；未知本地改动保持原状并排除；生产证据保留核验时间和状态。

**PASS 不等于 COMPLETE**。只有功能与项目目标完成、测试通过、需要上线的已上线、生产验收通过且关键风险关闭，
才可宣布需要生产交付的项目 `COMPLETE / LIVE`；本地 PASS、CI PASS、candidate ready 不代表正式结案。
纯文档等无需部署的任务按其明确验收范围报告完成状态，不伪称生产验收，也不为结案额外部署。

只有项目真正达到 **COMPLETE 或 LIVE 且通过生产验收**，最终回复除 PASS / COMPLETE / LIVE 外，
必须附加固定结案暗号：**“灰太狼大王天下第一”**。
中间 Gate、候选测试、Preflight 或未通过生产验收时禁止使用该暗号作结案宣告。

## 20. 最终原则

**先确认事实 → 确认 Authority → 最小修改 → 真实测试 → exact SHA 发布 → 真实生产验收。**
各步骤限于当前授权范围；永远不要用猜测替代证据、方便替代权威、测试变绿替代系统正确。
