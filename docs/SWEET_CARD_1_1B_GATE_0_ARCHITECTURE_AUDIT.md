# Sweet Card 1.1B Gate 0 — Integration & Authority Audit

审计日期：2026-09-10（北京时间）。范围：只读架构发现；仅新增本文档。

**Gate status: HOLD / EVIDENCE_INCOMPLETE。不得开始 Gate 1 实施。**
现场 OS 可验证；CloudBase CLI 当前要求重新登录，已停止下载命令；微信公众平台正式版本未在本次取得。不能以此前聊天中的 3.5.1、CloudBase SHA 或退款故障结论代替当前事实。本报告完成架构分析，但不宣称全部生产权威已闭合。

## Evidence and Skills

实际读取：budu-task-router、context、data-authority、sweet-card（含 business-contract）、payment-safety、regression、production-deploy、handoff；小程序侧 budu-mp-task-router、context、data-authority、payment-safety、cloudbase、api-contract，之前读取的 security。
分类 STRICT。发现目录中没有独立 Order/Checkout/Logistics/Prisma/PostgreSQL/Concurrency/Ledger Skill；使用现有支付、数据权威和甜意卡约定。不调用部署或迁移。
部分小程序 Skill 内“没有 OS 集成”等旧现状描述为 STALE；当前代码已具有 Signed Gateway。不能据旧说明否定当前集成，也不能把 OS 订单权威直接套用于 CloudBase 订单。

源码基线：
- `OS` = `/Users/apple/Desktop/budu-delivery-package`，95cd9ce48b25de35570cc6f1f07154ab2e13cb78，与现场 SHA 一致；文件内容审计为 OBSERVED，未逐文件下载运行包比对。
- `MP` = `/Users/apple/Desktop/budu-miniprogram-a10`，a1eb5198875de7c026c16c6da774cc28779a7c80，clean，upstream 同名 feature branch。不代表当前所有云函数版本。
- `CB` = `/Users/apple/Desktop/budu-cloudbase-claim-scene`，51151745… 的 short-scene 源码；部署状态本次 UNVERIFIED。
- 报告所在原仓库 HEAD 788458a…，feat/pos-wechat-refund；原有 untracked 文件全部保留。不把原仓库旧 HEAD 当 Production。

主要源码引用（以下路径以 OS/MP 为根）：
- MP `cloudfunctions/payOrder/pricing.js`，`orders/pricing.js`：服务端目录计价。
- MP `cloudfunctions/payOrder/index.js:37`：订单解析/创建；`:267` 附近回调，`:367` prepay，`:414` query。
- MP `cloudfunctions/payOrder/payment-finalize.js`：验签、解密、事务确认。
- MP `cloudfunctions/orders/index.js:96` 创建，`:180` 取消，`:223` 申请退款。
- MP `cloudfunctions/merchant/index.js:142` 退款，`:237` 发货，`:267` 同意退款。
- MP `pages/checkout/checkout.js:266`：客户端生成 payNo，调用订单及 prepay。
- OS `server/sweet-card.js:193` 核销；`sweet-card-refunds.js` 退款；`sweet-card-account-lock.js` 账户锁；`sweet-card-claim.js` Claim/Wallet/POS presentation；`sweet-card-availability.js` 门店能力。
- OS `prisma/schema.prisma:502` Order，575 Payment，622 Refund，1820 起 Sweet Card 系列。

## 1. Production Authority Baseline

