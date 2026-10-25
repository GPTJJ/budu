# budu 门店服务小程序任务检查点

任务 BUDU-OFFLINE-TO-MINI-001；2026-10-25，北京时间。状态 **INTEGRATION_BLOCKED**。本文件替换初始检查点中的当前状态；历史事实仍由 Git 保留。

## 版本与恢复

- 仓库 GPTJJ/budu，分支 `codex/offline-to-mini-001`；本次实现提交 `896f03d697e7363b3caec4f8f735158484e0d899`，父基准425aad2f21f859e3c74ac077898954c11246343c。本检查点是后续文档提交，准确文档HEAD用fetch后的 `git rev-parse HEAD` 取得。
- 配套小程序运行代码 `4e10963cec70a31db0477c18e3d100183e266257`；原b93跨端设备证据与4e定点UI证据分别保留。本轮小程序仅同步交接文档，未改运行源码或重新生成预览。
- 先fetch核对同名远端引用与本地状态；保留其他任务改动，不reset/stash/clean，不用旧快照覆盖别人新提交。
- Git可恢复代码和本脱敏摘要。私密配置、测试身份、原始收据和预览凭证仍在原受控交付目录，未入库；另一台设备不能从Git恢复这些材料、本机未提交文件或易失RAM。不要从历史扫码回复重启控制器。

## 本次修复与验证

| 项目 | 状态 | 结果/步骤 |
| --- | --- | --- |
| 订阅消息正式版参数 | PASS | sender默认及允许值改formal；实际runtime production→formal，TEST→developer；最终provider请求体完整断言 |
| 二维码参数 | PASS | 单独保留env_version=release/develop，正式路径未就绪仍拒绝；未批量替换release |
| 定向请求体/字段测试 | PASS | node --test scripts/test-store-service-message-versions.mjs，17/17；合成fetch，不是真实平台消息 |
| 实际隔离PG | PASS | test-offline-service-review.mjs 23/23、test-offline-service-contract.mjs 15/15；新建loopback专用集群，各自销毁disposable数据库并停止集群 |
| 闪送仅凭证 | PASS | 真实隔离PG允许trackingNo=null、凭证单独回显；不编造单号、不把配送说明塞入运单字段。兼容字段模板可构建消息；必填单号模板缺值则发送前拒绝 |
| 构建与源码检查 | PASS | npm run build、git diff --check；只修2个发送版本选择点及相关测试，没有迁移或权限/路径放宽 |
| 独立源码审查 | PASS | 源码、最终body断言、实际PG日志和本轮失败边界已只读复核；只认可已证范围 |

官方参数对照：[订阅消息](https://docs.cloudbase.net/en/recipes/add-subscribe-message-cloud-function)使用formal/trial/developer，[小程序码](https://docs.cloudbase.net/recipes/add-share-with-params-miniprogram)使用release/trial/develop。微信原API页工具直读失败保留；这些规则不证明本账号模板或权限可用。

17项定向集合是在初次16项复现之后补入闪送测试的最终集合。初次PG新增夹具留下PENDING事件，干扰后续全局worker计数，已让夹具通过合成provider消费自己的事件；只重跑受影响的23项，15项合同未重跑。初次失败保留，不冒充真实消息发送。

## 远端与设备证据边界

此前真实TEST已完成原142文件iPad邮寄/iPhone开票的长表单、SDK原控件勾选/双击、保存、OS确认、回查和商城；并非本机HTTP替代。最终4e修复了勾选后旧提示残留；两设备状态/前后图有证据，iPhone定点5步通过，iPad最后截图后的身份回读超时，不能写整套通过。设备为历史实读iPhone 15 Pro Max/iOS27.2、iPad mini6 Wi-Fi/iOS26.6.2，微信8.0.79/基础库3.17.5；本轮没有新的物理设备验收。

本轮定位：失败调用为App.callWxMethod设备身份回读，截图已返回；SDK不构造此timeout，安装IDE的automator bridge等待匹配响应默认10000ms，随后remote connection_lost路径拒绝待回调。该失败操作没有调用CloudBase/OS；没有全链路抓包，两个身份原生方法中究竟哪一个未返回未留存。底层断连原因和稳定性仍BLOCKED，没有增加超时、重试或改业务代码掩盖。

CloudBase本轮只读核对固定TEST orders身份成功，但当前日志服务未配置主题，未取得故障窗口日志；未开通服务、未调用业务函数，不能推断当时零请求。旧GetFunctionLogs接口在已安装SDK中已废弃，没有调用它冒充日志查询。

TEST配置只读新查：两类模板均未配置，SEND=0；它不证明微信账号没有模板。账号实际templateId/标题/类目/场景/完整关键词类型与限制仍BLOCKED。模板站点先前安全限制记录保留。本次TEST员工页面先被Browser Use origin approval拒绝；用户随后已在聊天重新授权，同一窗口重试仍被保存的权限设置或管理策略拒绝。没有换浏览器、CDP、HTTP员工动作等绕过。OS确认后微信实际收件和本人深链、真实同意/拒绝、原生键盘/遮挡/物理滚动、原码直达等仍BLOCKED或NOT RUN。

实际TEST运行时仍为425aad2，91迁移（旧业务收据时间明确保留）；新896参数修复未部署。开票只表示公司收到申请，Invoice仍由财务办理，以顾客邮箱实际收到为准。收件人手机号不自动成为通知对象。所有本轮测试为合成资料，没有向真实顾客外联。

## 下一步与边界

1. 用户将提供微信公众平台“我的模板”列表及所选模板完整详情截图；Codex从图中识别完整ID、标题、类型、类目/场景和全部关键词，负责查官方文档核验格式/长度等技术规则。仅截图缺失或不清楚的信息集中指出，不要求用户手工整理技术规则；公共模板tid/示例不能代替实际选用资料。
2. 用户已重新授权访问既有TEST员工页面；需实际解除该origin已保存的拒绝设置或管理策略后，工具才能接续。不要重复索要同一口头授权，不走替代路线。
3. 准备有效TEST入口，使用用户指定自有账号，人工补两设备原生键盘/表单/返回状态；模板核对后按“扫码→订阅选择→提交→OS确认→平台受理→设备实际收件→本人正确详情”逐项记证。平台受理不代替实际收件，拒绝不阻断提交/回查。旧BLOCKED/SENDING/UNKNOWN不自动重排。
4. 所有必要验收通过才修改总状态。生产合并/迁移/部署/门店入口切换/提审发布均未执行，仍需既有具体批准。容量/恢复与新基线须正式发布前再核验。

机器可读脱敏证据摘要见 [acceptance-2026-10-25.json](acceptance-2026-10-25.json)，包含本轮私有证据摘要和精确实现提交。私有报告、具体发布/容量/恢复对象与原始证据仍留原位置，未当作生产现状或通过证明。
