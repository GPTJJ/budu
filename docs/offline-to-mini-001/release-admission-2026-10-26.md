# budu 发布容量与迁移准入检查点

2026-10-26，Asia/Shanghai。按本轮边界保留 **INTEGRATION_BLOCKED**；必要TEST产品验收已全部PASS。容量原阈值只读准入、发布工程隔离验证与独立工程复核均PASS。正式生产操作仍待具体授权，未执行。

冻结发布源：OS `e91561238b866284bb6621a57fc02926fba01ec8`；小程序 `e73a5d1e7261499c8f670556297a54c92367c873`。任务分支后续HEAD含工程/文档，不能换成运行源码或重建镜像。当前工程bundle `b94f0542ebf7b23408e19d1540e612a922b69a9fe7696ca62a74fd37f50c96c7`；合同 `df03b47067df795324c832f52f44d85c6669dd3771a06bba418326db2bfdd4b0`。

OCI `sha256:6704d3a8f8657c4aac6cf711651f8c430403179b72537fd425b108b56023cb05`；config `sha256:903b7e283d4f549f0588bddcf7e01f725512d2096bafc002e880d1a457202e9f`；586,725,888 B归档 `c67eb8858caedcbb4082d58355459c18bc235bbe3899ca0c31a9fa290d4323cb`；783项源码/dist树 `902b42bc670b8cab9e5b8c779f71c916a15b13edbf89df9ac8b07388e94d5043`。唯一新增 `20261024120000_offline_store_services` / `c9cfebd75e2f469f2389133374b3188da0865a67e4de9dc28ad7c8c970ec26b1`；原90条SQL及checksum全部保留，新增DDL与91账本同一事务。

## 容量与证据

只读预检时间 `2026-10-25T22:09:15.636413+00:00`，生产基线a86e150/PG16.14/完整90迁移/唯一应用Writer。可用13,789,687,808 B；允许新增3,052,269,568 B。实际Committed父链+mountinfo、逐blob SHA/stat/content-ref和物理snapshot extent证明21层共享信用2,197,857,167 B，额外init层零信用。Docker29.1.3及实际containerd2.2.1二进制与隔离演练一致。

| 阶段 | 新增峰值B | 结果 |
| --- | ---: | --- |
| 导入，保留343,955,852 B共享blob ingest暂存 | 2,275,674,267 | PASS |
| 完成导入全核验后仅释放本次新tar，再进入DB阶段 | 2,747,613,570 | PASS |
| 若DB阶段仍留新tar | 3,334,339,458 | FAIL |

原10GiB最低可用、90%占用、6GiB绝对峰值、768MiB归档及512MiB余量全部不变。最大预算余量304,655,998 B，预计最低可用11,042,074,238 B，向上取整87%。backup440,252,462 / restore828,150,853 / live WAL253,680,663 / migrator134,217,728 B仍是完整有界操作预算，不冒充生产测量或WAL物理quota；持续核对实际磁盘/WAL并超限停止。旧全量模型仍FAIL。

新profile明确绑定完整server/prisma/dist/deps、精确OCI及783源码；不套用旧dist/scripts-only thin路径，不声称旧B2 fixed-R Guard已执行。原protected core和clone helper字节未改。新profile逐阶段保留原累计peak账本，移除暂存文件不能抹掉历史峰值。

| 定向验证 | 结果 |
| --- | --- |
| 发布控制单测 | 38 PASS；五类route故障为真实控制流+确定性backend，非真实生产Nginx |
| 精确Linux导入/新归档释放 | PASS；21旧层hash/inode/extent不变，仅3新层；样本峰912,871,424 B不替代保守预算 |
| PG16.14真实原子迁移 | 6 PASS；失败与HUP/TERM/INT回滚终止、91成功、旧schema/事实不变、缺约束拒绝 |
| 同snapshot备份/恢复及故障 | 5 PASS；131表指纹一致、restore限额、dump磁盘/WAL及实际exporter中断均收尾 |
| 冻结ACTIVE兼容HTTP | 4 PASS；同PG91/783、SIGUSR2、本人签名POST回查、越权拒绝、关闭新业务入口、历史通知五状态不改 |
| 新profile实际clone | PASS；与生产label形态一致、原env/resource/mount/group0/440、standby0、同PG91和783、无持久PG客户端 |
| 生产只读profile preflight | PASS；精确G/PG/全90/schema/writer/route/backend及容量 |
| 生产fresh备份/恢复、迁移、部署、切换、提审发布 | NOT RUN，等具体授权 |