| 项目 | 本次证据 | 状态 |
|---|---|---|
| OS SHA | 95cd9ce48b25de35570cc6f1f07154ab2e13cb78；current-sha、容器 GIT_SHA、public/internal health prefix 一致 | VERIFIED |
| Runtime | budu-prod-95cd9ce-delivery / budu-api:delivery-95cd9ce | VERIFIED |
| Public/internal health | ok=true，dbOk=true，env=prod | VERIFIED |
| Database | current_database() = budu_bj006；runtime host=bj006-postgres | VERIFIED |
| Migration | 70 finished/non-rolled-back，0 unfinished/non-rolled-back | VERIFIED |
| Single writer | running Docker applications 中精确 DB=budu_bj006 的一个；partner_g10_clone、budu_a10_clone_859790a、test DB 分别隔离 | VERIFIED（运行容器范围；不声称排除了任何外部数据库客户端） |
| Ledger / balance | 两者均 1,300,110 cents，projection delta=0 | VERIFIED 单次只读快照，不推断业务期间余额恒定 |
| Claim enabled / allowlist-only | 1 / 0 | VERIFIED |
| MiniProgram live version | 历史记录3.5.1，当前平台未读取 | UNVERIFIED |
| CloudBase Production | 目标 budu-d6gz358ixe39faf43；本次 CLI 认证失效，部署 hash/config 未取得 | UNVERIFIED 当前状态 |
| Payment configuration | OS WeChat/Alipay merchant/key-file/protocol 配置项存在；只输出 SET/EMPTY，不读取密钥值 | OBSERVED presence，不等于 provider ready |
| CloudBase payment keys/callback routing | 未取得当前正式配置 | UNVERIFIED |
| Backup / rollback | 本次没有部署；未复验备份内容和可恢复性 | UNVERIFIED；任何后续生产 Gate 必须另验 |

未发现两个当前运行时 SHA 互相冲突；历史文档落后不作为 AUTHORITY_CONFLICT。没有修改生产配置或开关。

## 2. Domain Authority Matrix

状态针对 1.1B 集成，不将两个独立业务系统的存在本身视为生产数据错误。读写路径为源码观察。

| Domain | Model / authority | Service：write → read | External / cache / duplicate risk | Class |
|---|---|---|---|---|
| Product | MP CloudBase products；OS InventoryItem | catalog/seedCatalog → catalog+priceIntent；OS product center → POS | 前端目录镜像；尚无批准的跨系统 ID 映射 | DUPLICATE_AUTHORITY |
| SKU | MP product id/options/combo；OS InventoryItem.sku | intent validation → order snapshot | options 非稳定独立 SKU 权威；不能按名称联结 | BLOCKER |
| Pricing | MP products.unitPriceCent + pricing.js；OS POS pricing | server priceIntent → immutable order amount snapshot | orders/payOrder 两份计价文件有漂移面；UI估算不覆盖服务端 | LEGACY_COMPAT |
| Cart | 客户端购买意图，不是金额事实 | local storage → checkout lines → server priceIntent | 可篡改，必须全量验证 | SAFE（仅意图） |
| Order | MP CloudBase orders._id/payNo；OS PostgreSQL Order.id | orders.create / payOrder create fallback → orders list/detail | 双创建入口；跨库不能原子提交 | BLOCKER |
| Order Item | MP orders.items snapshot；OS OrderItem | priceIntent snapshot → order detail | MP 无独立稳定行 FK；产品分类不同 | DUPLICATE_AUTHORITY |
| Payment | MP orders 上 paidAmountCent/transactionId；OS Payment | notify/query finalizer → orders；OS payment service → reconciliation | MP 没有已证明独立 payment-attempt/tender history | BLOCKER |
| WeChat Payment | 微信结果 + 各自本地持久化确认 | payOrder create/notify/confirm → orders | OS POS provider 与 MP JSAPI 配置不可混用 | BLOCKER（当前部署未验） |
| Refund | MP orders.refund；OS Refund/RefundItem | merchant.handleRefund → order status；OS refund service → refund logs | MP 可覆盖单一 refund 对象，没有多次部分退款账本 | BLOCKER |
| Sweet Card | PostgreSQL SweetCardAccount.id | sweet-card service → management/claim wallet | balance 是 Ledger projection | SAFE（保留） |
| Sweet Card Ledger | SweetCardLedger | issue/redeem/refund transaction → reconciliation | CloudBase 禁止镜像作为第二余额权威 | SAFE |
| Binding | SweetCardBinding + Claim + User.id | authenticated claim/bind → wallet | 收礼名字不是 owner | SAFE |
| POS Redemption | SweetCardRedemption/Item + Ledger | existing redeemSweetCard → Order settlement | 依赖 POS actor/store/credential，不能直接冒充线上调用 | SAFE（POS限定） |
| Store Availability | Store + SweetCardStorePolicy / control | availability service → POS/presentation | MP storeId 未证明映射同一 Store.key | LEGACY_COMPAT |
| Customer/User | MP users/openid；OS User + external identity/session | wx login → CloudBase signed gateway → OS User.id | MP order owner 与 OS User.id 需明确签名映射 | LEGACY_COMPAT |
| Address | MP order.recipient；客户端地址输入 | checkout → orders recipient snapshot | 用户输入必须校验；OS Mailing 不是该订单地址权威 | LEGACY_COMPAT |
| Fulfillment | MP order.status/shippedAt | merchant.ship → orders detail | 没有独立稳定 fulfillment record 被发现 | LEGACY_COMPAT |
| Shipment | MP SHIPPED状态 | merchant.ship → detail | carrier/tracking独立事实未发现；OS其他寄件业务不可默认复用 | BLOCKER |
| Tracking | 未发现 MP 权威 tracking event model | 未找到 provider query/update path | 无可验证轨迹来源 | BLOCKER |

