# budu 线下门店服务进入小程序：候选说明

任务：BUDU-OFFLINE-TO-MINI-001。需求确认日期：2026-10-24（北京时间）。

**状态：INTEGRATION_BLOCKED。** 两端代码、隔离数据库/HTTP验证、界面验证及独立复核已完成；未上线。真实微信触达、完整官方模拟器/真机验收及隔离环境远端联调未完成，不以合成响应或编译成功替代。

## 基线与范围

| 项目 | 实测本地原工作区 | 本任务候选起点 |
|---|---|---|
| OS | recovery-20261008 / 29ed604124c9fc6981f08cbc20c21ff4f7c0b851；存在其他任务PosOffer修改，完整保留 | origin/codex/purchase-return-supplier-select / a86e150；独立 codex/offline-to-mini-001 |
| 小程序 | main / 6231207235ba7e9bf64666506f2d3d97c80e4a7b；干净 | origin/codex/store-pickup-001-release / ce85937544d73466f7e532f655d20b40aadfc2e7；独立同名分支 |

OS remote 为 GPTJJ/budu；小程序为 GPTJJ/budu-miniprogram。已 fetch 核对引用。候选最终准确提交、包体摘要与持久目录由交付目录的 candidate-manifest.json 记录。

生产公开健康 GET 被自动审批拒绝，原文理由：“当前授权明确将生产访问留在最终确认边界，未授权本轮连接线上服务”。未绕过。实际生产SHA、容量、迁移、Writer、现网模板和云函数配置均为本轮未核验，不从旧文档推断。

改动仅涉及独立服务申请、对应 UI/原生页、签名桥、增量迁移和只读关联统计。没有创建虚假订单、改变库存/价格/支付/退款/提成算法；没有发真实通知、创建真实订单或执行真实交易。

## 需求对应

| 要求 | 候选实现与实际证据 |
|---|---|
| 扫码直接填邮寄/开票 | 同一原生 form 路由按服务器申请类型显示；32字符凭证引用，可信门店上下文；官方二维码适配器已测，实际门店服务码未扫描 |
| 一次性与可靠回执 | H5和小程序锁同一token行；申请/业务记录/归属/消费同事务；本人重试返回原requestId，拒绝他人/跨App/env；真实PG并发和HTTP通过 |
| 既有字段/费用规则 | 复用 validateMailingSubmission、validateInvoiceSubmission、原服务metadata和正式MailingRecord/Invoice；不改定价 |
| 个人回查 | “我的门店服务”、分类列表、详情、空/错/加载/重登返回；无购买记录也能办理；旧未绑定记录不按电话/邮箱认领 |
| 开票接收 | developer独立确认时间/操作者；Invoice.status不被接收确认更改；done原含义保留且列表/详情读取真实done |
| 邮寄发货 | developer填写快递公司+可查件运单；闪送填写可用配送凭证；人工确认不生成承运轨迹；更正必须说明原因、追加审计、不新增提醒 |
| 通知 | 持久化去重任务、双worker锁领取、有限明确失败重试、UNKNOWN不重发；模板匹配与实际权限缺失被准确区分；实际微信触达未验证 |
| 商城导流 | 回执及详情提供逛逛budu和来自既有catalog在售接口的少量商品；商品加载/统计失败不妨碍服务；无新增优惠或会员条件 |
| 关联购买 | developer可按北京时间/门店/类型查看人数、7/30日订单/金额/退款/成熟期；全局先归因后筛选；可信PostgreSQL主支付链，legacy历史缺口明确展示 |
| 老入口/回滚 | H5原码仍可用；已绑定记录不可走旧ship接口旁路；关闭新提交后本人仍可查询/恢复原回执；增量数据不做down迁移 |
| 完整物流 | 未接入。现有trace_waybill需要真实微信交易，不适合无订单的线下服务；交付实际运单/凭证展示和复制，不虚构交易或轨迹 |
| 候选/材料 | 两端任务分支、OS构建、官方开发预览编译、隔离测试、独立复核、合成OS截图；官方模拟器启动失败、真机和真实联调未验证 |

## 数据、权限与接口

