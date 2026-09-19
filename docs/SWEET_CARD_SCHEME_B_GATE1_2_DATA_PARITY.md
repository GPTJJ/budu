# Sweet Card Gate 1.2 — Data Parity Report

- **Gate**: 1.2（READ ONLY FIRST，本轮未修改任何数据/代码）
- **Worktree**: `/Users/apple/Desktop/budu-workbuddy-sweet-card-ui-b-v2`
- **Branch / HEAD**: `workbuddy/sweet-card-ui-b-v2` @ `010dcbeb13472c487c64c0209183cc575f6321cd`
- **Base**: `95cd9ce48b25de35570cc6f1f07154ab2e13cb78`
- **本地环境**: PG `/tmp/budu-sc-pgdata` @ 5433 · API localhost:3000 · Vite localhost:5173（本轮因 vite 进程 37 分钟后被杀，已重启，现 HTTP 200）
- **生产**: 本轮**未连接、未读取、未写入**（Gate 显式禁止）

---

## 1. Rules Data Source（规则页数据真实来源）

| 层 | 位置 | 说明 |
|---|---|---|
| Frontend 组件 | `src/components/SweetCardPage.jsx`（`manageSection === 'rules'` 块） | 仅渲染 `data.rules.categories`；勾选调 `toggleRule('categories', id)`（L186） |
| Frontend 读取 | `SweetCardPage.jsx:66` → `api('/v2/sweet-cards/rules')` | 与 overview/batches/cards/usage/audit 一起在初始化 Promise.all 中拉取 |
| Frontend 写入 | `SweetCardPage.jsx:105-106` → `PUT /v2/sweet-cards/rules`，body = `{ blockedCategoryIds }` | 只提交被勾选的分类 ID |
| API Handler | `server/sweet-card.js:756` GET `/sweet-cards/rules` | `requireDb() + requireAdmin() + assertSweetCardEnabled()` |
| Service / DB | `prisma.productCategory.findMany({ orderBy:[sortOrder, name], include:{ sweetCardPolicy: true } })` + `prisma.store.findMany(...)` | 分类 → `{id, name, blocked: sweetCardPolicy?.blocked === true}` |
| 分类本体的权威来源 | **`ProductCategory` 表，由产品中心维护**：`server/v2.js:748/760`（GET/POST `/api/v2/product-categories`）、前端 `src/components/ProductCenterPage.jsx:86` | 甜意卡模块**不创建分类**，只维护 `sweet_card_category_policies` 的 blocked 标记 |
| 门店统一性说明 | `PUT /sweet-cards/rules` 对 `eligibleStoreIds` 直接 **409**（`server/sweet-card.js:767`） | 门店开关的写权威专属 availability 域，规则页不持有 |

**结论**：规则页「不可使用商品分类」的唯一数据源是 `ProductCategory` 表；它不是 fixture、不是常量、不是 hardcode。

---

## 2. Current Rules Payload（本地环境实测返回）

```
GET http://localhost:3000/api/v2/sweet-cards/rules   → HTTP 200
{
  "stores": [
    { "id": "guanshe",  "name": "北京官舍店",     "eligible": true },
    { "id": "xidan",    "name": "北京西单店",     "eligible": true },
    { "id": "tongying", "name": "北京通盈中心店", "eligible": true }
  ],
  "categories": []            ← 空数组
}
```

直查本地库：`ProductCategory` 行数 = **0**。

---

## 3. Why Rules Page Appears Empty（为何规则页空白）

排除过程：

| 假设 | 结论 | 证据 |
|---|---|---|
| API 未返回 | ❌ 否 | HTTP 200，`categories` 字段存在且为 `[]` |
| frontend rendering bug | ❌ 否 | 组件逻辑与 95cd9ce 原始实现逐字等价（见下） |
| 本地 DB 数据缺失 | ✅ **是（根因）** | 本地库 `ProductCategory` 表 0 行 |
| 项目 fixture / seed 过旧 | ❌ 否 | 仓库内不存在任何分类 fixture：`git grep -rln "ProductCategory" prisma/migrations/` → 无；`scripts/` 无分类种子脚本 |
| 其他 | — | 无 |

