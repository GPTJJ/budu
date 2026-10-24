# budu 门店服务小程序候选检查点

任务 BUDU-OFFLINE-TO-MINI-001；2026-10-24 北京时间。状态：INTEGRATION_BLOCKED；本地代码/验证/独立复核完成，未上线。

- 完整本轮授权来源：用户粘贴指令；开发、隔离迁移/恢复、测试、私有候选已授权；生产迁移、入口切换、提审发布未授权。
- 原 OS: 用户原OS工作区，recovery-20261008，29ed604，已有不属本任务的 PosOffer 修改，未改动。
- 隔离 OS: 本任务持久worktree，codex/offline-to-mini-001，基线 origin/codex/purchase-return-supplier-select a86e150；准确位置见私有candidate-manifest.json。
- 原 MP: 用户原小程序工作区，main 6231207，干净。
- 隔离 MP: 与OS同级的本任务持久worktree，同名任务分支，基线 origin/codex/store-pickup-001-release ce85937。
- 本机新建 PostgreSQL，仅 loopback 55436，数据目录 /private/tmp/budu-offline-to-mini-001/pgdata。仅合成资料；测试 helper 每次创建/销毁自己命名的 disposable database；不使用现有数据卷。
- 原二维码两小时一次性；同一 token 行锁协调 H5/小程序竞争。小程序 scene HMAC 派生128位引用，仅hash入库，重试生成不失效；成功事务绑定可信session+context身份，原H5/历史数据不按电话认领。
- 已添加增量 migration 20261024120000_offline_store_services；原90→91，仅新增字段/表/索引。
- 后端源码 server/store-service-{core,api,notifications,conversion}.js；扩展 customer-requests / app / index / v2。
- MP原生服务页、orders桥及OS页面由独立作者实现；独立测试/审查者不主写业务代码。
- 用户指定本项目自有测试账号（昵称仅本地记录）；尚无该账号本项目真实订阅/触达凭据，不能凭昵称猜测openid。
- 初期生产只读访问因授权不足被拒绝，未绕过；后续用户明确补充只读授权，生产完整SHA与a86e150基线、90条迁移账本、唯一Writer及实际应用DB均已核验。容量仅完成现状测量，不代表本次发布容量PASS；私有收据记录完整事实。
- 平台工具：无CloudBase connector；微信开发工具登录成功，最终隔离开发包官方预览编译通过（主包1754681B、服务分包24645B）；模拟器launch failed；匹配的开票接收/线下发货模板未核验，未真实发送。
- 回归结果：独立PG/HTTP首轮22/22，最终跨仓HTTP/前缀转换/runtime挂载/消息分类/统计15/15；MP既有199/199；OS新build成功及既有新UI32例已过；员工权限9/9；90→91迁移及14表备份恢复通过。生产桥/旧登录相关26项通过，另1项基线甜意卡展示断言冲突保留失败记录，未改业务或删测。
- TEST路径修复：既有Nginx把公网test-sc11a前缀替为/api；仅OS TEST挂载改为内部路径，六条精确Map重建公网验签路径，保留生产、身份、时间窗、nonce及HMAC保护。新测试先在旧代码复现失败，修复后通过；Nginx、小程序、生产配置未变。
- 剩余：远端TEST仍缺本任务模块/签名配置/运行开关，CloudBase配置与部署模块未核验；实际模板待用户提供，真实订阅/微信触达及设备验收未完成。生产迁移/部署/提审发布未执行，不能把本地候选通过称为远端联通。准确本地提交/产物清单见交付目录candidate-manifest.json。