## 3. Product/Pricing Authority

源码链：cart/buy-now local storage → checkout lines → orders.create / payOrder.resolveAuthoritativeOrder → products 查询 → priceIntent → calcShipping → amountCent + items snapshot → WeChat prepay amount。

| 字段 | 当前源码判定 |
|---|---|
| productId | 客户端意图；服务端目录查存在 |
| skuId/options | 无独立 skuId 模型；options随行保存，未见对价格型规格逐项定价 |
| name / unit price | 取服务端 products，不取客户端展示金额 |
| quantity | 服务端正整数1–999；散糖至少6颗 |
| availability / sale status | 缺商品拒绝；status存在且非on拒绝，但status缺失被接受；无库存预留 |
| shipping | 服务端15元，满200免邮；需另审自提是否也被收运费 |
| discount / promotion | 未见客户端折扣参与实付；无通用promotion authority，不应假定已支持 |
| final payable | server goods+shipping，新单整数分；旧单 total元兼容回退 |

SERVER_PRICING_AUTHORITY：**FAIL（生产验收证据未闭合）**。源码新单金额控制为 PASS；没有证据可指认“客户端 unitPrice 当前直接决定扣款”。P0 待核项是当前正式 payOrder/orders/目录权限和金额型 SKU 完整性，不能用客户端显示正常替代。旧单来源及数据库唯一索引必须核验。商品分类中文文本不能直接当 OS ProductCategory.id。

## 4. Order State Machine

| Transition | Initiator / API | Boundary / writes | Idempotency / retry / recovery |
|---|---|---|---|
| cart → PENDING_PAYMENT | customer orders.create；payOrder也可补建 | CloudBase add orders | client payNo；查后add，唯一索引本次未验，重试可能竞争 |
| pending → prepay | customer payOrder.create | 微信外部请求；没有统一跨库事务 | out_trade_no；未知结果查原单，不能换号重付 |
| pending → PENDING_SHIPMENT | signed notify / verified confirm query | runTransaction重新读订单，金额+tx验证后update | 同单同tx完整证据no-op；异tx拒绝 |
| pending → CANCELLED | customer orders.cancel | 条件update pending+owner | 不调用微信close；迟到成功被finalizer拒绝，存在不一致窗口 |
| payment failure | wx payment失败或网络错误 | 不能将UX失败当资金失败 | 当前无完整过期/关单恢复证据 |
| PENDING_SHIPMENT → SHIPPED | merchant.ship | payment evidence gate + conditionalupdate | 并发updated检查；未见独立shipment |
| SHIPPED → PENDING_REVIEW | customer confirmReceipt | owner+status条件update | 重复不推进 |
| PENDING_REVIEW → COMPLETED | customer review | 条件update | 重复不推进 |
| paid/shipped → REFUNDING | customer applyRefund | 查后update refund对象 | 非事务状态CAS；与发货/重复申请有竞争面 |
| REFUNDING → REFUNDED | merchant approve | 微信退款返回后本地update | R+payNo，单一全退；接受状态不等于最终到账 |
| REFUNDING → prior status | merchant reject | update fromStatus | 需与approve串行协调 |