**根因**：上轮为做 UI 验收，我写了一个**一次性临时 seed 脚本**（`seed-demo-tmp.mjs`，用完已删除），它只播了 Store / Batch / Card / Credential / ISSUE Ledger / User，**没有创建任何 `ProductCategory`**。分类本应由「产品中心」在正常业务流程中创建，本地库从未走过该流程。

### 附：空态缺失是 **pre-existing**，不是 Scheme B 引入

95cd9ce（改造前）原始规则页：

```jsx
{tab === 'rules' && data.rules && <section className="mt-4 rounded-3xl bg-white p-5 shadow-sm">
  <h2 className="font-black">不可使用商品分类</h2>
  <div className="mt-4 space-y-2">{data.rules.categories.map((row) => ...)}</div>
  <button ... >保存规则</button>
</section>}
```

Scheme B（当前）：

```jsx
{manageSection === 'rules' && data.rules && <section className="rounded-3xl bg-white p-5 shadow-card">
  <h2 className="font-black text-slate-900">不可使用商品分类</h2>
  <div className="mt-4 space-y-2">{data.rules.categories.map((row) => ...)}</div>
  <button ... >保存规则</button>
</section>}
```

**除 className 与外层 tab→manageSection 外逻辑完全一致**：categories 为空数组时两边都渲染成纯空白区域。所以「没有空态文案」是改造前既有行为。

**回答问题 5**：YES，UI 理应展示明确 effective state（如「当前无不可用商品分类」）。但这属于**对原有 UX 的新增改进**，超出「零业务逻辑改动」的硬边界，本轮**未实施**，列入 §11 待授权项。

---

## 4. Store Authority Source（门店列表唯一权威）

| 层 | 位置 | 内容 |
|---|---|---|
| **静态权威目录** | `shared/storeDirectory.js` `FIXED_STORES` | **4 家**：`tongying` 北京通盈中心店 · `guanshe` 北京官舍店 · **`chaowai` 北京朝外店** · `xidan` 北京西单店 |
| 目录硬断言 | `scripts/test-store-directory.mjs:10-19` | `assert.deepEqual(FIXED_STORE_KEYS, ['tongying','guanshe','chaowai','xidan'])` + 4 个中文名精确断言 |
| 运行时权威（甜意卡） | PostgreSQL `Store` 表 + `sweet_card_store_policies` | `availabilitySummary()`（`server/sweet-card-availability.js:106`）：`tx.store.findMany({ orderBy:{key:'asc'}, include:{ sweetCardPolicy:true } })` |
| 可用性判定 | `storeBusinessAllowed = store.active === true && store.operationType === 'DIRECT'` | DIRECT + 营业中才可配置 |
| Release 初始化脚本 | `scripts/initialize-sweet-card-store-authority.mjs` | 断言必须存在 4 家且 operationType ∈ {UNKNOWN, DIRECT}；注释写明 evidence `USER_CONFIRMATION_2026_09_05_ALL_FOUR_DIRECT` |
| 一致性守护 | `server/app.js:579` 对下行 store 列表 `filter(isFixedStoreKey)`；`server/employee-profile.js:434/461`、`server/partner-supply.js:79` 同样以 `isFixedStoreKey` 校验 | 幽灵门店无法进入任何业务路径 |

---

## 5. Current Local Store Payload（本地实测）

```
GET /api/v2/sweet-cards/availability  →  HTTP 200
globalEnabled: true   runtimeEnabled: true
 - guanshe   北京官舍店      active=true  op=DIRECT  enabled=true  configurable=true
 - tongying  北京通盈中心店  active=true  op=DIRECT  enabled=true  configurable=true
 - xidan     北京西单店      active=true  op=DIRECT  enabled=true  configurable=true
```

本机直查 `Store` 表：**3 行**，无 `chaowai`。

---

## 6. Missing Store Root Cause（第 4 家缺失根因）

**根因：上轮临时 seed 脚本手工只写了 3 家门店**（`prisma.store.create` 硬写 guanshe / tongying / xidan），**没有走** `shared/storeDirectory.js`，**也没走** `scripts/store-backfill.mjs`。

