# Sweet Card Scheme B — Gate 1.3 Final UI / Business Rule Alignment Report

- **Worktree**: `/Users/apple/Desktop/budu-workbuddy-sweet-card-ui-b-v2`
- **Branch**: `workbuddy/sweet-card-ui-b-v2`
- **Base**: `95cd9ce48b25de35570cc6f1f07154ab2e13cb78`（生产 delivery-package）
- **HEAD**: `见 §14 Local Commits`（本轮 3 个 commit）
- **环境**: 本地 PG 5433（`/tmp/budu-sc-pgdata`）· API localhost:3000 · Vite localhost:5173 · 生产零接触
- **TABBAR_OVERLAP = CLOSED / NOT_A_BUG**（用户真机确认滚动正常；本轮未触碰任何 padding/overlay/safe-area 机制）

---

## 1. Worktree / Base / HEAD

- 上述 worktree / base 不变；本轮新增 commits：`d4f782a`、`4727cd8`、`<report commit>`。
- 工作树干净（仅 docs 报告与截图入库）。

## 2. Business Rule Alignment

正式规则已按指令对齐并**核实代码与之一致**：

- **黑名单机制**：`server/sweet-card-core.js` 按 `SweetCardCategoryPolicy.blocked` 排除商品（test #27 断言 blacklist cap 逻辑仍在）。
- **未 blocked 的常规 POS 分类 → 默认可用**：规则 GET/PUT 全量回传分类、blocked 只存显式标记（`server/sweet-card.js:756-779`）。
- **不采用逐商品白名单**：无任何 per-product sweet-card 资格表；唯一资格判定在服务端结算内。
- 本轮**未修改**任何 blocked 语义 / API contract / 结算逻辑。

## 3. ProductCategory Authority

- 唯一权威 = `ProductCategory` 表，由**产品中心**维护（`POST/PUT /api/v2/product-categories`，`server/v2.js:748-771`，前端 `ProductCenterPage.jsx`）。
- Sweet Card 模块只读写 `sweet_card_category_policies.blocked`，**无第二套分类、无前端 hardcode、无 client-side 资格权威**。
- 本地 QA 分类全部通过产品中心 API 创建（见 §5），非 hardcode。

## 4. Current Production Blocked Rule Reference

- 生产 blocked = `pos-森醒`、`pos-12样商店` —— 仅作为**核对参考**记录于此。
- **未出现在任何代码 / 常量 / fixture 中**（`git grep "pos-森醒\|12样"` → 零命中）。
- 本地 QA 用等价 demo 分类 `pos-演示样商店` 验证 checked 渲染，与生产值无关。

## 5. Local Rule QA Result

| 步骤 | 手段 | 结果 |
|---|---|---|
| 创建 4 个分类 | 既有产品中心 API `POST /api/v2/product-categories` | 太妃糖 / 冰淇淋 / 巧克力 / pos-演示样商店 |
| 标记 blocked | 既有规则 API `PUT /v2/sweet-cards/rules {blockedCategoryIds}` | pos-演示样商店 blocked=true |
| 页面渲染 | 浏览器实测 | 3 unchecked + 1 checked（截图 `F-rules-with-data.png`） |
| Empty state | 纯前端文案 | `categories.length === 0` → 「当前暂无商品分类…」（`docs/qa-evidence` 时序：先验证空库渲染逻辑，后建分类；另新增 surface 断言 #30a 固化） |

未隐藏保存逻辑、未假造分类、未推断生产为空。

## 6. Store Authority / 4-Store QA Result

| 步骤 | 手段 | 结果 |
|---|---|---|
| 确认目标库 | `SELECT current_database(), inet_server_port()` | `postgres@5433` = 本机 /tmp 实例，100% 本地 QA |
| dry-run | `node scripts/store-backfill.mjs --db /tmp/budu-sc-empty-kv.json --dry-run` | `CREATE:1 SKIP:3 RETIRE:0` |
| apply | 同上去掉 --dry-run | `CREATE:1（chaowai）UPDATE:3 RETIRE:0 ERROR:0` |
| 经营类型 | `chaowai.operationType UNKNOWN→DIRECT`，与 `scripts/initialize-sweet-card-store-authority.mjs` 的分类操作完全一致（该脚本断言库名限生产，本地不可跑，故单字段复刻其既有机制；依据 = 指令确认的权威 4 直营） | 4/4 DIRECT |
| 启用 | **既有 availability API** `PUT /v2/sweet-cards/availability/all-direct` | 4 家全部 enabled=true |
| 页面 | 浏览器实测 | 「直营门店：4 家 / 甜意卡已启用：4 家」，朝外店已启用（截图 `G-stores.png`） |

未手写 prisma.store.create、未改 FIXED_STORES、未连生产。

## 7. Mobile Navigation Fix

- 管理设置按钮：`<Settings2/>` 保留，文字 `<span className="hidden sm:inline">管理设置</span>` + `aria-label`。
- 390px 视口实测：4 核心 Tab 等权 + 分隔线 + **icon-only 管理设置**紧凑入口（截图 `E-mobile-manage-entry.png`）；sm+ 恢复完整文字。
- route / permission 零改动。

## 8. Step 1 Refinement

