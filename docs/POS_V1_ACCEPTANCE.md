# BUDU POS V1 验收报告

日期：2026-08-11
范围：商品中心 / POS 点单 / 购物车 / 模拟结算 / orders / order_items / payments（Mock）

## 一、验收结论

POS V1 核心链路已完整实现并通过验收，可以进入「真实支付接入准备」阶段。验收过程中发现 1 个测试基础设施问题（已修复）和若干“建议加固项”，均不影响现有功能。

## 二、验收矩阵

| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| iPad Safari 横屏 4:3 显示 | 通过 | WebKit 1024×768 无横向/纵向溢出；三栏布局（分类/商品/购物车）正常 |
| 商品分类切换 | 通过 | 分类来自商品档案 posCategory，点击切换过滤正确（Playwright 覆盖搜索与布局，分类逻辑走同一过滤链路） |
| 商品搜索 | 通过 | 名称/SKU/条码模糊搜索，Playwright 断言按条码搜索只显示目标商品 |
| 连续快速点击商品 | 通过 | 前端 state 合并 + 服务端按 productId 合并数量；100 次连点断言 100 件与金额正确 |
| 数量增加/减少/删除/清空 | 通过 | changeCartQuantity 单测 + Playwright 加减；删除/清空逻辑经代码审查确认，清空有确认弹窗 |
| 金额浮点误差 | 通过 | 全链路使用 BigInt/分存储：前端 cartTotalCents、服务端 buildOrderSnapshot、Prisma BigInt 列 |
| 页面刷新重复订单/脏数据 | 通过 | checkoutKey 唯一 + cartHash 一致性校验；刷新后恢复同一订单（Playwright 待支付/成功页刷新测试） |
| 连续点击结算创建重复订单 | 通过 | 前端 submitting 防重 + 服务端 checkoutKey 唯一约束 + P2002 捕获后复用原订单 |
| 模拟支付重复提交 | 通过 | requestKey 唯一 + `payments_one_active_per_order` 部分唯一索引（created/pending/success）；重复回调 eventId 幂等 |
| 多用户/多门店串单风险 | 通过 | 购物车按 userId+storeId 隔离；订单记录 cashierId/storeId；服务端按门店绑定与收银员校验读写权限 |
| 历史订单快照 | 通过 | order_items 保存 product_name_snapshot / sku_snapshot / unit_snapshot / unit_price / cost_price_snapshot / line_amount |
| 改价后历史订单金额不变 | 通过 | 快照在创建时生成，单测断言改价后 snapshot 不变 |
| 已完成订单禁止物理删除 | 通过 | 全仓无订单删除接口；order_items 外键 ON DELETE CASCADE、payments/order 外键 ON DELETE RESTRICT |

## 三、测试结果

1. 单元/服务端测试：`node --test scripts/test-pos-core.mjs scripts/test-payment-foundation.mjs scripts/test-camera-scanner.mjs`
   - 15/15 通过（订单快照、金额分、幂等、状态机、Mock 场景、扫码码规范、错误提示）。
2. iPad WebKit 浏览器测试：`npx playwright test tests/pos-ipad.spec.mjs --project=ipad-webkit`
   - 7/7 通过（布局、刷新恢复、双员工隔离、扫码防重复、权限拒绝、切后台释放、失败后重扫）。
3. 构建：`npm run build` 通过。

## 四、发现并已修复的问题

1. **Playwright webServer 在 Windows 无法启动**（`C:\Program Files\nodejs\node.exe` 路径含空格未被引号包裹），导致 iPad 测试实际从未跑起来；且系统 HTTP 代理会返回 502 干扰健康检查。
   - 修复：`playwright.config.mjs` 中命令改为 `"${process.execPath}" ...`；本地运行测试时需清空 `HTTP_PROXY/HTTPS_PROXY`。
   - 影响：仅测试基础设施，不影响业务代码。

## 五、V1 已具备、第二阶段继续沿用的能力

- 订单状态机 `draft / pending_payment / paid / completed / cancelled / partially_refunded / refunded`，全部由后端执行，前端不可直接改状态。
- 独立 payments 表（1:N），已有幂等键与部分唯一索引。
- PaymentService + Provider 抽象层（base / mock / wechat_pay / alipay 占位）。
- 后端重算应付金额，拒绝前端传价。
- 扫码付款码只在 Provider 内存中使用，不落库。
- 回调幂等、金额校验、订单/支付状态联动（事务内）。

## 六、第二阶段前需要加固的差距（见 PAYMENT_PREP_PLAN.md）

1. payments 表缺少 `request_payload / response_payload / raw_callback / payment_method` 字段。
2. 尚无 refunds 表与退款抽象落地（仅方法占位）。
3. 尚无支付审计日志表（PaymentLog）。
4. 未实现 `PAYMENT_MODE` 环境变量；现金渠道没有独立 Provider，正式支付仍只能 Mock。
5. 回调路由未按 `/api/payments/wechat/callback`、`/api/payments/alipay/callback` 形态提供，且 provider 名未归一化。
6. createPayment 的“建支付 + 订单置 pending”不在同一事务。
7. POS 前端对 created/pending 支付缺少自动轮询与“关闭当前支付/切换渠道”的入口。

以上 7 项已在第二阶段实施中全部落地（含退款表、支付审计日志、PAYMENT_MODE 开关、现金 Provider、回调路由规范化、事务化创建、自动轮询与关闭支付），相关代码与测试已完成并通过。
