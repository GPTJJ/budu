# 发货核对三项整改：本地隔离候选

本候选供父级独立审查，未提交、未 push、未 dispatch、未部署、未迁移生产。

## 身份与基线

- 主机实测：`灰太狼大王の黑巧酥山💻`；登录用户 `apple`。
- 仓库：`/Users/apple/Documents/Codex/2026-10-01/task-10/budu-shipping-candidate`。
- Origin：`https://github.com/GPTJJ/budu.git`。
- HEAD：detached `68cee84efe30409e7e18e4459e08982f6c20e254`，无候选提交、无 upstream。
- Git 对象已完整 repack 并移除初始 shared alternates；依赖也为本候选独立副本。
- 本次只读核实 `/opt/budu/.current-sha` 为上述完整 SHA，public health `ok=true, dbOk=true, env=prod, gitSha=68cee84efe30`。
- 当前生产 `TransferItem` COUNT=444，新约束范围不合法 COUNT=0。只查询聚合，不读订单明细或修改数据。
- 父级此前正式发布验收证据：`task-12/budu-report-revision/output/formal-E-20261001/post-acceptance.json`；生产迁移85、writer1等完整事实沿用该记录，未在本任务重复全量核验。

## 最小变更

1. 门店调拨：界面加号和输入可突破申请量；UI/服务端一致保留0～999999整数。普通件数、箱、颗仍分别保存。缺失物理单位必须为0，不能追加未申请单位。申请量不覆盖，实发事实独立保存；至少一项正数，单项0沿既有不发语义，全0继续拒绝且仍待备货。既有角色、状态CAS、一次实发与通知逻辑不改。门店发货用同步ref阻止重复点击；每次打开/关闭递增会话序号，旧提交返回只刷新发货事实，不能关闭重开的核对层或清除其草稿/错误。
2. 必要迁移：新 `20261002000000_transfer_actual_quantity_reference` 只替换 `TransferItem_shippedQuantity_valid`，允许NULL或0～999999。不改历史迁移、模型字段、单位唯一约束、历史数量/状态。未在生产执行。
3. 合作商发货：首次打开按服务端 `remainingQuantityBase` 预填；缺失时用批准量减已发量，数量单位继续用既有整数基本单位（KG输入整数克）。同单刷新不重置草稿，换单使用key初始化，关闭后重开读取新剩余。请求序号排除乱序与关闭后的迟到详情；旧单提交迟到成功也不能关闭新会话。仍显式确认，零行不提交，保持服务端剩余量、角色、Serializable和幂等校验；未放开合作商超订单。
4. 合作商档案：只删除一个操作审计展示区块和对应History图标引用；后台审计服务、存储、权限及其他审计页面均未修改。

既有门店调拨合同为待备货→已发货，无收货确认、无库存校验/扣减/预留；合作商物流也只记录履约事实。本次由父级明确确认保留，不能把此入口描述为库存不足会拒绝。隔离测试的库存哨兵保持0，未新增或绕过库存逻辑。

## 本地验证

| 范围 | 结果 | 原始证据 |
| --- | --- | --- |
| WebKit + Chromium，门店/合作商发货/档案/邮寄 | 本轮 134 PASS，零跳过 | `output/shipping-review/revision-ui-final.log` |
| 调拨草稿、导出、投递展示、账号权限、合作商发货服务及PGlite HTTP | 本轮 52 PASS（46领域+6HTTP） | `output/shipping-review/revision-domain.log` |
| 原生Prisma/PostgreSQL CAS及完整箱颗工作流 | 本轮 61 PASS（60CAS+1完整工作流），零跳过 | `output/shipping-review/revision-native-pg.log` |
| 原生PostgreSQL完整迁移与真实v2 HTTP演练 | 本轮8组PASS；85→86迁移，118表指纹一致 | `output/shipping-review/revision-native-rehearsal.{mjs,json,log}` |
| 生产构建 | 本轮PASS | `output/shipping-review/revision-build.log` |
| 32张实际WebKit截图，8宽度溢出/pageerror/审计残留检查 | 本轮PASS；另有4张迟到响应截图 | `output/playwright/visual-checks.json`、`store-late-response-repaired-*.png` |
| 工资POS来源、自然月、正式报告revision/父审与邮件阻断机制 | 首轮28 PASS，本轮未重复 | `output/shipping-review/output-payroll-regression.log` |

UI覆盖320/340/375/390/430、768、1024横屏、1440。32张宽度截图已在本轮重新生成；另4张覆盖取消/右上角关闭后重开的编辑，在WebKit与Chromium确认旧响应返回后草稿2仍在、已提交的实际6和申请4仍分别保存、POST只有一次。36张均查看实际像素。确认区可达，无横向溢出和审计区残留；浏览器仿真不冒充实体设备系统键盘验收。

数量覆盖申请4→实发2/4/6、999999、箱颗超申请、单项0、全0、负数、小数、空值、NULL、缺项、越界、未申请货品/单位、重复提交、已有实发冲突事务回滚及角色拒绝。合作商覆盖全部商品预填、部分发货扣已发、零剩余禁用、只改单项、取消重开、刷新保留、切单、乱序/迟到响应、迟到提交成功、客户端非法数量及服务器并发拒绝。实际生产未创建调拨、发货、通知或发送邮件。

## 复审修订与原生环境纠正

