# Transfer CAS Release Engineering Gate

2026-09-26，RELEASE ENGINEERING ONLY。本次新增专用发布工具、离线测试和本checkpoint；未执行生产发布。本文件的提交为 RELEASE_ENGINEERING_SHA，可用 `git log -1 --format=%H -- docs/checkpoints/2026-09-26-transfer-cas-release.md` 取得完整值，最终交接另记录完整SHA，避免自引用。

**工程验收结论：READY_FOR_DEPLOY_AUTHORIZATION（只代表此受限发布流程可进入下一授权 Gate，不是部署许可，也不是最终image已经构建/验收）。**

## Identity / scope — Gates 0, 2, 3, 4, 11

| 字段 | 值 |
| --- | --- |
| CURRENT_PRODUCTION_SHA / EXPECTED_OLD_SHA / ROLLBACK_SHA | `fc57da5a6e6611c66ed1db286336dc0e1752d69c` |
| TRANSFER_RUNTIME_SHA / RUNTIME_SHA | `8381959e9c1d527c1f14c234338b14d117ae46f5` |
| RELEASE_BRANCH | `codex/transfer-cas-release` |
| RELEASE_ENGINEERING_SHA | 包含本文件、直接位于8381959之上的单个本地commit；不是8381959本身 |
| Worktree | `/Users/apple/.codex/worktrees/transfer-cas-release/budu OS` |
| EXPECTED_DB / EXPECTED_MIGRATIONS | `budu_bj006` / 85 applied、0 failed |
| SCHEMA_CHANGED / MIGRATION_REQUIRED | NO / NO |
| DB_BACKUP_REQUIRED_FOR_THIS_RELEASE / DB_ROLLBACK_REQUIRED | NO / NO |

健康接口最终显示 **RELEASE_SHA**（目前接口返回前12位），容器GIT_SHA与image/container revision label使用完整RELEASE_SHA。8381959是业务代码身份；exclusive diff保证发布提交只能增加下列4个文件，脚本要求RELEASE_SHA唯一父提交为8381959、其为ancestor、工作树干净且Prisma相对fc57无差异。最终制品中server/shared/src/utils/prisma/scripts/brand/web/package/lock的Git跟踪内容按hash核对，不能只给旧image换label。回滚始终比较完整fc57及其已存在的image/container，绝不用076e作为正常回滚目标。

唯一允许新增的4个文件：

| 文件 | 必要性 |
| --- | --- |
| `scripts/deploy-prod-transfer-cas.sh` | Bash入口，转交专用Python控制器；无参数/帮助不执行发布 |
| `scripts/deploy-prod-transfer-cas.py` | 制品检查、只读preflight、显式授权后的导入/单writer切换/回滚 |
| `scripts/test-deploy-prod-transfer-cas.py` | 无网络/真实Docker的可重复静态与mock故障测试 |
| 本checkpoint | 身份、现场证据、预算、操作顺序、边界及交接 |

未修改server/v2.js、Transfer测试语义、schema/migrations、旧发布脚本、通用cloner或其它业务。8381959相对fc57仍为上轮审查的5文件+352/-8。schema和全部85个migration文件没有变化，现有三个终态此前已受支持，因此无新增DB兼容步骤，不创建migration、数据库备份、migrator或clone数据库。

## Existing authority inventory — Gate 1

已读取/扫描并比较项目deploy skill、workflow、deploy-remote、cloner以及6个deploy-prod专用脚本和release-prod入口；完整文件hash和关键控制语句保留本机existing-script-inventory.json。旧BUDU_STATUS是历史索引，不能替代本轮现场事实；该worktree没有docs/PROJECT_STATUS.md，未新增第二份状态权威。

