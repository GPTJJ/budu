# BUDU Data Authority — 权威文档（living document / 终稿）

> 项目：BUDU Data Authority 1.0 — **COMPLETE（2026-08-24）**
> 最终状态：**Production Business Data Authority = PostgreSQL**；KV（db.json）与 JSON（localStorage）仅承担缓存 / 回滚镜像 / 归档存档。

## 1. Gate 状态总览

| Gate | 状态 | 证据 |
|---|---|---|
| DA-0 Production Data Authority Audit | ✅ PASS | 《BUDU Data Authority 1.0 — DA-0 Audit Report》（只读审计 + 生产对账） |
| DA-1 Existing PostgreSQL Authority Freeze | ✅ PASS | `test-data-authority-freeze.mjs`（冻结 18 域，守卫测试 5/5） |
| DA-4 DailyEntry Authority | ✅ PASS | commitEntries PG 先写、loadUserData entries 仅取 PG；生产验收：PG 92 ⊇ KV 65、KV 镜像冻结 |
| DA-3 Schedule Authority | ✅ PASS | PG schedules 表 + 幂等回填 112 条（复跑 SKIP 112）+ 对账 MATCH 112；SchedulePage 读/写 PG |
| DA-2 Identity Authority（2.1-2.4） | ✅ PASS | 账号/登录/鉴权/账号管理 → PG（16 账号回填全等 + 幂等 SKIP）；员工名单 → PG employees（12/12 全等）；门店目录 → PG（5 活跃 + 垃圾键退役）；绑定 → 稳定 employeeId（11/11） |
| DA-5 Legacy Runtime Decoupling | ✅ PASS | 移除 localStorage 镜像读回退、legacy 迁移、业务字段 KV 镜像写、死代码（legacy 调货路由/commit*）；KV 转只读存档 |
| DA-6 Failure Acceptance | ✅ PASS | `test-failure-acceptance.mjs` 4/4：KV/JSON Down → 核心业务继续；PG Down → 明确失败无回退；恢复后一致 |
| DA-7 Production Authority Declaration | ✅ PASS（本文档） | 生产 5f253d6→7f9ce2e 系列 cutover 全部部署验收；全量测试 41/41 |

基线：Production SHA = Development SHA = `7b285f2`（main = feat）。生产 `DATA_STORE=file`（KV = db.json，只读存档），PG 65 表 / 36 迁移。

## 2. 最终 Authority Matrix（业务域 → 权威）

| Domain | Read Authority | Write Authority | 说明 |
|---|---|---|---|
| User / Account / Role / Permission / Binding | PG | PG | 绑定含稳定 employeeId；KV users = 回滚镜像（受控写） |
| Staff（员工名单） | PG employees（/v2/staff-list） | PG | 删除=RESIGNED（档案保留）；PG Staff 为日值班派生表镜像 |
| Employee Profile | PG | PG | — |
| Store（门店目录） | PG（active=true） | PG | 基础门店防删；被引用门店防删；垃圾键已退役 |
| Schedule | PG schedules | PG | 历史/当前/未来排班均在 PG |
| DailyEntry / DailyStoreStaff | PG | PG | 无 KV 回退；KV entries 为只读旧存档 |
| Payroll / Notice / Adjustment | PG | PG | — |
| POS（Product/Order/Payment/Refund/对账） | PG | PG | — |
| Inventory（调货/采购/库存/供应商） | PG | PG | KV inventory 字段为只读冗余 |
| Approval 全套 / Notification | PG | PG | 抄送名单来自 PG 账号 |
| Invoice / Mailing / Asset | PG | PG | — |
| Big Order Bonus | PG | PG | — |
| WeChat Binding | PG | PG | — |
| Analysis（报表上传） | — | — | 生产空置，归档 |
| Product Images | PG（InventoryItem.image） | PG | KV productImages = 陈旧存档 |
| removedStaff | — | — | 前端过滤缓存（删除权威 = PG status） |

## 3. 最终验收标准核对（DA-7 十项）

1. ✅ 所有正式业务域唯一 Authority（剩余 KV 字段均为非权威缓存/存档/回滚镜像）
2. ✅ 正式业务数据全部 PostgreSQL 权威
3. ✅ KV Down 不影响核心业务（DA-6 A/B）
4. ✅ JSON Down 不影响核心业务（DA-6 A/B）
5. ✅ PostgreSQL Down 时系统明确失败（DA-6 C）
6. ✅ 无 silent legacy fallback（DA-5 移除 + 守卫测试）
7. ✅ 无不明确 dual authority（镜像均显式声明：KV=存档/回滚，PG Staff=派生）
8. ✅ 业务身份使用稳定 ID（跨实体关系：employeeId / employees.id / Staff.id / 表级 PK；姓名仅存在于发放时固定的展示快照字段）
9. ✅ Authority 文档与代码一致（本文档 + 守卫测试）
10. ✅ Production 完成真实 cutover 验收（每个 Gate 独立部署 + 对账 + 幂等复跑 + 全量 41/41）

## 4. 遗留项（非阻塞，后续可选）

- KV db.json 保留为只读存档（含回滚镜像写）；观察期后可按流程归档/停写
- PG User 表 2 条孤儿行（tongying/budu01，历史迁移产物，未引用）
- 商品图旧 KV 字段（13 条 dataURL）可归档清理
- docs/RUNBOOK 与运维脚本可补充 DA 相关恢复演练

## 5. 证据链

- Git：main = feat = `7b285f2`；各 Gate 提交见 git log
- 迁移：36 个（含 20260824000000~00004 五个 DA 迁移）
- 测试：`test-data-authority-freeze / test-daily-entry-authority / test-schedule-authority / test-identity-authority / test-failure-acceptance` + 全量 41/41
- 生产备份：/home/ubuntu/.budu-backups/{da2,da3,da4}-*（db.json + PG 快照）
