# Sweet Card Scheme B — Gate 1.1 Report

> 实施人：WorkBuddy（小羊）｜日期：2026-09-19 12:08 +08:00
> 风险模式：**STRICT + SWEET_CARD + FRONTEND-FIRST + GIT**
> 性质：Product Parity Correction + Pre-Review Hardening（不扩大功能范围，不改 backend/db/API/core）

---

## 1. Shortcut Specification Reconciliation

已确认产品需求为 4 个快捷操作：**创建批次 / 新建发卡 / 查看 Ledger / 下载 QR 包**。

Gate 1 实现曾写为「创建并发卡 / 使用记录 / 下载 QR 包」（3 项，且把「查看 Ledger」误并入「使用记录」）。本轮依据真实代码修正如下：

| 规格项 | 真实代码事实 | 修正后入口 |
|---|---|---|
| 创建批次 | **无独立能力**（`POST /v2/sweet-cards/batches` 原子创建批次+卡片，见 §2） | 并入「创建并发卡」 |
| 新建发卡 | 与「创建批次」为同一原子操作（三步向导目标） | 「创建并发卡」（统一命名） |
| 查看 Ledger | 单卡账务流水（`SweetCardLedger`），与「使用记录」语义不同（见 §3） | 独立快捷入口「查看 Ledger」→ 卡片详情 |
| 下载 QR 包 | `GET /v2/sweet-cards/batches/:id/export`（需先选批次） | 独立快捷入口「下载 QR 包」→ 批次页 |
| 使用记录 | 全量核销记录（`SweetCardRedemption`），非 Ledger | 二级入口（保留，Gate 1 既定方案） |

**修正动作**：原「使用记录 / Ledger」合并入口拆分为「查看 Ledger」与「使用记录」两个独立入口。

## 2. Create Batch vs Create/Issue Mapping

基于真实代码（`server/sweet-card.js`）：

- 唯一创建端点：`POST /v2/sweet-cards/batches`（line 447），单事务内依次创建：
  1. `SweetCardBatch`（批次）
  2. N × `SweetCardAccount`（卡片）
  3. N × `SweetCardCredential`（使用凭证）
  4. N × `SweetCardLedger`（type=ISSUE，balanceAfterCents=faceValue）
- 无「仅创建批次」的独立端点；无「单张补发」独立端点（count=1 即单张）。

**结论**：A.「创建批次」不存在独立既有能力；B.「新建发卡/创建并发卡」与「创建批次」是**同一原子操作**，不可拆分；因此统一命名为「创建并发卡」，未吞掉任何独立能力（因该能力本就不独立）。

## 3. Ledger vs 使用记录 Semantic Comparison

| 维度 | 使用记录（usage） | Ledger（账务记录） |
|---|---|---|
| 数据模型 | `SweetCardRedemption`（核销记录） | `SweetCardLedger`（账务流水） |
| 读取端点 | `GET /v2/sweet-cards/usage` | `GET /v2/sweet-cards/cards/:id` → `ledger` |
| 事件类型 | 仅核销（REDEEM），带 orderNo/storeId | ISSUE/REDEEM/REFUND/REVERSAL 全类型 |
| 关键字段 | redemptionNo/orderNo/amountCents/eligible/ineligible/redeemedByName | type/amountCents/**balanceAfterCents**/orderId/redemptionId/refundId/requestKey |
| 粒度 | 全局核销列表 | 单卡账务流水（含余额轨迹） |

**结论**：两者**非完全等价**（不同模型、不同事件类型、不同粒度）。故不得合并，总览分别提供「查看 Ledger」（→ 卡片详情账务流水）与「使用记录」（二级入口）。

## 4. Feature Parity Recheck

