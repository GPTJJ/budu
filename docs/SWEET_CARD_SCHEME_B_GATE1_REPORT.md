# Sweet Card Scheme B — Gate 1 Implementation Report

> 实施人：WorkBuddy（小羊）｜日期：2026-09-19 11:29 +08:00
> 风险模式：**STRICT + SWEET_CARD + FRONTEND-FIRST + GIT**
> 目标：Sweet Card Admin UI Refactor，ZERO BUSINESS-LOGIC CHANGE

---

## 1. Base / Worktree / Branch

| 字段 | 值 |
|---|---|
| AUTHORITATIVE_BASE | `95cd9ce48b25de35570cc6f1f07154ab2e13cb78`（`codex/sweet-card-delivery-package`，生产） |
| IMPLEMENTATION_WORKTREE | `/Users/apple/Desktop/budu-workbuddy-sweet-card-ui-b-v2` |
| IMPLEMENTATION_BRANCH | `workbuddy/sweet-card-ui-b-v2` |
| BASE_SHA 校验 | `git rev-parse HEAD` = `95cd9ce48b25de35570cc6f1f07154ab2e13cb78`（精确一致） |
| GIT_STATUS（初始） | clean（0 改动） |

## 2. Skills / Rules Used

`budu-task-router`、`budu-context`、`budu-git-authority`、`budu-data-authority`、`budu-sweet-card`、`budu-mobile-ui`、`budu-brand-system`。根 `AGENTS.md`（Single Source of Truth、READ→VERIFY→…→REPORT、证据状态词）已重读。

## 3. Files Changed

| 文件 | 变更 | 说明 |
|---|---|---|
| `src/components/SweetCardPage.jsx` | M（+117/−62） | 信息架构 + 总览/批次/卡片/管理设置重构，接入向导与成功页 |
| `src/components/sweet-card/SweetCardCreateWizard.jsx` | A（新增 85 行） | 三步创建向导（纯前端 draft state） |
| `src/components/sweet-card/SweetCardSuccess.jsx` | A（新增 20 行） | 创建成功页 |
| `scripts/test-sweet-card-core.mjs` | M（1 行） | surface 断言 #28 对齐 Scheme B 导航 |

**未改任何**：`server/*`、`prisma/schema.prisma`、`prisma/migrations/*`、`shared/*`、`src/utils/*`、`SweetCardAvailability.jsx`、`SweetCardDelivery.jsx`、`sweetCardLabels.js`、`sweetCardDelivery.js`。

## 4. Navigation Changes

- 原 8 tab（总览/批次/卡片/发卡/规则/设置/使用记录/审计）→ **4 个一级导航（总览/批次/卡片/创建并发卡） + 1 个低频「管理设置」入口（分隔线右侧、齿轮图标）**。
- 「发卡」改名「创建并发卡」。
- 「使用记录」降为总览二级入口（见 §12）；「审计」「规则」「设置」并入「管理设置」（见 §11）。
- **Route 兼容**：SweetCardPage 无 URL 路由（内部 tab state），本次只改导航入口、未改任何 route/URL，无 404/deep-link/bookmark 破坏。

## 5. Overview Changes

- 核心 KPI 重排：**剩余余额突出**（大卡 + budu 粉），总发行额度/已消费额度/已激活/未激活并列展示。
- 快捷操作区：**创建并发卡**（primary）/ **使用记录·Ledger** / **下载 QR 包**（后两者进入批次选择/使用记录二级页，未造全局下载语义）。
- 「更多统计」折叠：已创建/已发放/已用尽/已冻结/已挂失/已过期（保留，降级为次级）。
- 运营视图切换（商业运营/测试验收/已归档）保留。

## 6. Batch Changes

- 视觉优先级重排：批次名称、卡数量、总面额（totalInitialAmountCents）、QR 包突出；用途/载体/绑定/创建时间降为次级。
- 新增批次名称搜索（前端过滤，`/batches` 已返回全量，无 API 变更）。
- 归档/恢复移入「更多」菜单（低风险低频），保留原行为与 confirm。
- 批次指标（已激活/已消费/余额）保留。

## 7. Card Changes