逐项排除：

| 假设 | 结论 | 证据 |
|---|---|---|
| 前端过滤 / 前端 bug | ❌ | `SweetCardAvailability.jsx` 直接 `data.stores.map(...)`，无 key/name 过滤；`git diff 95cd9ce HEAD -- src/components/SweetCardAvailability.jsx` = **空**（Scheme B 完全没碰这个文件） |
| API 丢数据 | ❌ | `availabilitySummary()` 无任何 hardcoded 名单，返回 `store.findMany()` 全部行 |
| hardcoded list | ❌ | 服务端只在 joy-directory 侧做「合法性校验」，不做「列表替换」 |
| stale DB / 旧 fixture | ❌ | 本地库是上轮全新 `initdb` + `prisma migrate deploy`，无任何历史沉淀 |
| 门店权限不足导致隐藏 | ❌ | 该 endpoint 只做 `requireAvailabilityAdmin`，返回全量门店；权限只影响开关按钮可用性 |

**证据（dry-run，未写库）**：

```
DATABASE_URL=... node scripts/store-backfill.mjs --db /tmp/budu-sc-empty-kv.json --dry-run
{"mode":"dry-run","sources":4,"counters":{"CREATE":1,"UPDATE":0,"SKIP":3,"RETIRE":0,"CONFLICT":0,"ERROR":0},"errorCount":0}
```

→ 权威源 4 家，本地缺 1 家待创建（`chaowai`），现有 3 家与权威完全一致（SKIP=3），无幽灵门店（RETIRE=0）。

**回答问题 7**：YES —— 只要权威 API 返回第 4 家（即 `Store` 表多出 active + DIRECT 的 `chaowai` 行），当前 UI **一定会**正确渲染出来，无需改一行前端代码。

---

## 7. Store Naming Differences（命名映射）

- 门店名直接取 DB 字段 `store.name`，**前端没有任何名称映射表**（无「旧名 → 新名」兜底）。
- 唯一存在的 label 映射是经营类型：`sweetCardStoreTypeLabel(operationType)`（`src/utils/sweetCardLabels.js:78`），与店名无关。
- 权威目录中第 4 家标准名为 **北京朝外店**（key `chaowai`），不存在拼写/旧名冲突风险。

---

## 8. Hardcoded / Fixture / Seed Dependency

- 业务代码侧：**无**门店 hardcode、无 fixture 列表（列表一律来自 `Store` 表）。
- 环境侧：**存在**——上轮我手写的一次性 seed 脚本绕过了权威目录，造成本地与 `FIXED_STORES` 偏差。脚本已删除。
- 建议后续搭本地验收库一律走 `scripts/store-backfill.mjs`，禁止手写 store 行。

---

## 9. Production vs Local Data Difference

- **生产本轮未连接**（Gate 明确禁止），因此生产的 `Store` 行数、**标记状态均为 UNVERIFIED**，本报告不猜测。
- 代码级权威三方一致（`shared/storeDirectory.js` + `scripts/test-store-directory.mjs` + `scripts/initialize-sweet-card-store-authority.mjs`）表明：**业务权威是 4 家，第 4 家 = `chaowai` 北京朝外店**。
- 因此「本地 3 家」是**环境级缺陷**，不代表生产受损，也不代表任何业务可用性被改变。

---

## 10. Scheme B UI Impact（是否只是忠实展示现有 API 数据）

**结论：YES — Scheme B UI 本身无任何业务语义变化。**

| 场景 | Scheme B 处理 | 与 API 关系 | 是否改业务语义 |
|---|---|---|---|
| 规则页 | `data.rules.categories.map(...)` | 忠实渲染 GET `/sweet-cards/rules` | 否（且 `SweetCardPage.jsx` 规则块与改造前逐字等价） |
| 使用门店页 | `SweetCardAvailability.jsx` 原样复用 | 忠实渲染 GET `/sweet-cards/availability` | 否（该文件 diff 为空，Scheme B 只把它挂进「管理设置 → 设置」） |
| 门店开关写 | `PUT /sweet-cards/availability/stores/:id`、`all-direct`、`global` | 未改动 | 否 |
| 分类写 | `PUT /sweet-cards/rules` `{blockedCategoryIds}` | 未改动 | 否 |