| Capability | OLD ENTRY | NEW ENTRY | TARGET ROUTE / HANDLER | SEMANTICALLY SAME? | RESULT |
|---|---|---|---|---|---|
| 创建批次 | 发卡 tab「创建甜意卡批次」 | 一级导航/总览「创建并发卡」三步向导 | `POST /v2/sweet-cards/batches` | 是（同一原子操作） | KEEP（统一命名） |
| 创建并发卡 | 发卡 tab 单表单 | 一级导航「创建并发卡」三步向导 | `POST /v2/sweet-cards/batches` | 是（最终仍单次提交） | KEEP |
| Ledger | 卡片详情「账务记录」 | 总览快捷「查看 Ledger」→ 卡片详情「账务记录」 | `GET /v2/sweet-cards/cards/:id` | 是 | KEEP |
| 使用记录 | 使用记录 tab | 总览快捷「使用记录」二级视图 | `GET /v2/sweet-cards/usage` | 是 | RELOCATE |
| QR 包 | 批次「QR 包」链接 | 批次「QR 包」+ 总览快捷「下载 QR 包」+ 成功页 | `GET /v2/sweet-cards/batches/:id/export` | 是 | KEEP |
| 赠送对象 | 发卡表单 + 详情赠送信息 | 向导 Step1 + 详情赠送信息 | `POST /batches` + `PUT /cards/:id/presentation` | 是 | RELOCATE |
| 祝福语 | 发卡「通用备注」+ 详情「祝福语」 | 向导 Step2 + 详情「祝福语」 | `recipientNote`（`POST /batches` + `PUT presentation`） | 是 | RELOCATE |

**DELETE = 0，无功能丢失。**

## 5. Test Assertion Integrity Review

审计对象：`scripts/test-sweet-card-core.mjs` 的 #28 surface 断言（Gate 1 修改）。

| 断言 | OLD（Gate 0 基线） | NEW（Gate 1） | 判定 |
|---|---|---|---|
| 使用记录存在 | `assert.match(ui, /\['usage', '使用记录'\]/)` | `assert.match(ui, /使用记录/)` | 对齐（usage 由 tab 降为二级视图，仍断言存在） |
| ¥500 预设 | `assert.match(ui, /¥500/)` | `assert.match(wizard, /¥500/)` | 对齐（预设移至三步向导文件） |
| ¥1000 预设 | `assert.match(ui, /¥1000/)` | `assert.match(wizard, /¥1000/)` | 对齐（同上） |
| 按批次筛选 | `assert.match(ui, /按批次筛选/)` | `assert.match(ui, /按批次筛选/)` | 不变 |
| Credential 详情 | `assert.match(ui, /Credential/)` | `assert.match(ui, /Credential/)` | 不变 |

**结论**：修改属于「让 surface assertion 对齐新版合法导航结构」。**未删除任何能力断言、未降低 feature 覆盖（5 项断言全保留）、未绕过失败**。唯一变化是「usage 是否在 tabs 数组」这一**结构断言**随导航下沉而改为「使用记录文本存在」——这是 Scheme B 已批准的导航变更的必然结果，非弱化。

## 6. Files Changed

本轮（Gate 1.1）仅 1 个文件：

- `src/components/SweetCardPage.jsx`：总览快捷操作由 3 项修正为 4 项（创建并发卡 / 查看 Ledger / 下载 QR 包 / 使用记录），并补充说明文案；导入 `BookOpen` 图标。

未改 `server/*`、`prisma/*`、`shared/*`、测试文件。

## 7. Build / Test Results

| 检查 | 结果 |
|---|---|
| `npm run build` | **PASS**（SweetCardPage 62.30 kB，无 error） |
| `npm run test:sweet-card` | **PASS 90/90**（测试数量未减少，与 Gate 1 一致） |

## 8. Manual Visual QA Checklist

> 本环境无浏览器，不伪造截图。以下为人工核验清单，供有浏览器的环境逐项打勾。

**Viewports**：iPhone small（320 / 375px）、iPhone Pro/Max（390 / 430px）、desktop narrow / mobile web（768px 平板 + ≥1024px 桌面）。

**逐页检查（每页覆盖：safe area / 横向溢出 / 滚动 / 底部导航遮挡 / keyboard / fixed CTA / modal / 长文本 / 大金额 / 空态 / loading / error）**：