- 新增 **Card View（默认） + Compact List View** 切换（顶部 segmented control，role=tablist）。
- Card View：状态 pill + 余额突出，面额/赠送对象/所属批次/载体/绑定为次级，**卡号保留但降为 mono 小字**。
- 激活/冻结/解冻 inline 保留；详情/Ledger 入口保留；危险操作（作废/挂失/补发）仍在详情内。
- 搜索/筛选（批次/状态/面额）保留，新增「所属批次名」映射（由 `data.batches` 反查，无 API 变更）。

## 8. Create Wizard Changes

三步向导（纯前端）：

- **Step 1 基本信息**：批次名称、数量（1–500 stepper/输入）、面额（¥500/¥1000 preset + 自定义）、有效期（1年/3年/长期）、赠送对象（label/type/company）。
- **Step 2 发卡设置**：祝福语（recipientNote）、载体、绑定模式、批次用途、用途说明、赠送场景、电子卡立即激活。
- **Step 3 确认并发卡**：摘要（批次名/数量/单卡面额/总发行额度[display-only]/有效期/赠送对象/祝福语/绑定/载体/用途）+ CTA。

**约束落实**：前两步仅维护前端 `form` draft state，点击「下一步」不调用任何 API；真实创建只在 Step 3 明确点击「创建并发卡」后调用一次 `POST /v2/sweet-cards/batches`；`saving` 状态禁用按钮防 double submit；step back / route change 不触发提交；API 失败不进入成功态。

## 9. Recipient / Greeting Preservation

- 赠送对象：`recipientType / recipientLabel / recipientCompany`（向导 Step1 + 详情赠送信息 + 卡片列表 + 电子卡卡面）。
- 祝福语：`recipientNote`（向导 Step2「祝福语」+ 详情「祝福语 / campaign 文案」+ 发放摘要）。
- **未新增任何字段**，未引入 greeting/blessing/message 等第二套持久化字段，提交仍映射回 `recipientNote`，字段语义与小程序卡面渲染不变。

## 10. Success Page

- 新增 `SweetCardSuccess`：查看批次 / 查看卡片（自动按新 batchId 过滤）/ 下载 QR 包（`/api/v2/sweet-cards/batches/{batchId}/export`）/ 继续发卡（重置 form）。
- 仅在 `POST /v2/sweet-cards/batches` 成功返回 `{ ok, batchId, cards, exportReady }` 后出现；复用真实返回的 `batchId`/`cards`，未猜测 route、未客户端拼数据模拟成功。

## 11. Management Settings

「管理设置」承载三个低频子区（segmented 切换）：

- **规则**：不可使用商品分类（`GET/PUT /sweet-cards/rules`），行为与权限不变。
- **设置**：门店可用性 `SweetCardAvailability`（沿用原组件，`MANAGE` capability 门控不变）。
- **审计日志**：安全审计事件（`GET /sweet-cards/audit`），展示与权限不变。

未把 卡片/批次/使用记录 塞进设置。

## 12. 使用记录 / Ledger Mapping

- 「使用记录」不再占一级 tab，**保留完整页面与能力**，入口下沉到 总览快捷操作「使用记录 / Ledger」→ 二级视图（带返回按钮，运营视图切换保留）。
- **语义未合并**：「使用记录」（`/sweet-cards/usage`，核销记录）与单卡「账务记录 Ledger」（`GET /cards/:id` 的 ledger）保持各自原业务含义，仅导航归位，未强行统一命名。

## 13. Audit Mapping

- 审计从一级 tab 下沉到 **管理设置 → 审计日志**，保留既有页面、route（无 route 概念，内部 tab）、权限（`AUDIT` capability 服务端门控不变）与行为。

## 14. Existing Capability Parity Matrix