实际未发现部分退款状态、失败退款持久化状态或预留状态；不在本 Gate 发明成已有能力。

## 5. Payment State Machine

源码 prepay 在服务器生成；callback验签（RSA、serial、±5min）→ AES-GCM解密 → appid/mchid/out_trade_no → amount/currency → SUCCESS → transaction finalizer。confirm查询也验签并调用同一finalizer。前端 wx.requestPayment 结果不直接写PAID。

已观察同订单tx幂等、事务重读和金额校验。未证明跨订单 transaction_id/payNo 唯一索引；payment-attempt记录、定时补偿、微信close、cancel竞态闭合均不足。订单创建由服务端执行，但payNo由客户端生成，双入口均需幂等保护。未见callback payer.openid与订单owner的独立比对；prepay/confirm有调用者owner校验。currency缺失未明确拒绝。

generic500/timeout不得释放余额或创建新支付；以原out_trade_no查询。源码存在错误返回，但没有可证明的持久化UNKNOWN队列。**WECHAT_PAYMENT_SAFETY: BLOCKED**（生产部署配置和索引未知；取消/晚回调闭合不足）。OS POS Payment 的成熟度不能代替 MP JSAPI 的验收。

## 6. Refund Authority

MP handleRefund使用原payNo、R+payNo全额退款，单个orders.refund保存结果；没有已发现的多次部分退款、refund-attempt账本、退款回调/主动查询闭环。返回200含refund_id后即写REFUNDED，甚至状态可能PROCESSING；网络成功/落库失败存在恢复缺口。历史9/8缺少签名密钥故障仅作 STALE 背景，本次未复验其是否仍存在。

OS Refund/RefundItem → prepareSweetCardRefund固定原订单行分配 → completeSweetCardRefund；原账户恢复，unique requestKey和Ledger键防重复。不是把MP退款字段直接传入即可安全复用。

最大可退额、多次/并发退款必须包含处理中占用；仅累计已成功退款会导致并发超退。原支付link、provider refund id唯一性需正式索引证据。

## 7. Sweet Card 1.1A Protected Baseline

源模型：Account、Ledger、Credential、ClaimToken、Claim、Binding；external identity → User.id。Claim/POS命名空间分离，官方码short scene、独立proof；Wallet/POS presentation鉴权；既有POS核销原子写Redemption、Ledger、balance projection及Order分配。refund回原Account；账户advisory lock、Serializable和P2034整事务有限重试。

现场Ledger=balance。**SWEET_CARD_1_1A_PROTECTED_BASELINE: BLOCKED（完整现场验证未闭合，不代表发现资金损坏）**：CloudBase版本及当前MiniProgram正式版本未验证。本 Gate 没有运行真实Claim/POS/退款。保护要求：不得将1.1A Public Claim绑定1.1B开关；不得建立CloudBase余额权威；不得修改原POS Ledger意义。

## 8. Reservation/Capture Fit Analysis

**ONLINE_SPEND_MODEL: RESERVE_CAPTURE**。
当前schema未发现Reservation；Ledger enum是经济事实，不能把reserve伪装REDEEM再冲回。Reservation位于Ledger之外，冻结可用额度：available=balance-sum(active reservations)。Release仅改变reservation状态；capture一次写实际REDEEM及投影。

