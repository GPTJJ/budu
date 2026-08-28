# 项目约定

## 长期执行原则

1. **Production/Data Safety First**：生产可用性、数据完整性、隐私和可回滚性优先于交付速度。
2. **One Domain → One Canonical Authority**：每个业务域必须有唯一权威数据源和稳定身份键；兼容路径只能被明确标记，不能反向覆盖权威。
3. 默认工作顺序：**READ → VERIFY → PLAN → CHANGE → TEST → RECONCILE → REPORT**。
4. 未经用户明确授权，禁止自动部署、切换 nginx、执行生产写入或发送真实业务通知。
5. 禁止无关重构、顺手修复和任务范围扩张；以最小可验证改动完成当前目标。
6. destructive migration 默认禁止。任何生产历史数据修改必须先有 fresh backup、dry-run、reconciliation 和可执行 rollback。
7. Git、DB、Runtime、文档或多个权威来源冲突时，标记 **AUTHORITY CONFLICT** 并 STOP；不得凭猜测选边。
8. 文档和 Memory 都不能替代当前生产事实。旧测试、旧日志、旧 checkpoint、旧聊天证据不得自动视为当前事实。
9. 复杂任务按 Gate 执行；除非用户明确授权 end-to-end/Goal Mode，每个 Gate 完成后 STOP，等待下一 Gate 授权。
10. 任何 destructive、跨域或生产级操作前，必须再次确认目标、范围、备份和回滚基线。

## 证据状态词

项目状态和交接文档必须区分：

- **VERIFIED**：在当前审计中由直接 Git、Runtime、DB 或可复现测试证据确认。
- **OBSERVED**：在源码、配置或日志中观察到，但未证明已在当前生产生效。
- **INFERRED**：由证据推导，尚未直接确认。
- **UNVERIFIED**：当前没有足够证据。
- **STALE**：证据真实但已过期，不能代表当前状态。
- **BLOCKED**：继续执行会违反安全、权限或权威约束。

不得降低状态词强度来掩盖未知，也不得把 OBSERVED/INFERRED 写成 VERIFIED。

## SESSION BOOTSTRAP

新会话在开发、迁移或部署前必须：

1. 读取根目录 `AGENTS.md` 和 `docs/PROJECT_STATUS.md`。
2. 检查 `git status`、current branch、HEAD、upstream 和相关 release/checkpoint。
3. 识别并保留来源不明的 working-tree 修改；不得擅自 discard、reset 或 stash。
4. 重新验证与任务相关的 Canonical Authority、测试证据和当前 blocker。
5. 涉及生产时直接验证 runtime SHA、实际数据库、migration、health、writer、backup/rollback；无法验证的项目标记 UNVERIFIED。
6. 若仓库、状态文档与运行时冲突，标记 AUTHORITY CONFLICT 并 STOP。

## 用户指令约定

- 用户发送【push】时：把当前工作区未提交的任务进度（代码、文档、配置等，排除临时与工具目录）提交并推送到 GitHub；先 `git fetch`，如有远端新提交先 `rebase` 再推送，避免覆盖他人改动。
- 用户未明确要求 push 时，不因 handoff 或得到 clean working tree 而擅自推送。