| Capability | OLD 入口 | NEW 入口 | RESULT |
|---|---|---|---|
| 批次 | 批次 tab | 一级「批次」 | KEEP |
| 卡片 | 卡片 tab | 一级「卡片」 | KEEP |
| 赠送对象 | 发卡表单 + 详情 | 向导 Step1 + 详情 | RELOCATE（语义不变） |
| 祝福语 | 发卡「通用备注」+ 详情 | 向导 Step2 + 详情 | RELOCATE |
| 数量 | 发卡表单 | 向导 Step1 | RELOCATE |
| 面额 | 发卡预设+自定义 | 向导 Step1 preset+自定义 | RELOCATE |
| 有效期 | 发卡表单 | 向导 Step1 | RELOCATE |
| 批次用途 | 发卡表单 | 向导 Step2 | RELOCATE |
| 用途说明 | 发卡表单 | 向导 Step2 | RELOCATE |
| 绑定规则 | 发卡表单 | 向导 Step2 | RELOCATE |
| 载体类型 | 发卡表单 | 向导 Step2 | RELOCATE |
| 电子卡立即激活 | 发卡 checkbox | 向导 Step2 checkbox | RELOCATE |
| 赠送场景 | 发卡表单 | 向导 Step1 | RELOCATE |
| QR 包 | 批次链接 | 批次链接 + 总览快捷 + 成功页 | KEEP |
| Ledger | 详情账务记录 | 详情账务记录 | KEEP |
| 使用记录 | 使用记录 tab | 总览→二级视图 | RELOCATE |
| 审计 | 审计 tab | 管理设置→审计日志 | RELOCATE |
| 激活/未激活 | 卡片 + 总览 | 卡片 + 总览 KPI | KEEP |
| 冻结/解冻 | 卡片 | 卡片 | KEEP |
| 挂失/补发 | 详情 | 详情 | KEEP |
| 作废 | 详情危险操作 | 详情危险操作 | KEEP |
| 过期 | 总览 | 总览更多统计 | KEEP |
| 测试/验收 | 运营视图切换 | 运营视图切换 | KEEP |
| 归档 | 批次操作 | 批次「更多」菜单 | RELOCATE |
| 搜索 | 卡片搜索 | 卡片搜索 + 批次名称搜索（新增） | KEEP |
| 筛选 | 卡片批次/状态/面额 | 卡片批次/状态/面额 | KEEP |
| 权限控制 | 7 项 capability | 7 项 capability（不变） | KEEP |
| 详情入口 | 卡片详情 | 卡片详情 + List 行点击 | KEEP |
| 隐藏菜单/More Actions | details 折叠 | 「更多」菜单 + 详情危险操作 | VISUAL_REDESIGN |
| 规则（分类黑名单） | 规则 tab | 管理设置→规则 | RELOCATE |
| 设置（门店可用性） | 设置 tab | 管理设置→设置 | RELOCATE |
| 电子卡发放/领取凭证 | 详情 | 详情（不变） | KEEP |
| 卡面/赠送信息 | 详情 | 详情（不变） | KEEP |

**结论：DELETE = 0。所有能力 KEEP / RELOCATE / VISUAL_REDESIGN，无任何功能删除。**

## 15. API Contract Changes

**无。** 复用全部既有 endpoint，请求/响应/side effect 不变：
- `GET/POST /v2/sweet-cards/batches`、`GET /batches/:id/export`、`POST /batches/:id/archive|restore`
- `GET /v2/sweet-cards/cards`、`GET/PUT /cards/:id`、`POST /cards/:id/{activate,freeze,unfreeze,void,lost,replace,bind,activate-delivery,claim-presentation}`
- `GET/PUT /v2/sweet-cards/rules`、`GET /v2/sweet-cards/usage`、`GET /v2/sweet-cards/audit`、`GET /v2/sweet-cards/config`、`/v2/sweet-cards/availability/*`

三步向导仅重组前端提交时机，最终仍一次 `POST /batches` 传全量字段，payload 语义与 `parseYuanAmount` 服务端校验不变。

## 16. Backend / DB Changes

**无。** 未改 `server/*`、`prisma/schema.prisma`、migrations、服务端校验、Sweet Card service。

## 17. Mini Program Impact

**无。** 未改 `sweet-card-claim.js`、`sweet-card-presentation.js`、POS 核销链、`/api/v2/customer/sweet-card/*`、`recipientNote/campaignText` 渲染语义。方案 B 不要求小程序升级。

## 18. Tests / Regression

| 检查 | 结果 |
|---|---|
| `npm run build`（vite build） | **PASS**（SweetCardPage 61.43 kB，无 error） |
| `npm run test:sweet-card`（node --test 全量） | **PASS 90/90**（含更新后的 surface 断言 #28） |
| `node --test scripts/test-sweet-card-core.mjs` | **PASS 30/30** |
| `npm run test:ssr`（smoke-render） | 预存在 `window is not defined`（smoke-render 不渲染 SweetCardPage，与本改动无关） |

