# Sweet Card 1.1B Gate 0.5 — Runtime Evidence

本次授权后官方 CloudBase CLI 读取成功。只读下载部署包、查询函数配置和 orders 索引；未invoke任何业务函数、调用支付/退款、改配置、部署或修改业务代码。

**状态：HOLD。CloudBase证据已取得，但MiniProgram当前正式发布身份未取得，且支付安全存在现场确认blocker。**

## 1. Current CloudBase runtime

环境：`budu-d6gz358ixe39faf43`，由函数当前 Namespace 确认。以下时间按官方API原值保留，不自行换算时区。全部 Runtime `Nodejs16.13`，Handler `index.main`，Status `Active`，FunctionVersion `$LATEST`。

|Function|ModTime|Responsibility|
|---|---|---|
|sweetCardApi|2026-09-08 12:21:31|Signed Gateway adapter、Claim/Wallet/POS presentation|
|orders|2026-09-04 01:56:55|CloudBase订单创建、查询、取消、退款申请|
|payOrder|2026-09-04 23:43:07|WeChat JSAPI prepay与主动查询确认|
|merchant|2026-09-09 00:13:06|商家权限、发货、refund-service退款|
|orderNotify|2026-09-01 21:27:46|函数身份已验证，未将其名称当作支付回调能力证据|
|catalog|2026-09-04 01:24:50|目录读取|

当前下载的 index.js SHA256：
- sweetCardApi `5c8716d7a5f264cb8b5d7535b23a19d950029544af45bcbb7c2307bf9d2bef9f`
- orders `686c59cd27ccc24aaca4030985975184d6cca1e9e60ffb89b7bdbd1dac16a7e4`
- payOrder `8e156a520f3802b2b28b32104d1a08e706691544d0805b309c811e92dcd9a835`
- merchant `0489445446ef50637b95f4f901de1450c88c4c696aa7ab59d725f58fdfd5689a`

sweetCardApi 的 index.js/login-contract.js/production-signature.js 与51151745734d0ffa21a9da11756a0edc033fc13a对应工作树文件逐字节相同；不将这个结论扩展到所有配置或其他云函数。

## 2. MiniProgram authority

EVIDENCE_UNAVAILABLE：当前微信公众平台版本管理尚未取得。此前3.5.1不能替代当前版本/包身份。浏览器站点安全策略禁止自动访问该平台，未换工具绕过。需用户提供当前“线上版本”证据。CloudBase部署身份不证明客户端实际绑定相同环境/网关。

## 3. WeChat Pay configuration and paths

从当前下载的配置仅提取存在性，未输出Secret值：

|Item|payOrder|merchant.refundPayment|
|---|---|---|
|merchant identity|PRESENT|PRESENT|
|AppID|PRESENT|PRESENT|
|private signing key / serial|PRESENT|PRESENT|
|API v3 key|PRESENT|ABSENT（退款查询/请求验签不依赖通知解密，不能单凭此认定退款错误）|
|platform public key / id|PRESENT|PRESENT|
|payment notify URL|MISCONFIGURED：example.com占位域名|ABSENT|
|refund notify URL|ABSENT|ABSENT|

当前 payOrder `config.notifyUrl` 为 `https://example.com/wechatpay/notify`，`index.js` prepay读取该字段；不访问该外部地址。商户平台绑定、证书是否被撤销/过期的官方状态尚未取得，配置PRESENT不等于正式有效。

当前 payOrder `index.js:128` request只解析JSON，未执行微信响应验签；`:289` confirm对微信查询SUCCESS校验金额后，无事务、无当前业务状态保护地更新订单为PENDING_SHIPMENT，保存transactionId和paidAmountCent。当前包没有此前本地候选的payment-finalize.js，不能借用候选验签PASS。

## 4. Actual constraints

CloudBase orders 当前 listIndexes 仅返回：
- `_id_`（Mongo默认主键）
- `_openid_1`（非唯一）

不存在该集合的payNo、transactionId、refund request唯一索引。MP把支付/退款事实嵌入orders，不可拿OS表约束替代。列表来自官方NoSQL只读listIndexes；未读取订单个人信息。

上一轮本审计直接查询的PostgreSQL实际约束（OS独立域）：
- payments_merchant_trade_no_key，payments_provider_trade_no_key，payments_request_key_key
- payments_one_active_per_order_idx：order_id唯一，覆盖created/pending/success
- payments_amount_positive，payments_order_id_fkey
- refunds_request_key_key，refunds_refund_no_key，refunds_provider_refund_no_key
- refunds_one_pending_per_order：order_id唯一，status=pending
- refunds_payment_id_fkey，refunds_order_id_fkey，refunds_external_settlement_id_fkey
- refunds_amount_positive，refunds_refund_amount_positive，refunds_source_xor，refunds_mode_source_contract，refunds_contract_deferred

Payment/Refund constraints整体仍BLOCKED（CloudBase缺金融幂等唯一性；PG约束不能跨库生效）。

## 5. Current path and Gate0 corrections

MP客户端当前发布身份未闭合；服务端已直接取证：
- orders/create + payOrder订单解析：AUTHORITY = CloudBase orders/products；客户端cart仅intent/MIRROR。
- payOrder：ADAPTER = 微信prepay/query；微信provider结果是外部资金事实，CloudBase orders是现有本地确认投影/AUTHORITY。
- callback：当前配置为占位URL，不能宣称已有可用async callback settlement。
- merchant → refund-service → WeChat query/refund → CloudBase order.refund：退款路径；无独立多次部分退款authority证据。
- sweetCardApi：ADAPTER → Signed Gateway → PostgreSQL SweetCardAccount/Ledger/Claim/Binding AUTHORITY。
- OS POS Payment/Refund：另一个权威域，LEGACY_COMPAT仅针对未来集成，不能默认统管当前MP订单。