唯一业务事实：PostgreSQL `customer_service_requests` 联接原 `MailingRecord` / `Invoice`；不另造商城事实。新增 owner 四元组为服务端认证的 userId/appId/envId/openId，绑定仅在提交成功事务发生。手机/邮箱只是资料。员工仍使用既有登录及模块/门店权限；确认额外要求当前数据库里的活跃 developer，处理过程中重验，不能凭请求中的role。邮寄列表按门店过滤，旧ship接口拒绝所有已绑定服务申请。

顾客：orders云函数 `serviceCapabilities / serviceResolve / serviceSubmit / serviceList / serviceDetail / serviceVisitMall` → 固定HTTPS OS `/api/v2/customer/store-services/{capabilities,resolve,submit,list,detail,visit-mall}`。TEST独立前缀 `/api/v2/test-sc11a/customer/store-services`，固定TEST环境；生产固定原AppID/env。复用内存customerSession，同时验证网关HMAC、时间/nonce、防重放、sessionHash、可信context.OPENID与OS身份映射一致。任何前端userId/openId/role/storeKey都不能覆盖服务端身份。两环境不混用。

请求字段白名单：scene、requestId、type、cursor、payload（原表单字段）、subscription（本次选择，仅提示，绝非发送额度权威）。单请求体受限，云函数不提供任意host/path。列表20条游标分页且游标也校验所有者；顾客返回值不含内部操作者/通知诊断。静态消息路径为 `pages/store-service/detail?id=<申请ID>`，仍需本人认证。

员工 `/api/v2/customer-requests/service-capabilities`、`/:id/mini-code`、`/:id/service`、`/:id/confirm-shipment`、`/:id/correct-shipment`、`/:id/confirm-receipt`、`/conversion`。使用现有employee middleware及细粒度权限。统计仅developer。

二维码scene是服务端密钥派生的128位不可预测引用（32 hex），绑定环境与稳定申请ID；DB只存hash。同一申请重复生成保持同一码；更换密钥后不静默覆盖已发出的凭证，需原有显式重新生成流程。旧H5与新码消费同一个token，原两小时有效期保持。打开/刷新/订阅不消费。

## 通知可靠性与配置

独立状态：PENDING、SENDING、ACCEPTED（平台受理，非已读）、NO_PERMISSION、BLOCKED_CONFIG、FAILED、UNKNOWN。

确认事实、审计、通知任务同事务保存。唯一键包含申请、事件、版本、接收用户、渠道；App/env/OpenID锁定在申请及任务并发送前再次核对。`FOR UPDATE SKIP LOCKED`避免双worker重复领取。进程中断留下的SENDING超过60秒转UNKNOWN；发送超时/异常响应亦UNKNOWN，不自动重发。仅明确未发送的token失败等最多重试3次；不能宣称外部接口“恰好一次”。运单更正保留旧/新值、原因和操作者，不另发提醒。

| 配置名称 | 用途/默认 |
|---|---|
| STORE_SERVICE_RUNTIME_ENABLED | 默认0；挂载顾客服务路由，查询恢复期间必须保持1 |
| STORE_SERVICE_SUBMISSIONS_ENABLED | 默认0；新申请提交开关；本人已提交回执恢复不被关闭 |
| STORE_SERVICE_QR_ENABLED | 默认0；门店新二维码入口；与runtime、提交和配置联锁 |
| STORE_SERVICE_RELEASE_PATH_READY | 默认0；生产正式路径已核验发布后才可设1 |
| STORE_SERVICE_SEND_ENABLED | 默认0；持久任务后台发送开关，standby不启动 |
| STORE_SERVICE_TEMPLATE_CONFIG | 默认空对象；实际已选用且已核验语义/字段的模板元数据；不提供虚构模板ID |
| STORE_SERVICE_TEST_GATEWAY_SECRET | 仅TEST服务端/TEST orders函数私有配置；不得写入客户端/Git |
| SWEET_CARD_PRODUCTION_GATEWAY_SECRET及原密钥文件配置 | 复用既有生产签名和微信access_token权威，不另建token缓存 |