| 页面 | 关键检查点 |
|---|---|
| 总览 | 剩余余额大卡不溢出；快捷操作 4 按钮在 320px 换行为 1 列；「更多统计」折叠正常；运营视图切换可横向滚动 |
| 批次 | 名称搜索框不遮挡；批次卡「总面额」右对齐不换行挤压；「更多」菜单不裁切；QR 包按钮可点 |
| 卡片 Card View | 状态 pill + 余额不重叠；长卡号 mono 换行/截断；赠送对象长文本截断；激活/冻结按钮不拥挤 |
| 卡片 List View | 行点击进详情；列表行余额右对齐；长批次名截断 |
| 创建 Step 1 | 面额 preset + 自定义输入键盘（iOS 数字键盘）；数量 stepper/输入；长批次名称 |
| 创建 Step 2 | 载体切换后「立即激活」显示/隐藏；祝福语长文本；绑定模式下拉 |
| 创建 Step 3 | 摘要长文本换行；总发行额度 display-only 大数；CTA 不被键盘遮挡 |
| 成功页 | 4 个动作按钮；下载 QR 包链接；继续发卡重置 |
| 管理设置 | 子 tab（规则/设置/审计）切换；设置页门店开关；审计长事件列表滚动 |
| 使用记录 | 二级视图返回按钮；核销列表长卡号/大金额；运营视图切换 |
| 审计 | 长 action 文本；时间戳；空态 |

**专项检查**：safe-area-inset-bottom（详情 Bottom Sheet）、长 recipient（>120 字截断）、长 greeting（>300 字）、大金额（¥100000 上限）、大批次数量（500）、空态（无批次/无卡/无记录）、loading 文案、error 提示（top rose 条）。

## 9. VISUAL_QA Status

**`VISUAL_QA_PENDING`**（本环境无浏览器，不声称 VISUAL_PASS；build + 单测通过，但像素级/移动端视觉需有浏览器环境人工核验）。

## 10. Local Commits

- `55ae0a6` feat(sweet-card): add Scheme B 3-step create wizard and success page
- `566f0e4` refactor(sweet-card): restructure admin UI to Scheme B lightweight navigation
- `010dcbe` fix(sweet-card): correct overview quick actions per product spec（本轮）

**未 squash 原历史、未 push、未 deploy、未 merge production。**

## 11. Remaining Risks

| ID | 说明 |
|---|---|
| R-1 | 视觉验证缺失：本环境无浏览器，VISUAL_QA_PENDING，需有浏览器环境做 §8 清单人工核验。 |
| R-2 | 「查看 Ledger」无全局 Ledger 列表端点（Ledger 仅单卡级），快捷入口落到卡片详情账务流水——若产品后续要求全局 Ledger 列表，需新增 API（本轮禁止，未做）。 |
| R-3 | 「创建批次」与「新建发卡」在代码中为同一原子操作，统一为「创建并发卡」；若产品坚持两个独立文案入口，需 Orchestrator 明确（两者会指向同一向导）。 |
| R-4 | 批次「更多」菜单用 `<details>` 下拉，点外部不自动收起（轻量，不影响功能）。 |

## 12. Final Result

**`PASS_FOR_VISUAL_QA`**

- 快捷操作已按产品规格修正（4 项，真实代码映射）。
- 「创建批次=新建发卡=创建并发卡」单一原子操作已确认并统一命名，未吞掉独立能力（本无独立能力）。
- 「使用记录 ≠ Ledger」已确认并拆分，不再合并。
- Feature Parity Recheck 通过（DELETE=0）。
- 测试断言为「对齐」非「弱化」，5 项能力断言全保留。
- build PASS + test:sweet-card 90/90。
- VISUAL_QA_PENDING（无浏览器证据，未声称 VISUAL_PASS）。

**STOP。** 未 push / 未 deploy / 未 merge production。等待 Orchestrator Review 与视觉核验。