**本地测试数据如何恢复到当前真实状态**（见 §11，需你批准后执行）：

1. 门店：跑 `scripts/store-backfill.mjs`（幂等），从 `FIXED_STORES` 补齐 `chaowai`；
2. 分类：通过既有产品中心 API `POST /api/v2/product-categories` 建几类 demo，规则页立刻出现真实可勾选分类。

---

## 11. Recommended Safe Fix（均为待授权，本轮一项未执行）

**A. 门店补齐（仅本地，推荐，幂等）**
```
DATABASE_URL=postgresql://budu@localhost:5433/postgres \
  node scripts/store-backfill.mjs --db /tmp/budu-sc-empty-kv.json --dry-run   # 已跑，CREATE=1
DATABASE_URL=postgresql://budu@localhost:5433/postgres \
  node scripts/store-backfill.mjs --db /tmp/budu-sc-empty-kv.json             # 待授权
```
→ 从 `shared/storeDirectory.js` 权威 upsert 4 家；非权威门店 `active=false`（RETIRE=0，本地无需退役）。**不 hardcode 任何店名。**

> ⚠️ 脚本小坑：`--db` 参数缺省会读到 `--dry-run` 位置（`args[args.indexOf('--db')+1]` 未做 -1 保护），必须显式传 `--db <file>`。

**B. 第 4 家门店开启甜意卡核销（仅本地）**
`scripts/initialize-sweet-card-store-authority.mjs expand` 不适用本地——脚本硬断言库名 ∈ `{budu_bj006, budu_sc_availability_isolated}`，本地库名 `postgres` 会直接失败。
替代（等价、走既有 API）：管理设置 → 设置 →「全部直营店启用」，或 `PUT /api/v2/sweet-cards/availability/all-direct {enabled:true}`。

**C. 商品分类（仅本地）**
通过既有产品中心：UI 上 产品中心 → 新建分类，或 `POST /api/v2/product-categories`。
→ 规则页立刻出现真实分类。**禁止 hardcode 分类名单。**

**D. 生产**
本轮零接触。若将来需要让第 4 家在生产具备甜意卡核销能力，属**生产数据变更（C 档）**，须走 `initialize-sweet-card-store-authority.mjs + RELEASE_SHA` release 流程，并需你逐段 STOP 授权。

**E. UI 空态改进（前端-only，需你确认是否纳入 Scheme B）**
规则页 `categories.length === 0` 时展示「当前无不可用商品分类」。不触碰业务数据、不改 API、不改状态机；但属改造前不存在的新 UX，等 Orchestrator 决定是否允许。

---

## 12. Final Result

**`LOCAL_DATA_STALE`**

判定依据：

- 现象 1（规则页空白）根因 = 本地 demo 库 `ProductCategory` 0 行（我的临时 seed 未播种），API 正常返回、前端逻辑与改造前逐字等价 → 非 `FRONTEND_DATA_BUG`；
- 现象 2（门店只有 3 家）根因 = 本地 `Store` 表缺 `chaowai`，源于同一份手工 seed 绕过权威目录；权威代码明确为 4 家 → 非 `FRONTEND_DATA_BUG`、非 `DATA_PARITY_OK`（本地与权威目录确有偏差）；
- 无任何 blockers 阻止继续 → 非 `BLOCKED`；
- **两个问题均不是 Scheme B 造成的**：UI 忠实渲染现有 API，且 `SweetCardAvailability.jsx` 与规则块 diff 为空 / 逻辑等价。

### 附件：环境状态（本轮结束时）

| 服务 | 状态 |
|---|---|
| PG 5433 | 运行中（PID 90504） |
| API localhost:3000 | HTTP 200，`/api/health` OK |
| Vite localhost:5173 | 已重启，HTTP 200，`/api` 代理正常 |
| 本地 `Store` | 3 行（缺 chaowai，待 A 步骤授权后补齐） |
| 本地 `ProductCategory` | 0 行（待 C 步骤授权后补 demo） |
| Git | 无新改动、无新 commit（本轮 READ ONLY） |