模板元数据结构：MAILING/INVOICE → id、semantic（SHIPMENT_CONFIRMED/INVOICE_RECEIVED）、verified、fields（实际字段名→允许的业务值）。字段类型/长度校验失败时不发送半成品。必须实际核验本账号模板，不能把开票成功模板配置为接收确认。

本轮已指定自有测试账号，昵称仅保留在本地交付记录。昵称不等于openid；需该账号用本候选真实扫码并完成订阅后获得可信身份与平台测试证据。未向任何真实账号发送消息。现有五个订单模板不证明适用于本任务；线下发货/开票接收模板匹配仍待核验。

## 统计口径及可复核样例

扫码和商城人数按事件日期、可信用户去重；成功提交按首次submittedAt及顾客去重。匿名访问未采集，显示“未采集”，不伪造人数。多门店/多申请先在全量合格申请中选支付前最近一次提交（相同时间按稳定ID排序），再筛门店/类型。同订单每个窗口只计一次。

窗口为 `(submittedAt, submittedAt + N天]`；7和30日各为累计值，不能相加；未足期申请单列。按北京时间筛日期，底层UTC毫秒比较；非法日期拒绝。微信付款使用已核验OnlineTender.providerSuccessAt，缺失不归因；纯卡用权威paidAt。只读PAID/PARTIALLY_REFUNDED/REFUNDED的真实结算，退款仅SETTLED且截至统计时点，金额单列不抵充新销售。

测试样例：同顾客10月1日门店A、10月2日门店B提交，10月9日支付，归门店B的精确7日边界；再多1ms排除7日、仍可进入30日；筛A也不能把订单重分给A。重复支付输入去重；回调到达晚但实际支付在提交前的订单排除；已结算退款单列。具有可核验服务前订单者标已有购买；CloudBase legacy历史未完整接入，其他顾客首次购买类型显示未知，首次人数null，不能宣称“首次为0”。

## 验证证据

| 验证 | 实际结果 |
|---|---|
| scripts/test-offline-service-review.mjs | 22/22通过：真实隔离PG/HTTP、并发、回滚、权限、通知、统计；日期修正另定向通过 |
| scripts/test-offline-service-contract.mjs | 9/9通过：真实MP模块→本机HTTP→PG，签名/身份、扫码适配/稳定scene、功能关闭回查、通知分类及统计；日期定向通过 |
| scripts/test-offline-service-migration.mjs | 1/1通过：90→91增量，旧记录不变；pg_dump/restore后14表计数和完整行摘要相等 |
| scripts/test-offline-service-staff.mjs | 9/9通过：员工真实PG/HTTP、门店隔离、角色确认及入口开关联锁 |
| 小程序相关测试 | 最终199/199通过，包括本任务、购物/结算客户端、订单、环境、门店、个人入口等；不代表实际付款 |
| OS构建/静态检查 | npm run build通过；Prisma validate、Node syntax及git diff检查通过 |
| OS新UI | 32个Chrome/WebKit用例通过，320/340/375/390/430/768/1280px；8张合成截图 |
| 旧UI兼容套件 | 18通过、6既有夹具/断言问题、1中断、17未运行；独立合成门店权威夹具补验H5/取消/旧发货通过；未伪称全量通过 |
| 官方开发工具 | 账号登录、官方preview编译成功；原生模拟器启动失败，未得到运行验收截图 |
| 真实微信/体验上传/真机 | 未验证/未完成。未提审发布。指定自有账号未完成本项目扫码订阅；不得将合成消息或预览编译称为全链路通过 |

独立审查者未主写业务代码，复核后无剩余已发现的阻断代码问题；已修复顾客内部字段暴露、二维码重复生成、历史done列表、模板缺失文案、首次未知口径、日期规范化。另由OS UI作者交叉审查后端并编写员工权限测试。真实平台/生产验收不属于该PASS范围。