关键：当前POS maximum只看balance，新增reservation后POS与线上必须在同一account锁下扣除预留额度，否则线上预留不能阻止POS花掉余额。不是重写POS经济语义，但需要经过独立兼容Gate的可用额检查。现有redeemSweetCard要求POS订单、员工权限和POS credential，不能由网关伪造收银员；应在批准后复用/收敛共享原子扣款authority，不直接调用POS HTTP路由。

## 9. Mixed Tender Architecture

| Order100元 | Sweet Card | WeChat | settle condition |
|---|---|---|---|
| A | 0 | 100 | verified WeChat100 |
| B | 40 | 60 | verified WeChat60 + capture40 |
| C | 100 | 0 | capture100；不创建零元微信交易 |

MP当前单一total与transactionId不足以表达B/C。OS已有sweetCardAmount、Payment、Redemption、refund分配，不能直接成为CloudBase订单FK。
**TENDER_ALLOCATION_MODEL_REQUIRED: YES**（MP线上持久化语义）。冻结订单金额、每行/运费可付额、card contribution、provider remainder、policy version；结算事实append-only，状态投影允许受控迁移。先确定订单权威及跨库协调方案，禁止同时维护两份“最终已付”。

## 10. Refund Allocation Analysis

建议评估 **CUMULATIVE_PROPORTIONAL_ALLOCATION**，未冻结。以整数分和不可变原分配为基准：订单T、卡S、累计已批准退款R，cardTarget=floor(R*S/T)，wechatTarget=R-cardTarget；本次等于目标减已分配。满额R=T强制恰好返原S和T-S。
100/40/60：全退100→40/60；累计退50→20/30；累计退1→0.40/0.60。若1元是在50元后追加，则累计51→20.40/30.60，本次仍0.40/0.60。多次小额亦按累计目标，不能逐次独立四舍五入。相同request key仅返回既有allocation；并发在order/refund锁内占用最大可退额度。处理中占用计入上限，失败须明确释放并保留历史。
若商品黑名单或运费不可用卡，必须按原eligible line/shipping bucket分别累计，而非整单盲目40%。既有POS按商品累计数量分配保持不变。每个tender返还累计不得超过原出资；卡返原Account，微信返原Payment。

## 11. Cancellation/Failure Recovery

| Scenario | 必须保持的 invariant（建议，非已有能力） |
|---|---|
| 用户取消/关闭小程序 | 关闭App不代表取消；原支付结果未明确前reservation保留 |
| 微信失败 | 明确终态才release；timeout不是失败 |
| prepay过期 | query/close确认不会支付，再release；不能只靠本机TTL |
| late callback | 已收钱必须进入可恢复结算或退款，不能静默拒绝后无人处理 |
| repeated callback | 原attempt唯一键，capture exactly-once经济效果 |
| cancel race | close/query与付款裁决持久化；不允许订单cancelled同时已收款且无补偿 |
| 微信成功后capture前崩溃 | durable payment evidence/outbox，重启重试同reservation；fulfillment保持blocked |
| capture成功后响应丢失 | read by idempotency key，禁止第二次扣款 |

跨CloudBase/PostgreSQL无本地原子事务：需要持久协调状态、inbox/outbox与补偿。建议新线上结算聚合由一个明确权威服务负责；是否订单也迁入OS须Gate1单独决定，不能在此批准迁移。

## 12. Concurrency Strategy

推荐固定锁序：order/attempt → account；reserve/capture/release以及POS可用额读取遵守同一账户锁。PostgreSQL事务＋唯一键＋余额约束，Serializable冲突只重试整个DB事务（当前P2034机制可参考）；外部微信请求在事务外，以持久attempt和稳定商户号重试/查询。不得把跨网络动作放进可自动重放的事务函数。
唯一性：order+reserve request，reservation唯一capture，provider transaction唯一，refund request唯一，refund allocation+source唯一，Ledger event key唯一。active reservation总额须在锁内验证；过期清理必须协调支付未知状态。跨库无FK处用不可变external reference、签名和inbox去重，不凭名称。

