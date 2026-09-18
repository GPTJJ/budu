# P0_ORDER_CANCEL_PRODUCTION_BASELINE_READY

> 仅只读诊断，未触碰生产。未做部署、未改环境变量、未清理任何订单、未使用 Daily Performance 候选代码。
> 任何修复必须在另一个 worktree 进行并人工 Gate 授权。

## Git baseline

- **仓库**：`/Users/apple/Desktop/budu OS` → `https://github.com/GPTJJ/budu.git`
- **目标基线 SHA**：`f18e903f721567d4d35c0d19d0a99cd268edf045`
- **目标 commit 标题**：`fix(checkout): reject missing authoritative catalog policies`
- **目标 commit 时间**：2026-09-15 12:29 +0800 · author GPTJJ
- **新建 worktree**：`/Users/apple/Desktop/budu-p0-order-cancel`
- **新分支**：`hotfix/p0-online-order-cancel-reorder`（基于精确 `f18e903f...`）
- **HEAD 校验**：`f18e903f721567d4d35c0d19d0a99cd268edf045` ✓ 精确等于
- **working tree**：`nothing to commit, working tree clean` ✓
- 原 `/Users/apple/Desktop/budu OS`（`feat/pos-wechat-refund` @ `788458a`）未做任何修改 ✓

## Production order code

**FOUND** — `/api/v2/customer/online-checkout/*` 路由在 `f18e903` 源码中完整挂载：

| 用户清单项 | 路径 | 状态 |
|---|---|---|
| `/api/v2/customer/online-checkout/*` | `server/online-checkout-api.js` | OK |
| `cancel` 路由 | `server/online-checkout-api.js:85` `router.post('/cancel', ...)` | OK |
| `state` | `server/online-payment-service.js:105` `recover(settlementId)` + `online-payment-recovery.js` | OK |
| `settlement` | `prisma/schema.prisma:2156` `model OnlineSettlement` + `server/settlements/*` | OK |
| `payment` | `server/online-payment-service.js` (prepare/cancel/recover) + `server/online-payment-finalizer.js` | OK |
| `reservation` | `prisma/schema.prisma:2197` `model SweetCardReservation` + `server/sweet-card-account-lock.js` | OK |
| `financial mirror` | `server/online-mirror-signature.js` + `server/online-mirror-transport.js` | OK |
| `tender` | `prisma/schema.prisma:2217` `model OnlineTender`（WECHAT / SWEET_CARD 两种） | OK |
| 路由挂载点 | `server/online-checkout-runtime.js:34` `app.use('/api/v2/customer/online-checkout', ..., customer)` | OK |
| 微信回调路由 | `server/online-checkout-runtime.js:33` `/api/online-checkout/wechat` + `online-payment-finalizer.js` | OK |

## CloudBase runtime drift

**UNVERIFIED — 需 CloudBase CLI 重新登录方可重核**

- CloudBase `budu-d6gz358ixe39faf43` 当前运行时指纹仅记录在 `docs/SWEET_CARD_1_1B_GATE_0_5_RUNTIME_EVIDENCE.md`（9/8–9/9 一次性 CLI 下载）：
  - `sweetCardApi` `5c8716d7a5f264cb8b5d7535b23a19d950029544af45bcbb7c2307bf9d2bef9f`
  - `orders` `686c59cd27ccc24aaca4030985975184d6cca1e9e60ffb89b7bdbd1dac16a7e4`
  - `payOrder` `8e156a520f3802b2b28b32104d1a08e706691544d0805b309c811e92dcd9a835`
  - `merchant` `0489445446ef50637b95f4f901de1450c88c4c696aa7ab59d725f58fdfd5689a`
- 这些指纹当时匹配 MiniProgram 源 `51151745…`（`codex/cloudbase-claim-scene`），**不是** OS 源 `f18e903`。
- CloudBase 函数（orders/payOrder/merchant/sweetCardApi）**不在** OS 仓库（这是两个独立仓库）。
- OS 端在 `f18e903` 提供的 customer 端点（`prepare` / `cancel` / `status` / `quote` / `submit` / `capabilities` / `refund-notify` / `notify`）的入参/出参契约，与 CloudBase 端最近一次已知指纹 (`51151745…`) 之间是否存在 drift，本环境无 CloudBase CLI 凭证无法重核。
- **不擅自覆盖、不擅自猜测**。

## 订单状态链：实单验证

**BLOCKED — 无生产 DB 访问**

- 实单：`Bf7d39d62fbfb5e5d9ed4f12c8d42d70`
- payNo 形态 `B<31 hex>` → 匹配 `online-checkout.js:79` `payNo = B${digest(id).slice(0,31)}`，对应 OS `OnlineSettlement.id = os-${digest([userId,requestKey])}`。
- 状态链预期：

```
WeChat CloudBase order (payNo 视图)
  → CloudBase orders/payOrder cloud functions
  → buducandy.cn /api/v2/customer/online-checkout/* (OS)
  → OnlineSettlement (Prisma)        ── status: PENDING | CLOSING | PAID | CANCELLED | EXPIRED | REFUNDED
      ├── OnlineTender (WECHAT)       ── merchantTradeNo, prepayId, prepayRequestedAt, providerTransactionId
      ├── OnlineTender (SWEET_CARD)  ── 仅 sweetCardCents > 0 时存在（本单金额为 0，故不存在）
      ├── SweetCardReservation       ── 仅 sweetCardCents > 0 时存在（本单不存在）
      └── capturedLedger (SweetCardLedger) ── 仅 PAID 且含 sweet card 抵扣时存在
  → 微信 provider /v3/pay/transactions/jsapi + out-trade-no/{merchantTradeNo}?mchid + /close
```