- Runtime identity来自实际路由容器的GIT_SHA、revision label、image ID和health；本次再检查运行中v2.js与fc57的SHA256一致。`.current-sha`是已核对的发布指针，不能单独替代运行态；新流程成功时原子更新，回滚恢复fc57。
- `.github/workflows/deploy-prod.yml`调用deploy-remote，其现有条件会进入旧Sweet Card runner。后者硬锁fe4a725及migration66。不能用于Transfer。
- `deploy-prod-wechat-shipping-sync.sh`硬锁076e/f454、2文件allowlist、同步表为空、85→85迁移、backup和clone。现场同步表已有数据；本流程不复制这些假设。
- customer-request为49→50、product-material为50→51、product-category-summary为58、Sweet Card availability为66/67：均为历史feature release，不泛化或执行。
- 可复用架构部件：既有`clone-production-container.py`的环境/secret mount/volume/network/GroupAdd继承，原生产nginx的3路上游切换方式，以及保留旧容器/image的应用回滚方式。
- cloner包含已修复的`HostConfig.GroupAdd`动态继承。本次没有修改helper。其默认restart=no与现场unless-stopped不同，专用控制器在旧writer停后调用helper，然后对候选恢复原restart策略并逐项比对；不把helper单独声称为完整clone。

## Fresh read-only production evidence — Gates 5, 6, 8, 9

本轮SSH只读采集df -h、df -Pk、docker system df、docker system df -v、image/container inspect、image history的size字段、实际template/active配置；无secret值输出。新只读DB适配器已连接现场校验：85 applied/0 failed，85个名称/checksum匹配，PG只见旧容器IP的客户端，writer=1。SQL强制READ ONLY、statement timeout及temp_file_limit=0。

| 项目 | VERIFIED结果 |
| --- | --- |
| Production | fc57da5；`budu-prod-fc57da5-wechat-shipping-sync`；healthy |
| Rollback image | `budu-api:wechat-shipping-sync-fc57da5` |
| Immutable image ID | `sha256:6ae04d3bbf43656ac224efd45115d3ef42b9f6a77a451dffafce237eea3565cf` |
| Docker storage | 29.1.3 / overlayfs / io.containerd.snapshotter.v1；相关目录与/同文件系统 |
| Image inspect Size | 567,431,118 bytes，约0.528GiB，不能当作完整落盘占用 |
| Container SizeRootFs | 1,608,515,584 bytes，约1.498GiB |
| Current / rollback image total参考 | df -v为2.18GB，约2.03GiB；包含content及解包层，旧image已存在不再复制 |
| Current writable layer | 32,768 bytes = 32KiB |
| Relevant build cache | 0B；不假设生产build后仍为0 |
| Largest historical layer | image history约806MB；仅预算参考，不替代新制品逐层测量 |
| Disk initial | 81%；used47,584,356KiB；available11,584,784KiB，约11.05GiB |
| 后续只读snapshot | used48,661,671,936 bytes；available11,927,527,424 bytes，约11.108GiB；仍81% |

后续snapshot的空间变化来自现场正常活动，不能归因为本轮生产写操作。本轮未清理任何image/cache/rollback资产。

Canonical nginx template是 `/opt/budu/deploy/nginx/conf.d/budu.conf.template`，运行态是 `budu-nginx-1:/etc/nginx/conf.d/budu.conf`。两者相同，SHA256=`01bec331a3945f6de7e29f33e0b7fa900a71d65c900eed06498c79273297a605`。3条production proxy指向同一个fc57容器，另有1条既有隔离测试proxy。脚本从3条route解析容器名，再以完整revision/env/source hash交叉检查，不靠过期container名称选择运行态。

现场clone合同：node用户，/app工作目录，原Entrypoint/Cmd/healthcheck，3000/tcp但不发布host port，restart=unless-stopped，GroupAdd=[0]，两个原network；secret mounts只读，数据volume继续复用。原labels、资源/namespace/security/logging默认profile均纳入准入与clone后比对。出现未支持的ports、alias、label或资源配置时先阻断，不能悄悄丢配置。除GIT_SHA/revision/name/image这些显式身份字段外，env严格逐键相同；绑定值只从当前env读取并验证，不重建secret或数据库URL。helper的临时绑定/env仅在以后真正发布时使用/dev/shm，权限受限并清理，内容不输出。

