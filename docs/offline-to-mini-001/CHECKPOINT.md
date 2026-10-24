# budu 门店服务小程序候选检查点

任务 BUDU-OFFLINE-TO-MINI-001；2026-10-24 北京时间。状态：INTEGRATION_BLOCKED；本地代码/验证/独立复核完成，未上线。

- 完整本轮授权来源：用户粘贴指令；开发、隔离迁移/恢复、测试、私有候选已授权；生产迁移、入口切换、提审发布未授权。
- 原 OS: 用户原OS工作区，recovery-20261008，29ed604，已有不属本任务的 PosOffer 修改，未改动。
- 隔离 OS: /private/tmp/budu-offline-to-mini-001/os，codex/offline-to-mini-001，基线 origin/codex/purchase-return-supplier-select a86e150。
- 原 MP: 用户原小程序工作区，main 6231207，干净。
- 隔离 MP: /private/tmp/budu-offline-to-mini-001/budu-miniprogram，同名任务分支，基线 origin/codex/store-pickup-001-release ce85937。
- 本机新建 PostgreSQL，仅 loopback 55436，数据目录 /private/tmp/budu-offline-to-mini-001/pgdata。仅合成资料；测试 helper 每次创建/销毁自己命名的 disposable database；不使用现有数据卷。
- 原二维码两小时一次性；同一 token 行锁协调 H5/小程序竞争。小程序 scene HMAC 派生128位引用，仅hash入库，重试生成不失效；成功事务绑定可信session+context身份，原H5/历史数据不按电话认领。
- 已添加增量 migration 20261024120000_offline_store_services；原90→91，仅新增字段/表/索引。
- 后端源码 server/store-service-{core,api,notifications,conversion}.js；扩展 customer-requests / app / index / v2。
- MP原生服务页、orders桥及OS页面由独立作者实现；独立测试/审查者不主写业务代码。
- 用户指定本项目自有测试账号（昵称仅本地记录）；尚无该账号本项目真实订阅/触达凭据，不能凭昵称猜测openid。
- 自动审批拒绝公开生产 /api/health GET：理由为本轮不包含生产连接。停止该路，未换方式访问；实际生产SHA/容量/迁移/Writer未核验，最后集中申请只读核查。
- 平台工具：无CloudBase connector；微信开发工具登录成功，最终隔离开发包官方预览编译通过（主包1754681B、服务分包24645B）；模拟器launch failed；匹配的开票接收/线下发货模板未核验，未真实发送。
- 回归结果：独立PG/HTTP首轮22/22，另跨仓HTTP/消息分类/统计9/9；MP最终199/199；OS前端build成功及新UI32例已过；员工权限9/9；90→91迁移及14表备份恢复通过。后续按实际修复定向复核，最终报告应引用最终结果。
- 剩余：真实隔离远端联调、实际匹配模板和指定自有账号真实订阅/微信触达、官方模拟器/真机验收；生产只读核查需解除审批限制，生产迁移/发布另行最终确认。准确提交/产物清单见交付目录candidate-manifest.json。
