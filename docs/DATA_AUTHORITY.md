# BUDU Data Authority — 权威文档（living document）

> 项目：BUDU Data Authority 1.0
> 最终目标（DA-7 达成时）：**PostgreSQL 是唯一业务数据权威**；KV/JSON 仅承担缓存 / Session / 限流 / 临时状态 / 迁移工具 / 测试数据。
> 本文件随 Gate 推进持续更新；任何 Authority 判断必须区分 **Production** 与 **Development**。

---

## 1. 当前状态

| Gate | 状态 | 日期 | 证据 |
|---|---|---|---|
| DA-0 Production Data Authority Audit | ✅ PASS | 2026-08-24 | 《BUDU Data Authority 1.0 — DA-0 Audit Report》（只读；生产对账：Staff 12/12/12 全等、DailyEntry PG 92⊇KV 65、Users KV16 vs PG 遗留 3） |
| DA-1 Existing PostgreSQL Authority Freeze | ✅ PASS | 2026-08-24 | 本文档 + `scripts/test-data-authority-freeze.mjs`（4 静态 + 1 DB 冒烟 = 5/5 通过） |
| DA-2 Identity Authority | ⏸ 未开始 | — | 等待批准 |
| DA-3 Schedule Authority | ⏸ 未开始 | — | 等待批准 |
| DA-4 DailyEntry Authority | ⏸ 未开始 | — | 等待批准 |
| DA-5 Legacy Runtime Decoupling | ⏸ 未开始 | — | — |
| DA-6 Failure Acceptance | ⏸ 未开始 | — | — |
| DA-7 Production Authority Declaration | ⏸ 未开始 | — | — |

基线：Production SHA = Development SHA = `4abc3f9`（V2.20）。生产 `DATA_STORE=file`（KV = db.json），PG 63 表 / 33 迁移。

---

## 2. DA-1 冻结矩阵（Frozen Domains）

以下域已确认 **READ=PostgreSQL / WRITE=PostgreSQL / Fallback=NONE / 无业务数据 KV 依赖**，正式冻结：