最初备份外层150秒客户端超时后控制器已完成PASS，从原落盘收据复用；其余本地fixture/注入/标签/负例映射错误全部保留且只补缺失项。没有放宽parity或业务保护。原业务三模板/真实消息/iPhone/iPad及长文本拒绝路径均复用PASS，本轮没有扫码、发送或重复设备验收；TEST全局SEND=0。

## 执行顺序和授权边界

原现场fresh Gate → 新锁和唯一新目录/精确归档导入 → 完成hash、load wait、OCI和snapshot/ingest全核验后，只移除新建 `/opt/budu/.rollback-assets/offline-to-mini-001-e91561238b86/exact-e.tar` → E standby五开关0/真实应用DB读 → 停旧G并证零应用Writer → 同exported snapshot备份、PG16.14 network-none隔离恢复且指纹一致/会话与恢复容器均终止 → 单事务90→91 → 完整91/旧schema/固定新catalog/容量核验 → E唯一Writer ACTIVE → 原三路由/Nginx及pointer切换，保留旧G、镜像和备份。维护窗口是必须项，不承诺无停机；snapshot helper整体600秒、SQL lock2秒/statement30秒及有界cleanup。

新文件删除必须包含在最终授权中，当前既有生产资产删除数0。52镜像/64volumes/cache0，三份旧tar物理合计1,706,799,104 B但仍有关联历史镜像容器，未证明可安全删除，未纳入信用。无需现有资产清理或付费扩容；未知volume RefCount0不是安全结论。

OS技术切换服务全0 → 单独获准的生产orders函数e73a增量 → 从同源既有脚本显式PRODUCTION独立打包 → 绑定实际后台版本/上传提审发布 → 正式路径/身份核验 → RUNTIME和三模板就绪，先回查 → 获准小流量分发后启新提交/QR → 队列/授权/AppID/env/template/event/status核对 → 最后SEND。现有开关全局，人工分发不是门店服务端白名单。不得上传TEST目录、凭旧状态猜后台版本，或把push当生产授权。

90失败必须证明exporter/dump/restore/migrator均终止才恢复准确旧G；未知状态保留锁。91未开入口可同精确E恢复普通流程、新服务全0。已有新申请后只走另外准确绑定的ACTIVE91兼容恢复：RUNTIME1，SUB/QR/SEND0，保留本人POST回查/业务记录/审计/通知事实，不down迁移或以旧dump覆盖新事实，不自动重发UNKNOWN/SENDING/ACCEPTED。此模式不是所有模块只读。未知路由不覆盖；已知两文件original/next组合可受控修复，失败锁仍保留。

同盘snapshot备份未证明post-backup完整WAL归档链，不承诺新写后的灾难恢复RPO0。灾难恢复、旧资产清理、扩容、付费配送、主分支合并仍不包含在本轮执行范围。

最终计划hash `8180fd796d824f6cb7e4975ca518ea658541d0010410c41eab800f96d2538391`；实际只读预检绑定draft `30a7bf27fc0325941ceac648e69f0069dbf931f1e67eb736e539439da5191cea`，final只增加review/验证行政字段，所有资源与身份语义未变。私有final-plan-derivation.json记录派生关系；生产执行仍fresh Gate。独立工程收据hash `f21d9a02246f8378fb30674cc6318ed1b198ee32e58843247f77c14d58525d3a`。准确后续两端HEAD以本检查点所在提交及fetch后Git为准；受控配置/身份/归档/预览凭证只留原私有位置。

最终计划8180的实际只读preflight已于2026-10-25T22:09:15.636413+00:00通过（无authorize参数）。最新允许新增3,052,269,568 B、峰2,747,613,570 B、余304,655,998 B；原draft预检与派生记录继续保留。最终计划中的capacityGate是生成时的历史观测，现场动态容量以此新收据及将来执行前fresh Gate为准。生产执行仍未发生。