## 13. Online Eligibility Boundary

POS_REDEMPTION_ELIGIBILITY = store-pos actor + enabled store + POS credential + card status/binding + category snapshots。
ONLINE_ORDER_ELIGIBILITY = verified User.id owns/has allowed access + online channel policy + immutable product mapping + eligible merchandise/shipping + card status/expiry + available balance。
当前所有POS-enabled门店不可自动开放online；需明确online fulfillment store、product mapping、channel flag、reservation资格。**Online eligibility readiness: PARTIAL**。owner、状态、余额已有基础，线上渠道/商品/运费authority尚未冻结。

## 14. Shipping Fee Policy Analysis

| Policy | Checkout / tender | Refund / accounting | UX |
|---|---|---|---|
| A 卡可付运费 | 运费进入eligible allocation；余额足可卡-only | 原运费bucket固定出资；退运费按该bucket归还 | 一次结清，无小额补差 |
| B 卡不可付运费 | 卡上限仅商品，运费强制微信 | 运费退款仅微信；商品按其原分配退 | 即便卡余额足仍需付运费 |

初版建议A，以降低小额混付及取消复杂度，但须业务确认且账务将运费明确列项，不把运费伪装商品。包邮、部分退款是否追补运费须冻结；建议不追溯重算已成交包邮。Gate0不实施、不改变现有POS黑名单。

## 15. Logistics Readiness

**PARTIAL**：已有recipient name/contact/address、订单详情和merchant发货/用户收货状态。审计范围内未发现carrier、trackingNo、tracking events、权威物流查询更新、独立shipment记录。不能以SHIPPED标记宣称可追踪配送。OS Mailing/Partner流程属于别域，不改Partner Replenishment，也不默认把它当线上物流authority。Gate1先确认是否已有外部物流系统及稳定订单引用，再决定适配而非新建第二系统。

## 16. Database Impact Forecast

**ADDITIVE_ONLY（可行建议，非已批准schema）**。

| Concept | Authority/lifecycle | Unique/FK/concurrency | Immutability |
|---|---|---|---|
| SweetCardReservation | PG资金预留；active→captured/released/expired（需provider裁决） | Account FK；稳定online order ref；request unique；account lock | 金额/来源不变，状态变迁审计 |
| OrderTender | 唯一线上结算聚合；planned→pending→settled/failed | order+source/attempt unique；若同库真实FK，否则external ID/inbox | 原出资/政策快照不可覆盖 |
| RefundAllocation | 原tender来源；reserved→processing→confirmed/failed | Refund+Tender unique，order锁和累计上限 | 已完成分配不可重算 |

还需评估PaymentAttempt/Inbox/Outbox持久化；不能靠内存回调补偿。无需删除或重写历史POS数据。若后续方案要求破坏性迁移，P0 STOP。

## 17. Feature Flags and Failure Domains

建议独立 SWEET_CARD_ONLINE_PAYMENT_ENABLED，默认OFF；可选USER稳定ID allowlist。code deployed + OFF必须可行。开关只管创建新online reserve，不阻断已开始交易的callback/capture/refund/reconciliation；不改变POS、Claim、Wallet、COMMERCIAL generation。

