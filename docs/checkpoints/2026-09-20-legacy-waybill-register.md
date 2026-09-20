# Checkpoint — Legacy Waybill Register (旧链运单上报端点)

Date: 2026-09-20 (Asia/Shanghai)
Task mode: STRICT
Overall: **DELIVERED（后端已上生产）**；前端待微信审核

## 基本信息

- Repository: `GPTJJ/budu`
- Branch: `codex/legacy-waybill-register`
- HEAD: `ac6d7cbba630568251a92f3eecd3e2a016706e14`（已 push）
- Working tree: clean
- Production runtime: `budu-prod-ac6d7cb-legacy-waybill`（up healthy）
- `/opt/budu/.current-sha` = `ac6d7cbba630568251a92f3eecd3e2a016706e14`
- Rollback asset: `/opt/budu/.rollback-assets/legacy-waybill-ac6d7cb-20260920T090701Z/`（含 `rollback-app.sh`、`previous-sha`、`old-container-inspect.json`、nginx 前置备份）

## 背景与动机

生产 `SWEET_CARD_ONLINE_PAYMENT_PUBLIC=0` → 真实用户全部走 **旧链（payOrder）**。旧链此前**没有任何官方物流轨迹能力**：

- 商家点「发货」直接置 SHIPPED，无运单录入；
- 顾客订单详情没有可用的物流入口。

要把微信官方物流插件（`logisticsPlugin` / `trace_waybill`）覆盖到旧链，必须由 OS 侧统一上报——因为 **一个 appid 只能有一个 access_token 权威**，CloudBase 侧不得建立第二套 token 缓存（否则 `cgi-bin/token` 与 `cgi-bin/stable_token` 会互相使对方失效，产生间歇 40001）。

## 交付内容（OS 侧）

### 新增 `server/legacy-waybill-register.js`

- `createLegacyWaybillRegister({ db, gatewayConfig, wechatLogistics })`
- 生产网关 HMAC 验签：`verifyProductionGatewayRequest`（`x-budu-gateway-*` 头，签名字串含 `v1 / timestamp / nonce / POST / path / sha256(body) / ENV / APP`）
- actor 身份复核：`weChatAuthIdentity.findUnique`
- 参数校验：`payNo /^[A-Za-z0-9_-]{8,64}$/`；承运商∈`CARRIER_CODES`；`trackingNo /^[A-Za-z0-9_-]{4,80}$/`
- 缺 `transId` → `{ ok:true, result:{ status:'UNSUPPORTED', waybillToken:null } }`（**不伪造轨迹**）
- 正常 → `wechatLogistics.reportWaybill(...)` → 返回 `SYNCED` + `waybillToken`，或返回状态但无 token
- **完全无状态：不写生产库**

### 改动

- `server/online-merchant-api.js`：签名扩展为 `({ db, gatewayConfig, logistics = null, wechatLogistics = null })`；挂载 `router.post('/legacy-waybill', ...)`
- `server/online-checkout-runtime.js`：抽出单例 `wechatLogisticsClient` 并注入路由（复用既有 token 权威）

### 路由

`POST /api/v2/merchant/online-checkout/legacy-waybill`
无签名请求 → **HTTP 401**（已验证）

## 生产部署证据

- 公网 health：`{"ok":true,"env":"prod","appVersion":"V2.20","gitSha":"ac6d7cbba630","dbOk":true}`
- nginx 主站 `:3000;` 路由 3/3 指向新容器
- 单写者：生产容器 `DATABASE_URL` 哈希在运行中容器里唯一（其余为测试/克隆容器，库不同）
- 旧运行时 `budu-online-cancel-b0110d4`（Exited 42h）、`budu-prod-651e73a-logistics-651e73a`（Exited 17h）均保持停止 —— **恰好一个生产 writer**
- **DB / migration：未变更**；未触碰支付、退款、订单、库存、工资任何资金事实

## 测试

- `tests/test-legacy-waybill-register.mjs` 7/7（LWR-01..07：验签、身份、参数边界、UNSUPPORTED 不上报、失败不造 token）
- 既有物流回归 21/21
- 已注册进 `scripts/run-tests.mjs`

## 上游协作方（小程序侧）

- Repository: `GPTJJ/budu-miniprogram`
- Branch: `codex/legacy-waybill-entry`，HEAD `6b36a24`
- checkpoint: `docs/checkpoints/2026-09-20-legacy-waybill-entry.md`
- CloudBase `merchant` 云函数 `legacy-waybill.js` 经既有商家网关签名 transport 调用本端点

## 已知风险

1. `wechatLogistics.reportWaybill` 依赖 `goods_img_url` 为微信**可取**的地址：云存储**签名**链接（`*.tcb.qcloud.la`）→ errcode 0；静态托管（`*.tcloudbaseapp.com`）→ errcode -1。签名 `maxAge` 86400（24h）。
2. 上报失败不阻断发货（best-effort），订单仍 SHIPPED，`waybillReportStatus=PENDING`。
3. 缺失 `trans_id` 的历史订单只能返回 UNSUPPORTED。
4. 回滚：执行 `rollback-app.sh` 会切回 `ef158b7` runtime；CloudBase 侧不受影响（本端点无状态）。

## 下一步（无待办）

- 无代码待办。前端 1.0.30 通过微信审核并发布后，旧链全链路对外可见。