> 注：`test:sweet-card` 初跑 5 项失败，根因是本 worktree `npm ci --ignore-scripts` 未生成 Prisma client（`Named export 'PrismaClient' not found`），`npx prisma generate` 后全部通过；与代码无关。

## 19. Mobile / Overlay Regression

- 未新建任何 overlay 机制；卡片详情/电子卡交付沿用既有 `fixed inset-0` Bottom Sheet（保留 `safe-area-inset-bottom`）。
- 导航/运营视图/管理设置子区均 `overflow-x-auto` 可横向滚动，390px 不溢出。
- 向导为单列表单 + `min-h-12` 按钮，移动端点击面积达标；步骤指示 grid-cols-3 自适应。
- 未改动既有 TabBar / fixed button / keyboard 行为。

（受限：本环境无法起真实浏览器做像素级截图，移动端已按 `budu-mobile-ui` 规范做代码级核查。）

## 20. Historical Card Compatibility

- 未写任何生产数据、未创建/修改测试卡。
- 卡片/余额/状态/Ledger 渲染逻辑复用原 `formatCents` + `serializeCard` 数据，未改数据语义；历史卡展示字段不变（仅视觉重排）。

## 21. Forward Compatibility With 1.1B

- `git diff --stat 95cd9ce a91cb6d -- src/` → **空**（a91cb6d 不改 `src/`）。
- 本 Gate 全部改动均在 `src/`（前端）+ 1 个前端 surface 测试，与 a91cb6d 的 `server/online-*.js`、schema、migrations 零重叠。
- 结论：**CLEAN**（未来 cherry-pick / rebase 到 a91cb6d 无 frontend/route/component/API 冲突）。

## 22. Local Commits

- `55ae0a6` feat(sweet-card): add Scheme B 3-step create wizard and success page（2 新文件）
- `566f0e4` refactor(sweet-card): restructure admin UI to Scheme B lightweight navigation（SweetCardPage + 测试）
- **未 push / 未 deploy / 未 merge production**（遵守 Gate 1 禁令）。

## 23. Risks / Remaining Issues

| ID | 说明 |
|---|---|
| R-1 | 浏览器像素级视觉/移动端截图验证未做（本环境无浏览器）；建议 Orchestrator 在有浏览器的环境做 390px / iPhone 视口人工核验。 |
| R-2 | 总览「下载 QR 包」快捷入口进入批次页（不造全局下载语义），符合约束；如需更直接需 Orchestrator 明确。 |
| R-3 | `npm run test:ssr` 在本 checkout 预存在 `window is not defined` 失败（与 Sweet Card 无关，smoke-render 不覆盖 SweetCardPage）。 |
| R-4 | 批次「更多」菜单用 `<details>` 下拉，点外部不自动收起（轻量，可后续改受控 popover，不影响功能）。 |

## 24. Screenshots / Visual Evidence

本环境无法起真实浏览器渲染截图。视觉以代码级实现 + build 产物（`dist/assets/SweetCardPage-*.js`）为准。建议在有浏览器的环境对以下页面补截图证据：总览、批次、卡片（Card/List）、创建向导三步、成功页、管理设置（规则/设置/审计）、使用记录二级页、单卡详情。

## 25. Final Gate Result

**`PASS`**

- Scheme B 主要 UI 已完成（导航/总览/批次/卡片/三步向导/成功页/管理设置）。
- Existing Capability parity 通过（DELETE=0）。
- 赠送对象 / 祝福语 / 使用记录 / 审计 / QR 包 / Ledger 全部保留。
- 三步向导仅前端，原创建 API 仍是唯一提交入口。
- 无 backend/db/migration 改动，无小程序 contract 改动，历史卡行为未改变。
- regression 通过（build + sweet-card 90/90）。
- 无重大 1.1B forward-port conflict（CLEAN）。

### 强制声明

| 项 | 值 |
|---|---|
| API_CONTRACT_CHANGED | **NO** |
| BACKEND_CHANGED | **NO** |
| DATABASE_CHANGED | **NO** |
| MIGRATION_ADDED | **NO** |
| LEDGER_LOGIC_CHANGED | **NO** |
| BALANCE_LOGIC_CHANGED | **NO** |
| MINIPROGRAM_CONTRACT_CHANGED | **NO** |
| HISTORICAL_CARD_BEHAVIOR_CHANGED | **NO** |

**STOP。** 未 push、未 deploy、未 merge production。等待 Orchestrator Review。