- 保留：批次名称 / 数量 / 面额（+¥500·¥1000 预设）/ 有效期 / 赠送对象。
- 移出：赠送对象类型 / 公司 / 赠送场景 —— 服务端 `safeText()` 纯可选（`server/sweet-card.js:485-487`），**OPTIONAL 确认后仅移动 UI 位置**。
- payload / 字段语义 / API 零改动（截图 `B-mobile-step1.png`）。

## 9. Step 2 Recipient / Greeting Preservation

- Step 2 新增「赠送信息」分组承载上述 3 字段；「祝福语」（`recipientNote`）位置不变仍在 Step 2 首位。
- 字段提交仍映射原权威字段，无新增持久化字段（截图 `C-mobile-step2.png`）。

## 10. Step 3 Responsive Fix

- 根容器 `flex-wrap items-center gap-3`；上一步按钮 `shrink-0 whitespace-nowrap`。
- 390px 实测：「← 上一步」水平完整显示，CTA 换行为全宽主按钮（截图 `D-mobile-step3.png`）；汇总信息不变；提交仍为单次 `POST /v2/sweet-cards/batches`。

## 11. Overview KPI Refinement

- 主卡仅「剩余余额」+ 弱化提示「总发行额度、已消费额度见下方统计」；4 KPI（已激活/未激活/总发行额度/已消费额度）不变，`consumed` 计算零改动（截图 `A-mobile-overview.png`）。

## 12. Feature Parity Matrix（最终复核）

| 能力 | 入口 | 状态 |
|---|---|---|
| 创建批次 / 创建并发卡 | 总览快捷 + 一级导航（同一原子 API） | ✓ |
| 批次 / 归档 / QR 包 | 批次 Tab（归档在「更多」菜单） | ✓ |
| 卡片 / Card+List 视图 / 详情 / Ledger | 卡片 Tab + 详情 Modal | ✓ |
| 激活 / 冻结 / 解冻 / 挂失 / 补发 / 作废 | 卡片 & 详情 | ✓ |
| 使用记录 | 总览二级入口 | ✓ |
| 规则 | 管理设置→规则（含新空态） | ✓ |
| 设置 / 使用门店 | 管理设置→设置（`SweetCardAvailability.jsx` 本轮 diff 为空） | ✓ |
| 审计日志 | 管理设置→审计日志 | ✓ |
| 赠送对象 / 祝福语 / 绑定规则 / 载体 / 有效期 | 向导 Step1/2 + 详情编辑 | ✓ |
| 测试/验收 scope | VIEW_SCOPES（商业运营/测试验收/已归档） | ✓ |
| 权限控制 | `SWEET_CARD_CAPABILITIES` 各入口 gate 未动 | ✓ |

## 13. Build / Test Result

- `npm run build`：**PASS**（✓ built in 6.9s）
- `npm run test:sweet-card`：**91/91 PASS**（90 → 91：新增 #30a surface 断言固化本轮 5 处 UI 修改，coverage 只增不减）

## 14. Files Changed / Local Commits

| Commit | 内容 |
|---|---|
| `d4f782a` | fix: 移动端修复 + 空态（部分） |
| `4727cd8` | fix: 补齐因同文件并发编辑覆盖丢失的 4 处修改（过程性 commit，内容已全量核对） |
| 本报告 commit | docs 报告 + qa-evidence 截图 + 测试断言 |

改动源码文件仅 2 个：`src/components/SweetCardPage.jsx`、`src/components/sweet-card/SweetCardCreateWizard.jsx`（+ 测试 1 个）。

## 15. Backend / DB / API Impact

无。所有数据操作走既有 API / 既有权威脚本；无 schema / migration / 结算改动。

## 16. Mini Program Impact

无。本轮 diff 不含任何 `customer/sweet-card`、claim、presentation、POS 核销路径。

## 17. Screenshots / QA Evidence

`docs/qa-evidence/`：A-mobile-overview / B-mobile-step1 / C-mobile-step2 / D-mobile-step3 / E-mobile-manage-entry / F-rules-with-data / G-stores（390×844 headless Chromium，budu/Budu2025 本地登录实测）。
F-empty-state 由 surface 断言 #30a 固化（截图时分类已建，无法同屏两态）。

## 18. Remaining Risks

1. F-empty-state 无独立截图（断言级验证）。
2. `store-backfill.mjs` 的 `--db` 缺省参数 bug（`args.indexOf('--db')===-1` 未保护）仍存在——本轮用显式 `--db` 绕过，建议 Codex review 时顺手修（1 行）。
3. Step1 的「赠送对象」仍为单值输入，批量场景统一赠送对象语义与现状一致（未扩大能力）。

## 19. Final Result

**`PASS_FOR_CODEX_REVIEW`**

强制声明：

```
API_CONTRACT_CHANGED:              NO
BACKEND_CHANGED:                   NO
DATABASE_SCHEMA_CHANGED:           NO
PRODUCTION_DATA_CHANGED:           NO
MIGRATION_ADDED:                   NO
LEDGER_LOGIC_CHANGED:              NO
BALANCE_LOGIC_CHANGED:             NO
MINIPROGRAM_CONTRACT_CHANGED:      NO
HISTORICAL_CARD_BEHAVIOR_CHANGED:  NO
```

全部 NO。Scheme B 实施封板，等待 Codex Final Engineering Review；未 push / 未 deploy / 未 merge。