- **本单规格（来自截图）**：12颗礼盒 ×1、¥84、甜意卡 ¥0、微信 ¥84 → `wechatCents=8400`、`sweetCardCents=0`、无 SweetCardReservation、无 SWEET_CARD tender、单一 WECHAT tender（merchantTradeNo 与 payNo 同形 `B<31 hex>`）。
- **未在 OS 数据库直查**（无凭证）。仅代码静态分析；不擅自模拟。

## 根因（静态分析 — 待实单数据交叉验证）

读取 `server/online-payment-service.js:101-104` + `server/online-payment-cancellation.js:38-46` + `server/online-payment-cancellation.js:27-37` + `server/online-payment-service.js:105-125`：

`POST /api/v2/customer/online-checkout/cancel` 走以下路径：

1. `paymentService.cancel(settlementId, userId)`
2. → `cancellation.request` 把 `OnlineSettlement.status` 从 `PENDING` 推到 `CLOSING`，`reconciliationReason='CANCEL_REQUEST'`
3. → `service.recover(settlementId)`：
   - `cancellation.expire` —— 仅当已过期才动；本单 12:18 创建、12:29 操作，未过期，**无影响**
   - 读 settlement + tenders
   - 若 status 不在 `[PENDING, CLOSING]` → 返回当前状态（**问题点 ①：若已经 EXPIRED 或 REFUNDED 中间态，recover 直接返回，不 cancel**）
   - 若 `CLOSING` → `resolveUndispatched`：
     - 当且仅当 `wx.prepayRequestedAt` / `wx.prepayId` / `wx.providerTransactionId` **全为空** 才走 `release`（→ `CANCELLED`）
     - 否则**什么都不做**
   - `query(context)` → 调微信 `/v3/pay/transactions/out-trade-no/{merchantTradeNo}?mchid=...`：
     - WeChat `fact.state === 'SUCCESS'` → `finalize` → `PAID`
     - WeChat `fact.state === 'CLOSED'` → `cancellation.confirm`（仅在 `status === 'CLOSING'` 时 `release`）→ `CANCELLED`
     - WeChat `fact.state === 'NOTPAY'` 且 `status === 'CLOSING'` → POST `/close` 给微信 → 再 query
     - 任何其它状态（含 `USERPAYING` / `PAYERROR` / `REFUND`）→ **不 cancel、不 finalize、不 close** → 直接 `return publicState(context.s)`（**问题点 ②：若微信返回非 NOTPAY/CLOSED/SUCCESS，OS 端永久挂起在 CLOSING**）

**最可能的 4 个失败场景（按概率）：**

1. **微信返回 `USERPAYING`**（顾客刚打开微信支付中，又切回小程序点取消）：OS 端不 cancel、不 finalize、不 close，永久挂 CLOSING；客户端 `state()` 只认 `PENDING/CLOSING`，返回 CONFIRMING。
2. **微信返回 `PAYERROR` 或超时**：同上，永久挂 CLOSING。
3. **`resolveUndispatched` 静默跳过**：顾客曾触发过一次 `prepay`（`prepayRequestedAt` 被设置），但实际未支付；`resolveUndispatched` 不再 release，恢复路径完全依赖微信 close，**但如果顾客在微信侧已关单**而我们的查询因网络/凭据返回 NOTPAY，会走到 close→query 路径；任何一环失败就挂起。
4. **notify URL 不通**（`server/online-payment-service.js:18-21`）：回调断流后 `finalize` 永远等不到 SUCCESS 路径；与本场景（cancel）不直接相关，但会影响"为什么还显示待付款"。

**不会因为这条死单下不了新单的下游原因**：

- `customer(userId)` 在 `submit()` (`online-checkout.js:16-21`) 入口校验 `onlinePaymentAllowed(userId, env)`；若该用户在 `online-checkout-policy.js` 命中「开关 OFF」会抛 403。
- 顾客每次进入 `/quote` / `/submit` / `/prepare` / `/cancel` 都会带 `customer.userId` 路由到 `request.body.openId`，再走 `weChatAuthIdentity` 比对；若任一身份校验失败 → 401/403。
- **真正的"下不了新单" blocker** 多半在客户端（MiniProgram `online-checkout-client.js`）持有了未消解的 `budu_online_pending_v1:<userId>` 本地引用，导致新订单提交被本地 state machine 拦截；OS 端 `/api/v2/customer/online-checkout/quote` 不会主动返回 "you already have pending"，它只看 customer.userId 是否允许 newPurchase。客户端的 `newPurchase()` (`utils/online-checkout-client.js:119-125`) 只有在 `terminal===true` 时才允许。

## 待用户授权下一步（不在本 baseline 内执行）

需要 Gate 授权才能进行，且本 baseline 不擅自启动：

1. **数据库只读查询** —— 拉出实单 `Bf7d39d62fbfb5e5d9ed4f12c8d42d70` 对应的 `OnlineSettlement` + `OnlineTender` + `OnlineCheckoutQuote`，确认 status / reconciliationReason / WeChat 查询结果。
2. **CloudBase CLI 重新登录** —— 重核 4 个云函数当前部署 SHA256，与 `f18e903` + `51151745…` 两个源 commit 做 drift 报告。
3. **修复方案评估** —— 在掌握实单状态后再决定是补 settle 还是补客户端 reset。