| Domain | PG 表/模型 | 服务端路由 | 冻结依据 |
|---|---|---|---|
| Employee Profile（档案/银行卡/合同/审计） | employees + employee_* 子表 | server/employee-profile.js | 纯 PG；无 loadDb/persist |
| DailyEntry + DailyStoreStaff（业绩/值班） | DailyEntry / daily_store_staff / 审计表 | server/daily-entry-upgrade.js, v2.js | 纯 PG（前端读缓存由 PG 合并覆盖） |
| Daily Pay Adjustment（日薪调整） | daily_pay_adjustments | server/v2.js | 纯 PG；KV 镜像为陈旧冗余（0 行） |
| Payroll Notice（工资条） | payroll_notices | server/payroll-notice.js | 纯 PG |
| POS Product（商品） | InventoryItem | server/products.js, v2.js | 纯 PG；KV products 无调用方（0 行） |
| POS Order / OrderItem | orders / order_items | server/pos.js | 纯 PG |
| Payment / PaymentLog / Refund / 对账 | payments / payment_logs / refunds / refund_items | server/pos.js, payments/* | 纯 PG |
| Inventory（库存） | InventoryItem / StockBalance / StockLedger | server/v2.js | 纯 PG；KV inventory 冗余（0 行） |
| Transfer / Purchase Request | TransferRequest/Item, PurchaseRequest/Item | server/v2.js | 纯 PG；KV inventoryRequests 镜像（14 行，状态一致，仅缓存） |
| Supplier | Supplier | server/v2.js | 纯 PG（空表） |
| Approval 全套（模板/单据/节点/CC/附件/评论/日志） | approval_* | server/approvals.js | 业务纯 PG；KV 仅账号目录（cc 名单，users） |
| Notification（模板/消息/投递） | notification_* | server/notification-center.js, notifications.js | 业务纯 PG；KV 仅 listUsernames（users） |
| Invoice / InvoiceCompany | Invoice / InvoiceCompany | server/v2.js, ocr.js | 纯 PG |
| Mailing Record | MailingRecord | server/v2.js | 纯 PG |
| Asset Center（文件/版本/提醒/授权） | asset_* | server/asset-center.js, asset-reminders.js | 业务纯 PG；KV 仅 grants 账号目录（users） |
| Big Order Bonus（大单奖） | BigOrderBonus | server/v2.js | 纯 PG；KV 镜像陈旧（0 vs 1 行） |
| WeChat Binding | wechat_bindings + 审计 | server/wechat-bind.js | 业务纯 PG；KV 仅系统账号查找（users） |
| Expense / Waste / Member / AlertLog | 对应空表 | v2.js（休眠） | 冻结为空域，随 DA-5 归档 |

**冻结含义**：不重新迁移；禁止在上述域重新引入 KV/JSON 业务权威（由 `scripts/test-data-authority-freeze.mjs` 持续守卫）。PG 失败时明确报错（无 silent fallback）。

---

## 3. Legacy / 待迁移域（后续 Gate 处理）

| Domain | 当前权威 | 处理 Gate |
|---|---|---|
| User / Account / Role / Permission / Binding | KV（db.json users，16 账号；登录/鉴权/权限全部运行时读 KV） | DA-2 |
| Staff（员工名单） | KV（前端名单权威）+ PG Staff 镜像 + PG employees（三源，AMBIGUOUS） | DA-2 |
| Store（门店目录） | STATIC BASE_STORES + KV custom + PG Store（碎片化） | DA-2 |
| Schedule（排班） | KV schedules（4 周）；**PG 无表** | DA-3 |
| DailyEntry 写入端 | KV 先写 + PG 后写（dual write）；读 PG 优先、PG 空回退 KV | DA-4 |
| Analysis（报表上传） | KV analysis（生产空置） | DA-5 归档 |
| Product Images | KV productImages（13 条 dataURL） | DA-5 |
| removedStaff | KV 专属概念 | DA-2 并入员工状态 |
| 前端共享缓存 | localStorage mirror（KV 失败时静默回退） | DA-5 移除回退 |

---

## 4. 已知危险模式（关闭计划）

| 模式 | 位置 | 关闭 Gate |
|---|---|---|
| 静默回退：KV /userdata 失败 → localStorage 旧镜像当业务数据 | src/utils/userData.js:126 | DA-5 |
| 静默回退：PG 空 → KV entries 继续展示 | src/utils/userData.js:150 | DA-4 |
| 双写：commitEntries KV 先 → PG 后（partial success 无对账） | src/utils/userData.js:339 | DA-4 |
| 双写：commitStaff KV 先 → PG 镜像后 | src/utils/userData.js:392 | DA-2 |
| 姓名身份：staffKey=`storeKey::name`、employeeName、staffNameSnapshot、排班 staff 字符串 | 全链路 | DA-2 |
| PG User 遗留 3 行（孤儿） | User 表 | DA-2 |
| PG Store 垃圾键（s1 / store-msivyq41 / custom-*） | Store 表 | DA-2 |
| 死代码：legacy /api/inventory/requests/*、commitProducts/commitInventoryRequests/commitInventoryState | app.js / userData.js | DA-5 |
| KV 陈旧镜像：bigBonuses(0)/dailyPayAdjustments(0)/inventoryRequests(14)/inventory(0)/posDaily(0)/posProductSales(0) | db.json | DA-5 |

---

## 5. 证据链（Evidence Chain）

- **DA-1 PASS 证据**：`scripts/test-data-authority-freeze.mjs` 5/5 通过（含本地 PG 冒烟：36 张冻结域表全部存在）；Git SHA 见本文件变更提交；生产 0 变更（DA-1 不触碰生产）。
- 对账基线（DA-0）：Staff MATCH 12/12/12；DailyEntry PG 92 ⊇ KV 65（PG_ONLY 27 / KV_ONLY 0）；TransferRequest 14/14 MATCH；Users KV 16 vs PG 遗留 3（MISMATCH，DA-2 处理）；Stores UNMAPPABLE（DA-2 处理）。

---

## 6. 最终验收标准（DA-7）

1. 所有正式业务域唯一 Authority；2. 业务数据全部 PG 权威；3. KV Down 不影响核心业务；4. JSON Down 不影响核心业务；5. PG Down 明确失败；6. 无 silent legacy fallback；7. 无 dual authority；8. 业务身份用稳定 ID；9. 本文档与代码一致；10. 生产完成真实 cutover 验收。