复现：先使用本机专用隔离PostgreSQL（测试helper拒绝非loopback及生产DB名），再设置TEST_DATABASE_URL、OFFLINE_SERVICE_MP_REPO运行 `npm run test:offline-service`；执行环境若限制本机数据库端口需正常获得平台批准。UI：`npm run dev -- --host 127.0.0.1` 后打开 `/tests/offline-service-harness.html`，开票加 `?page=invoice`；该入口明确为合成UI，不是真实业务服务。小程序脚本/候选详情见对应仓库 `docs/checkpoints/2026-10-24-offline-to-mini-001.md`。

## 正式执行顺序与恢复

以下为待最终确认方案，不是已执行记录。

1. 先获本轮生产只读核查许可；核对实际SHA、当前两端线上代码、schema/migration ledger、一个权威Writer、容量/阈值、可用回退资产。若现网有新提交，只做明确兼容对齐，不能以本地基线覆盖。
2. 补齐既有隔离环境中的OS服务桥配置和TEST orders增量文件；不要改生产config.js或整包覆盖。核验账号可用模板、语义、实际字段和权限，完成指定自有账号扫码、拒订与同意订阅、两类回执与消息深链、跨账号拒绝、iPhone/iPad实机。当前未具备全链路验收证据。
3. 生产迁移前按现有正式部署工具做备份并验可恢复性；显式确认唯一新增迁移20261024120000_offline_store_services。先部署兼容后端、保持新入口/提交/发送关闭；执行应用实际只读DB探针及旧H5检查。禁止在启动时偷偷执行seed或新增业务写入。
4. 按现有签名桥发布流程仅增量部署orders的两个新模块和入口；保留已核验的生产config与所有非本任务云函数内容。不改payOrder/支付回调。
5. 基于准确候选SHA准备正式生产配置小程序包、核查分包预算与隐私说明；体验版上传、提审、发布逐项读取真实平台回执。本轮预览不是体验版上传/发布。
6. 小程序正式版本路径已核验可用后，才设RELEASE_PATH_READY并按灰度计划打开SUBMISSIONS、QR；模板/接收者/消息联调已验后再打开SEND。门店不得使用开发预览码。任何失败保持旧H5可用。
7. 上线后核对请求保存/归属、确认/通知任务、权限、应用DB查询、现网SHA及Writer；真实iPhone/iPad由用户验收，未通过前状态为“已上线，待用户实机验收”。

回滚优先关闭QR、SUBMISSIONS、SEND，保留RUNTIME及兼容后端的本人查询、幂等恢复、旧ship保护。保留第91迁移和全部新事实/审计/UNKNOWN任务，不执行down/drop、不恢复旧快照覆盖上线期间申请。**有新绑定申请后不得直接切回缺少归属/旧ship保护的旧后端**；若二进制必须替换，应使用保留上述兼容能力的恢复候选，并重新审查具体影响。SENDING/UNKNOWN不得因回滚自动重发；平台人工核对后如需额外触达应有具体授权。

本轮剩余集中确认：允许只读核验现网与账号模板；在真实隔离联调/用户验收证据完整后，再确认准确SHA、增量迁移、既有标准发布步骤、云函数增量更新、小程序提审发布和入口开关。当前不会请求用一个笼统“上线”跳过外部验证。

## 简明操作

- 门店：沿用邮寄/开票入口填写原业务上下文，生成对应码给顾客；开关关闭或小程序不可用时显式使用H5码。不得用开发码给正式顾客。
- 顾客：扫码、核对门店、填写并确认；订阅可拒绝；看到保存回执后可看详情或逛商城；后续在我的门店服务回查。姓名/手机号不会改变申请归属。
- 开发者：核对资料；邮寄填写真实可查运单或闪送凭证后确认；开票点击确认已收到，后续财务仍按原流程办理；查看发送状态，UNKNOWN不盲目重试。更正运单需原因且不会另发消息。关联购买面板为观察口径。

参考：用户指定的[微信订阅消息](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/subscribe-message.html)、[小程序码](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/qrcode-link/qr-code/getUnlimitedQRCode.html)等官方链接本轮工具直接访问失败；[腾讯云CloudBase说明](https://docs.cloudbase.net/recipes/add-subscribe-message-cloud-function)搜索返回支持订阅/错误分类信息。账号实际能力仍必须以真实平台核验为准，未据文档宣称权限已开通。
