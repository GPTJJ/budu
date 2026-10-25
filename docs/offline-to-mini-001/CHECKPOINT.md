# budu 门店服务最终 TEST 检查点

2026-10-26，Asia/Shanghai。**INTEGRATION_BLOCKED**。本页是最新恢复索引；此前阶段保留原版本和结果。

OS实现 `4bdea23503844c4ad743005e90ae83b91b70f6b9`；小程序实现 `fd26c8fc853b68d05d28478b2ef1142259035f46`。本轮无应用源码、依赖或迁移变更；后续任务HEAD为脱敏证据文档提交，以fetch后准确HEAD为准，不用旧版本覆盖工作区。分支均 `codex/offline-to-mini-001`，其他任务改动保留。

| 场景 | 实际订阅 / 提交 | 正常OS确认 | 微信平台 | 设备收件并进入本人详情 |
| --- | --- | --- | --- | --- |
| INVOICE | accept / PASS | PASS | PASS_ERRCODE_0 | PASS_DIRECT_HUMAN_REPORT |
| MAILING_EXPRESS | accept / PASS | PASS | PASS_ERRCODE_0 | PASS_DIRECT_HUMAN_REPORT |
| MAILING_FLASH | accept / PASS | BLOCKED_MISSING_REAL_PROOF | NOT_RUN | NOT_RUN |

消息映射：普通快递 character_string5=完整真实运单、thing20=实际承运公司、thing13=固定提示、time9=真实确认时间；闪送 thing20/time9/thing13，不含运单字段，真实配送凭证仍必填；开票 thing2=实际关联抬头、amount3=整分金额、time4=原提交时间北京时间、thing5=固定收到申请说明。三模板按服务端保存业务及配送方式唯一选择。拒绝/不可用不阻断保存或本人回查，旧accept不迁成新授权，旧模板不全局替换。

开票只确认公司收到申请，发票仍待开具，不发邮件。实际发送验证长抬头20字带省略号、￥1.23及原提交时间跨北京时间日界；完整业务原值保留。普通快递真实完整运单进入请求体，不截断。消息 formal/trial/developer 与二维码 release/trial/develop 分开，正式版映射沿用74项定向检查。

当前两设备本人列表、收到状态、返回重入、商城图片人工通过。iPhone开票与邮寄原生键盘/常规填写/底部勾选提交人工通过；iPad状态：PASS_MANUAL_INVOICE_AND_MAILING_NATIVE_KEYBOARD_NORMAL_FIXTURE_SUBMIT_REENTRY。服务端实际邮寄地址14/17字、备注为空，iPad开票备注也为空，本轮长文本物理压力NOT RUN。旧190字地址/140字备注实机SDK渲染及滚动证据，与当前完全相同的WXML/WXSS/validator可作有限回归复用，不能冒充本轮长文本手指操作。拒绝订阅：NOT_RUN_NATIVE_REJECTION_SELECTION_NOT_PRESENT_OR_PROMPT_NOT_SHOWN，实际仍记录accept，未发送该额外开票通知。物理双击与强制过期重登本轮未新测；既有SDK证据、当前真实本地PG幂等/权限测试分列，不冒充本轮物理操作。

本轮复用无源码变化的74消息、53真实本地PG/合同/员工权限、33小程序定向测试；新增10项真实一次性本地PG单次通知隔离测试通过。独立复核固定TEST容器/数据库/源码、可信自有账号身份、精确本轮申请和实际sender/restricted fetch。全局SEND始终0，单次发送仅处理当前申请，4条历史BLOCKED_CONFIG、已受理任务及UNKNOWN/SENDING均未重排。平台受理与人工设备收件分列。

员工Browser Use最后一次仍被saved permission/managed policy拒绝，未换端口、来源或员工API绕过。人工通过正常Chrome完成创建和确认，并由服务器证据核对。iPad历史超时位于截图成功后的IDE身份RPC匹配响应等待层；底层断连原因未定，人工业务通过不代表自动化已修复，没有增加超时或重复无变化扫码。

仅本地PRODUCTION前端包142文件通过，未连接正式编译/预览/上传。只读生产a86e150/90迁移/唯一Writer正常，候选仅增20261024120000_offline_store_services；没有正式迁移/备份或部署。正式容量、fresh备份/隔离恢复及本任务90→91精确SHA发布合同仍须完成并受最终授权约束。没有合并主分支、门店入口切换、提审或发布。

本轮仍缺真实闪送配送凭证及实际服务方，不能确认发出或发送通知；真实拒绝订阅、当前物理长文本压力也未完成。闪送可继续从既有TEST申请办理；因已提交资料不可改写，补长文本/拒绝验收需要新的隔离TEST申请和物理操作，不改已保存事实。无需重新建立模板或重做已通过功能。私密配置、模板ID、稳定身份、业务资料、运单、预览凭证和原始日志留原受控位置，不入Git。详情见机器可读脱敏摘要；远端Git不包含本机私有材料或RAM状态。

[脱敏验收摘要](acceptance-final-test-2026-10-26.json)。