## Artifact strategy and bounded disk — Gate 6

| 方案 | Production peak / temp / retained | Cache / 平台 / 回滚 / 复杂度 | 结论 |
| --- | --- | --- | --- |
| A Production build | 除最终image，还包括builder依赖、APT、npm和中间层；当前无法从0 cache证明峰值 | 有新cache；amd64；旧image可保留；旧脚本还带额外DB资产 | 不选择 |
| B 非生产Linux/amd64构建，压缩layer的Docker archive经SSH stdin导入 | 逐层测量并准入；不在生产另外保存tar；不信用共享层折扣；旧image不删除 | Production build cache增量0；平台硬锁linux/amd64；复用已有Docker/SSH，无新registry | **LOWEST_SAFE_PEAK_DISK_STRATEGY** |
| C 现有exact Git bundle +主机build / 当前image cache | Git身份可锁，但仍回到A的builder/cache峰值；没有已存在的8381959生产image | 无当前可直接使用的CAS制品，不使用旧feature入口 | 不选择 |

Docker官方Docker/OCI exporter支持gzip、compression-level与force-compression；选择type=docker、gzip并关闭多平台证明附件，避免依赖新registry。依据：[Docker exporter文档](https://docs.docker.com/build/exporters/oci-docker/)。本机没有Docker或shellcheck，本轮没有安装工具，也没有构建、导入真实image；非生产builder的实际运行属于未来制品准备步骤。

**具体预算机制，而非把旧估值写成新制品实测：**

- A = 完整archive字节，必须≤768MiB。
- B = archive中的content/metadata字节；不扣共享层。
- U = 所有layer解包的保守分配量：文件按4KiB取整，每项再计4KiB元数据，hardlink按目标完整大小计；拒绝sparse、无法解析的link和额外未审查内容。
- L = 最大单层上述分配量，作为额外解包staging预算。
- R = 512MiB，覆盖短时运行层/日志、普通业务增长及额外metadata余量。
- **CONSERVATIVE_PEAK_INCREMENT = A+B+U+L+R ≤ 4GiB。** 超过即离线拒绝，不上传/加载。
- **ESTIMATED_FINAL_INCREMENT = B+U**：当前镜像参考约2.03GiB，再计新制品实际metadata；预计约2.1–2.2GiB，必须以解析值为准。
- **ESTIMATED_TEMP_INCREMENT = A+L+R**：当前archive/layer参考约1.8GiB；它与最终增量的和必须≤4GiB，不能各自取范围上端后仍冒称通过。
- 以最新11.108GiB可用计算，4GiB总预算对应 **PROJECTED_PEAK_USAGE=88%**、**PROJECTED_MIN_AVAILABLE=7.108GiB**。以本轮初始空间计算则约7.05GiB，仍低于90%且高于5GiB。

**DEPLOYMENT_DISK_SAFE=YES，仅适用于通过该制品准入门、且现场重验通过的发布。** 最终image尚未构建，不能声称某个真实archive已经通过门。构建结果若不满足上述预算，结果必须是DEPLOYMENT_DISK_UNSAFE/ARTIFACT_PEAK_EXCEEDS_CONTRACT，不能通过prune、删旧image或降低阈值继续。

解析器同时核对gzip/plain layers、解压diff_id、compressed blob digest、config digest、linux/amd64、唯一tag/revision、Git runtime payload。存在OCI index时它必须与Docker manifest指向同一个config/layer集，额外image/attestation/未审查blob拒绝。部署输入先冻结到本机私有临时目录再校验，避免原tar被并发重写；生产没有第二份持久化tar。导入失败或SSH状态不明确时保留本次锁，禁止盲目重复加载造成峰值叠加。自动流程不删除image。

## Single writer / cutover / rollback — Gates 5, 7, 8, 10, 13

`server/index.js`在listen后启动online runtime、支付provider及退款核对。online runtime同时启动payment/refund recovery、outbox、logistics、shipping worker。因此“unrouted”不代表不会写；本流程没有并行连接生产的候选smoke。

未来准确顺序：

1. 在独立非生产builder从RELEASE_SHA的干净Git导出构建linux/amd64 image；输入只含Git文件，保留当前Dockerfile和lockfile。image label和tag绑定RELEASE_SHA。
2. 本地`inspect-artifact`核对上述制品身份和大小；`preflight`只读验证当前fc57、health、v2 hash、DB85/failed0/checksum、writer1、route与.current-sha、clone profile、Docker存储模型及磁盘预算。
3. 取得明确部署授权后才调用`deploy --authorize-release-sha <完整RELEASE_SHA>`。脚本取得原子host lock；同名candidate/tag已存在时拒绝覆盖。
4. 流式docker load；导入结果的image ID/label/platform再核对。此时旧writer继续服务；不启动候选、不执行migration。
5. 控制权交给**同一个生产端Python进程**执行后续切换与回滚。SSH断开后本地不会另发启动旧writer命令与远端竞争。HUP/TERM/INT在变更子进程完成前延迟处理，避免杀掉helper后其Docker start仍在后台完成。
6. 重查原容器ID/SHA/route。保存当前fc57的template、active和不含secret的manifest到本次独立rollback目录，不能用旧Shipping快照。更新路由前再次比较authority内容。
7. `docker stop --time 30 OLD`，再确认旧容器已停止、DB连接退出、应用writer=0；未证明0则不启动候选。允许短暂API不可用，通常为停止等待加候选启动/health时间，不宣称零停机或优雅业务drain已实现。
8. 调用原cloner（preserve / writer）；恢复候选restart=unless-stopped，逐项比对完整clone合同。候选是唯一writer后验内部health；失败进入回滚。
9. 仅替换3个production proxy，保留测试proxy。每份配置在自身目录用唯一临时文件+rename更新，nginx -t成功后reload；不声称两个文件具有跨文件原子事务。任何部分更新失败均用本次快照恢复两份authority并重新校验/reload。
10. 公网health/SHA、DB85/failed0/checksum、writer1、磁盘再验；原子更新.current-sha为RELEASE_SHA；返回DEPLOY_COMPLETE。旧容器/image不删除。
11. Transfer验收保持只读：image源码payload与60项离线CAS证据；如未来有现成授权会话，可GET既有Transfer列表看响应形状。不创建session、调拨或真实竞争测试。401/403不能冒充业务读取成功。真实用户/现有worker可正常推进数据，不能要求全库行数永远不变。

**Rollback：RELEASE_SHA（业务8381959）→fc57。**

- 如果候选可能已启动，先stop候选并证明writer=0；stop失败/连接未退出时，绝不启动旧writer。
- 重新启动保留的fc57原容器，核验内部health、DB和writer1。
- 路由若变过，恢复本次保存的fc57 template+active，nginx -t/reload；.current-sha若变过恢复fc57。公网再确认fc57与writer1。
- 不还原数据库、不删除已完成调拨、不改历史状态；候选期间合法产生的状态保留。DB unchanged指无schema/迁移/人工历史回写，不意味着后台和真实业务停滞。
- 旧路由快照指向076e，不能复用。失败若遇Docker/主机不可用而无法证实恢复，报告ROLLBACK_UNVERIFIED_MANUAL_ATTENTION_REQUIRED，不能仅凭echo认定成功。灾难性主机失效不能由任何在线脚本保证自动恢复；已保留旧image/container和本次路由manifest用于人工恢复。

## Command contract — 仅未来使用，本轮未执行

可复用当前Docker/SSH方式；无需push才能将本地exact-SHA制品带到production。当前Actions入口禁止用于此次发布。若未来选择GitHub runner，需要独立的制品构建作业，不能触发现有旧feature deploy workflow。

在**非生产**已有Docker/Buildx的构建机，用RELEASE_SHA的纯Git导出目录作为context：

```bash
docker buildx build --platform linux/amd64 \
  --label "org.opencontainers.image.revision=$RELEASE_SHA" \
  --tag "budu-api:transfer-cas-${RELEASE_SHA:0:12}" \
  --provenance=false --sbom=false \
  --output "type=docker,compression=gzip,compression-level=9,force-compression=true,dest=$LOCAL_ARCHIVE" \
  "$EXACT_GIT_EXPORT_DIRECTORY"
```

本地只读命令（repo须为已提交干净RELEASE_SHA；archive实际存在且通过验证）：

```bash
bash scripts/deploy-prod-transfer-cas.sh inspect-artifact --repo "$RELEASE_REPO" --archive "$LOCAL_ARCHIVE"
bash scripts/deploy-prod-transfer-cas.sh preflight --repo "$RELEASE_REPO" --archive "$LOCAL_ARCHIVE" --ssh-key "$SSH_KEY_PATH"
```

只有下一轮获得明确production授权，才允许增加mode=deploy与`--authorize-release-sha "$RELEASE_SHA"`。提供该参数是防误用门，不代替用户授权。

## Validation / commit / self-review — Gates 12, 14, 15

- bash -n PASS；Python compile PASS；没有shellcheck，未安装。
- **39项离线tests PASS**；其中一项包含6种切换失败注入。覆盖错production SHA/DB/migration数/failed migration/checksum、低磁盘/90%/制品峰值、错误ancestry/allowlist/schema/dirty tree、双writer/URL别名/未知client、路由冲突/数量、ports/restart/resources/GroupAdd/env继承、正确preflight、成功切换顺序、候选start/health/active-write/reload/public-health/.current-sha失败的回滚、停候选失败时不启动旧writer、授权缺失、gzip/plain/OCI制品hash/平台/业务源码/额外blob与禁止步骤扫描。
- 离线测试不连接production；mock Gate套件将任何真实subprocess调用设为失败。另有实际只读adapter校验，不能将其说成真实部署演练。
- 初次开发测试发现Python3.9没有hashlib.file_digest，已改为流式hash；实际readonly adapter发现PG inet文本携带/32，已使用host(client_addr)得到规范地址。未放宽writer断言；未知socket/客户端仍拒绝。
- **NEW_FAILURES=0**（本次新增发布测试最终结果）。原业务CAS60/60、browser20/20、build PASS复用原证据，旧基线10项runner失败和1skip保留，不伪称全仓库全绿，也未重跑无关业务套件。
- 提交后执行一次只读自审：direct parent/exclusive diff、业务文件不变、旧helper hash不变、无旧feature迁移和旧rollback目标、禁止命令缺席、39项测试、静态检查与Git clean。具体commit及结果在本轮最终交接中报告。

**自审边界：** 整个脚本没有production build/pull、DB迁移、backup/clone、prune、删除旧image、写业务DB、改secret/env的步骤。唯一有意变化的env是GIT_SHA身份；restart候选继承旧值。导入大小不满足4GiB预算、存储driver/version变化、source配置出现不支持项，均中止。没有真实制品或真实production切换演练时，不报告这些步骤为已执行PASS。

本轮只准备本地commit，**不push**。未推送commit无法从远端/其它设备恢复；原工作区未知修改保留且不纳入候选。报告、原始只读metadata、静态测试日志保存在本机 `/private/tmp/budu-transfer-release-20260926`，不写入Memory。

```text
PRODUCTION_DEPLOYED = NO
PRODUCTION_WRITE_OPERATIONS = 0
PRODUCTION_MIGRATION / RESTART / ROUTE_CUTOVER = 0
PRODUCTION_DOCKER_BUILD / PULL / LOAD / CREATE / START / STOP / REMOVE = 0
SAFE_TO_REQUEST_DEPLOY_AUTHORIZATION = YES (仅已定义准入条件的工程流程)
ACTUAL_RELEASE_IMAGE_BUILT_OR_ADMITTED = NO
STOP_AFTER_LOCAL_COMMIT_AND_REVIEW = YES
```