P0-A cancellation race **CONFIRMED**：当前orders/index.js:180只条件写CANCELLED，不close微信；payOrder/index.js:289起确认成功后无条件写PENDING_SHIPMENT。与Gate0观察的候选“拒绝迟到成功”不同，当前runtime可能覆盖取消或更晚订单状态。重复confirm还可能重复通知。Gate1必须明确幂等终态与取消裁决。

P0-B acceptance-as-complete **NOT CONFIRMED，当前代码已纠正**：merchant/index.js:194调用refund-service，:201只在rr.status===SUCCESS写REFUNDED，否则REFUNDING；退款模块验签provider响应、核对原单/金额/transaction，先查询固定R+payNo，再提交。PROCESSING不作为完成。此前9/8缺私钥与Gate0旧候选结论不能沿用。仍需评估异步自动恢复及部分退款，但不能说本问题仍存在。

## 6. Architecture recommendation

CROSS_DATABASE_FINANCIAL_TRANSACTION_RISK = YES：CloudBase orders事务不能与PG Ledger形成单个原子事务。建议Gate1以POSTGRESQL为financial settlement authority，覆盖checkout monetary snapshot、Reservation、Tender、payment settlement、refund allocation及必需financial order state。CloudBase仅edge/presentation/compat，不独立宣告财务完成。此处只提出方向，未迁移、未实现。

## Exit

CloudBase runtime authority PASS。
MiniProgram live authority EVIDENCE_UNAVAILABLE。
WeChat Pay production config BLOCKED（占位回调与当前响应验签路径缺失；商户平台状态未验）。
Payment constraints BLOCKED；Refund constraints BLOCKED（MP域）。
Cancellation-late-payment race CONFIRMED。
Refund completion authority issue NOT CONFIRMED（新部署已修正）。
Gate1 eligible NO。Production mutation NONE。Code change NONE。

仍需本人提供当前线上版本；商户平台证书/公钥与AppID正式绑定状态未确认。不得输出SWEET_CARD_1_1B_GATE_0_5_EVIDENCE_READY。Gate0报告中所有本地候选推断，以本文当前部署证据修正。

安全：原始部署包含Secret，仅位于本机权限受限/tmp/budu-sc11b-g05，不提交Git，不截图展示。本文仅安全元数据。没有创建支付、退款、Claim或任何测试卡。

## 更新：用户提供官方页面证据（2026-09-11）

本节取代上文“当前线上版本未取得”的陈述：用户截图01.41.11显示线上版本 **3.5.1**，发布时间 **2026-09-08 10:39:04**，发布者Dh；备注为 Sweet Card 1.1A POS使用码 | Production bootstrap | Merchant Unlock修复。截图01.41.57显示AppID **wxfce0a3c4bb430023**、服务未暂停。

版本号、发布时间、AppID已通过用户提供的官方页面截图验证。发布包hash及该包实际CloudBase/gateway绑定仍UNVERIFIED；备注不证明代码内容。截图不证明支付商户AppID绑定、证书有效性或API v3正式状态。未记录截图中无关的登录邮箱。

完整MINIPROGRAM_LIVE_AUTHORITY尚未闭合，Gate0.5保持HOLD。已确认的支付回调配置、状态保护和唯一索引问题仍待后续单独授权处理。本次只更新审计文档，无代码、配置或生产业务数据变更。

## 更新：商户平台 API 安全截图（2026-09-11 01:46）

用户提供的官方页面截图可见以下状态：
- 商户API证书：已申请，页面显示2031年08月22日过期。
- 商户APIv2密钥：已设置，2026年08月23日修改。
- 微信支付公钥：已下载，2026年08月15日申请。
- APIv3密钥：已申请，2026年09月04日修改（按页面原文，不替换为其他状态）。

证据为截图可见的平台配置状态；尚未证明运行时使用同一证书序列号、公钥ID或密钥版本。截图中的个人信息页登录账号不能当作商户号authority，不记录无关管理员个人信息。

仍需商户信息页的商户号及小程序AppID绑定状态，才能与运行配置比对。无需展示任何密钥，也无需点击修改。该截图不关闭已确认的支付通知占位地址、支付确认状态保护及CloudBase唯一索引blocker。Gate0.5保持HOLD。

## 更新：商户身份一致性（2026-09-11 01:48）

用户官方商户信息页截图显示微信支付商户号1116382351、普通商户。与本次下载的正式payOrder配置及merchant.refundPayment分别进行本机只读比对：merchant identity均MATCH；两者AppID均与小程序官方截图wxfce0a3c4bb430023一致。没有输出密钥或截图中的个人证件/营业执照信息。

结论：商户号及配置AppID一致性已验证；平台实际AppID关联授权状态仍需绑定页面证明，不能以配置相同替代。其他支付blocker不因此关闭。

## 更新：AppID关联授权闭合（2026-09-11 01:50）

用户提供微信支付商户平台“产品中心 → AppID账号管理”截图：昵称budu小卖部，AppID wxfce0a3c4bb430023，账号类型小程序，关联状态“已关联”。结合本次前述商户信息截图及部署配置比对，商户AppID关联证据已补齐；不再要求用户重复提供。

此证据不证明支付回调正确、响应验签已执行、数据库幂等约束完整，也不证明正式客户端包hash/实际环境绑定。支付配置占位回调、支付确认状态保护、CloudBase orders唯一索引问题仍阻止放行。保持只读，不自动修复或进入Gate1。