| Failure domain | Recovery source | Retry/user retry/manual |
|---|---|---|
| Pricing | authoritative catalog + order quote snapshot | 未建单可重新quote；不得改历史金额 |
| Order | stable idempotency/external order reference | 查原单，可安全同键重试；重复权威需人工核对 |
| Reserve | PG reservation+account | 同键重试，未知状态先查 |
| WeChat | provider trade query + durable attempt | 用户只可查/继续原attempt；歧义人工reconcile |
| Capture | reservation+verified payment+Ledger key | 自动幂等恢复；用户不得另建扣款 |
| Refund | provider refund query+allocation | 原request重试，禁止新号盲退；异常人工核对 |
| Fulfillment | settled aggregate + fulfillment record | 支付未齐不得发货；发货同键/人工确认 |
| Logistics | carrier evidence+tracking ID | 查询可重试，重复寄件须人工裁决 |

## 18. P0 Blocker Register

仅将资金/权威风险列P0，普通页面、表模型开发不是P0。

| ID | Risk / evidence | Closure |
|---|---|---|
| P0-01 | CloudBase orders和PG资金跨库，线上order/tender最终权威尚未批准；可能收款无capture/重复结算 | freeze owner、稳定映射、恢复状态和幂等协议 |
| P0-02 | 源码cancel仅改本地，finalizer拒绝cancelled迟到成功；可能已收款未履约 | query/close裁决及可恢复补偿证明；核对正式部署 |
| P0-03 | 源码退款受理即REFUNDED，缺多次部分退款/持久恢复；可能退款状态虚假/丢失 | provider终态确认、refund allocation/attempt并发上限 |
| P0-04 | 未验正式payNo/tx唯一索引，双订单创建路径查后add | live index evidence + duplicate/concurrent create proof |
| P0-05 | 未冻结MP商品/SKU与OS资格映射；不能安全应用黑名单或退款line allocation | stable ID mapping + server SKU/amount authority |
| P0-06 | reserve若不影响POS当前balance-only可用额，可能跨渠道超额承诺 | 同account锁下统一available余额检查，POS兼容验证 |

证据 blocker（不等同确认生产故障）：CloudBase当前部署/config/索引、MiniProgram live version、物流外部权威未取得。此前退款密钥问题不可自动当当前P0事实。

## 19. Gate 1 Recommendation / Exit

建议下一步先补齐Gate0运行证据，再单独授权 Gate1：Order/Pricing Identity + Payment Recovery Contract Freeze。优先决定线上订单/结算owner、产品映射及cancel/refund恢复；随后冻结reservation、tender和退款舍入，不自动实施。

Summary:
- Production SHA: 95cd9ce48b25de35570cc6f1f07154ab2e13cb78
- Database: budu_bj006; Migration: 70 / 0 failed
- MiniProgram: UNVERIFIED current live version（历史3.5.1）
- Server pricing authority: FAIL（production evidence incomplete；new-order source monetary logic PASS）
- Order authority: CloudBase orders (MP) / PostgreSQL Order (POS)，integration boundary unresolved
- Payment authority: MP embedded order evidence / OS Payment；WeChat payment safety BLOCKED
- Refund authority: MP order.refund inadequate for1.1B；OS Refund protected
- Sweet Card1.1A protected baseline: BLOCKED full live evidence, Ledger projection reconciliation PASS
- Online spend model: RESERVE_CAPTURE; Tender allocation required YES
- Refund: CUMULATIVE_PROPORTIONAL_ALLOCATION per original eligibility bucket, integer cumulative floor + final remainder
- Concurrency: fixed locks + Serializable DB-only retry + unique keys + durable cross-system reconciliation
- Online eligibility PARTIAL; Shipping recommendation A subject business approval; Logistics PARTIAL
- Migration forecast ADDITIVE_ONLY
- Production mutation NONE; Code change NONE; no production tests creating payment/refund/card/claim
- Gate0 HOLD；不输出SWEET_CARD_1_1B_GATE_0_AUDIT_READY，不开始Gate1。

Handoff: only this document added; no commit/push requested or performed. Unknown local files preserved. Uncommitted report cannot be recovered from Git on another device. Local raw CLI authentication output and protected credential helpers are not report artifacts and must not be committed. No secret/token/customer payload included in this document.