- R1：`test-transfer-box-piece-workflow.mjs`第二笔混合调拨fixture原先缺少必填name；已补`product.name`，并先断言创建成功及request.id后才继续发货。保留全0、实发箱颗、正式存储行和通知数量全部断言，没有跳过或降低门。完整原生套件已实跑61 PASS。
- N1：门店发货也加入与合作商相同目的的会话保护。回归步骤是提交6→保持响应→取消或右上角关闭→重开默认4→编辑2→释放旧响应。两浏览器四项均断言新弹窗/草稿仍在、提交仅一次，确认旧请求实际6落库。服务器当前状态及CAS继续权威判定。
- N2：复审提出的合作商缺失remaining字段兼容分支提示未扩展。本次真实服务端DTO始终返回remainingQuantityBase；当前订单上限仍按此权威字段，不改变合作商规则。

首轮localhost:5432不可用，60项原生断言未进入业务流程，日志保留为`output-native-pg.log`。首轮工具查找未覆盖npm缓存，原“本机没有现成原生工具”结论已撤回。复审发现的既有工具位于`/Users/apple/.npm/_npx/95566f1e575febeb/node_modules/@embedded-postgres/darwin-arm64/native/bin`，版本PostgreSQL18.3；本轮仅复用它，没有安装、系统服务或生产连接。

本轮用mktemp私有目录，实例只监听127.0.0.1:55439；执行命令从`env -i`开始，只保留PATH、HOME、TMPDIR和test环境，TEST_DATABASE_URL明确指向本机。两原生套件及迁移演练各自创建exact disposable database并应用真实Prisma迁移。演练脚本重新绑定当前候选根，未复用复审旧快照的PASS。旧CHECK拒绝申请4实发6；新CHECK允许NULL/0～999999、物理单位唯一性不变。85→86迁移前后118表数据指纹一致（合成非空历史表为Store、InventoryItem、TransferRequest、TransferItem，其余为空），证明这些隔离事实未被改写，不代表生产备份或生产全量核验。

原生HTTP少/等/多/极值、非法值、全0、箱颗与未申请单位、sender权限、重复CAS和已有行冲突回滚均通过；不兼容恢复旧CHECK原子失败，实发6事实及新约束保留。内部通知计数由既有CAS/工作流套件验证；通知仍位于业务事务之后，未宣称外部投递成功或与发货事务原子提交。

清理时本机实例仅剩postgres/template0/template1，全部测试库已DROP；pg_ctl已停止对应私有集群并删除mktemp目录。证据`revision-pg-cleanup.json`、`revision-pg-server.log`、`revision-pg-init.log`。本轮原生PG版本未与生产重新匹配；未来正式迁移门仍需按runbook验证生产版本、备份、ledger及单writer。

领域首轮修订复跑有一次sandbox listen EPERM，在业务HTTP断言前失败，保留`revision-domain-attempt-sandbox.log`；获准本机临时监听后同命令52项全部通过，未把环境失败计为PASS。

## 预览与复跑

当前仅127.0.0.1 Vite 5199，工具session4008。验收入口：
`http://127.0.0.1:5199/tests/shipping-review-preview.html`。

入口明确标记本地mock，所有业务接口由浏览器内fixture拦截；刷新恢复模拟订单。

```sh
node --test scripts/test-transfer-quantity-reference.mjs scripts/test-store-transfer-draft.mjs scripts/test-partner-replenishment-gate6.mjs scripts/test-transfer-summary-export.mjs scripts/test-transfer-delivery-recipients.mjs scripts/test-account-permissions.mjs
node --test scripts/test-payroll-pos-sales-authority.mjs scripts/test-payroll-natural-month.mjs scripts/test-payroll-audit-revision-cli.mjs
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5199 --strictPort
node node_modules/@playwright/test/cli.js test --config=playwright.shipping.config.mjs
npm run build
```

原生复跑需新建短期loopback集群；本轮55439已停止，不能把它当现存服务。对新的临时目标使用清空环境的命令：

```sh
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$HOME" TMPDIR="$TMPDIR" APP_ENV=test NODE_ENV=test TEST_DATABASE_URL=postgresql://apple@127.0.0.1:55439/postgres node --test scripts/test-transfer-lifecycle-cas.mjs scripts/test-transfer-box-piece-workflow.mjs
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$HOME" TMPDIR="$TMPDIR" APP_ENV=test NODE_ENV=test TEST_DATABASE_URL=postgresql://apple@127.0.0.1:55439/postgres node output/shipping-review/revision-native-rehearsal.mjs
```

代码与测试完整patch、逐文件SHA256清单位于 `output/shipping-review/`；输出日志、截图和本地依赖不在patch内。三张Library参考已本机materialize并看实际像素，保留在任务根 `references/`。

## 发布与回滚边界

等待同一独立reviewer复审；作者测试通过不等于复审通过。未来真实迁移及上线仍需用户知情批准。本候选没有触碰工资/邮寄实现、定时配置、邮件配置、生产权限或共享工作树。

出现超申请实发事实后，不能直接恢复旧 `shippedQuantity<=quantity` CHECK；会校验失败，且不得删除或修改真实实发事实凑回滚。优先只回滚兼容的应用版本并保留新非负范围约束；旧应用可读取既有申请/实发字段，后续发货重新受其旧限制。若必须恢复旧DB约束，先只读证明没有超申请事实，再由独立审查和用户授权决定。禁止自动DB降级。

全部业务改动仍未提交，只在这台机器可恢复；没有远端候选。原工作区未知改动保留且未纳入此候选。不要因本地PASS自行发布，交父级独立review。
