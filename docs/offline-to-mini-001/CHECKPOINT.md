# budu 门店服务当前任务检查点

2026-10-26，Asia/Shanghai。**INTEGRATION_BLOCKED**。本页是当前恢复索引，旧阶段证据仍保留原日期/版本。

OS运行源码`4bdea23503844c4ad743005e90ae83b91b70f6b9`；小程序运行源码`fd26c8fc853b68d05d28478b2ef1142259035f46`。后续任务HEAD仅为脱敏文档，以fetch后git rev-parse取得，不能用旧提交覆盖现有工作区。分支均`codex/offline-to-mini-001`，保留其他任务修改。

已完成三模板适配：邮寄按服务端保存的顺丰/同城方式唯一选择，开票独立一个；请求订阅ID、保存ID、outbox及最终发送ID一致。配置变化不把旧accept转新授权，拒绝/取消/不可用不阻断表单、回执和本人回查。旧邮寄候选不进入新申请选择，未删除或全局替换模板/历史记录。

| 场景 | 精确字段映射 |
| --- | --- |
| 普通快递 | character_string5→完整trackingNo；thing20→carrier；thing13→固定发货提示；time9→shipmentConfirmedAt北京时间 |
| 同城闪送 | thing20→carrier；time9→shipmentConfirmedAt；thing13→固定发出/配送凭证提示。仍验证真实deliveryProof，详情展示，不编造运单 |
| 开票接收 | thing2→关联Invoice.companyName；amount3→关联amountCents整分；time4→原submittedAt；thing5→固定“申请已收到，待财务办理，请留意邮箱” |

长抬头消息摘要带省略号，完整税务原值/详情保留；未知类型明确拒绝，time独立校验。开票事件INVOICE_RECEIVED，不更新Invoice.status、不发邮件；接收者绑定提交申请顾客，收件人不自动成为通知对象。确认/审计/outbox同事务、幂等，更正不自动再提醒，UNKNOWN/SENDING不盲目重发。同店关联守卫已在详情/确认/发送三处校验。

消息formal/trial/developer与二维码release/trial/develop分别校验。74项消息定向、53项真实一次性PG/跨仓合同/员工权限、MP页面17+工具16通过；原失败与修复保留，不混为全仓回归。OS构建、新142文件TEST打包和官方列表预览通过；不是设备验收。独立源码复核PASS。实际账号三模板ID、标题和字段由微信只读接口核验匹配，实际ID仅在受控配置位置。

实际TEST后端`4bdea23503844c4ad743005e90ae83b91b70f6b9`。PASS：实际TEST新代码/三模板解析、应用DB、91账本和业务摘要前后匹配；SEND0。本轮没有远端业务数据写入或消息发送，旧通知未重排。具体私有运行/恢复对象留原受控receipt。

剩余阻断：用户已授权并报告origin设置更新，同一Chrome原TEST员工页仍被saved permission/managed policy拒绝；未绕过。新场景实际订阅→提交→OS确认→微信send受理→设备出现→本人详情均未完成，SEND0。需要实际放行工具origin权限及自有真实配送资料和指定自有账号设备；无需再提供模板。

iPad旧失败已定位到截图成功后的IDE automator/device身份RPC响应等待，默认10000ms；具体底层断连原因未定，无加时/重复扫码。新构建原生键盘/遮挡/长字段物理滚动/关闭弹窗/返回重入未运行。历史b93真实跨端和4e定点UI证据不改写为当前完整PASS；CloudBase旧故障日志主题缺失不推出零调用。

机器可读摘要见[acceptance-2026-10-26.json](acceptance-2026-10-26.json)。私有报告、模板ID/配置、身份、预览凭证和原始日志不入Git；不能从远端源码恢复易失RAM或未同步的私有材料。先fetch核对分支、状态、最新检查点和受控候选清单，不重启旧控制器或重发旧任务。

生产合并/迁移/部署/门店正式入口切换/提审/发布未执行，正式容量准入NOT_EVALUATED；发布顺序、fresh备份/恢复及最终批准范围仍按原边界处理。必要真实验收未完成前，总状态保持INTEGRATION_BLOCKED。
