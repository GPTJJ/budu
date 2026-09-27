# BUDU System Settings UI 2.0 Production Checkpoint

Date: 2026-09-01 (Asia/Shanghai)

Status: **VERIFIED — production live**

## Release authority

- Task branch: `codex/system-settings-ui2`
- Previous production SHA: `d46d1ae64813861c0382c5de6eeaf8f79824fedf`
- Production runtime SHA: `3c7f56c6cc77573e252023b59e2dcdfd1522678d`
- Production container: `budu-prod-3c7f56c-settings-ui2`
- Canonical database: `budu_bj006`
- Migration ledger: 62; failed migrations: 0
- Schema or migration change: none
- Canonical database writer count: 1
- Public/internal health: PASS
- Authoritative runtime commit: `codex/budu-authoritative-mainline` was fast-forwarded to the deployed SHA before this documentation-only checkpoint.

## Delivered UI contract

- System Settings is now a four-group browse-first page: 提醒与通知, 门店与 POS, 账号与安全, and 开发者与系统.
- Complex configuration is reached through SPA secondary pages instead of remaining expanded on the main page.
- Enterprise WeCom alert status, personal WeCom binding, current store sales-source configuration, second password, deleted-record audit, developer binding tools, data-source explanation, and system information remain reachable.
- Developer-only tools remain hidden from ordinary roles. Existing server-side permission checks remain authoritative.
- The new alert-status projection exposes only whether the channel is configured. It never returns a webhook, environment variable name, token, or secret.
- Notification routing, unread authority, POS/DailyEntry source authority, Payment, Refund, Payroll, Transfer, Report Center and database schema were not changed.

## Verification evidence

- Settings information architecture and responsive WebKit suite: 7/7 PASS.
- Notification unread authority and mobile/desktop WebKit: authority PASS plus 4/4 PASS.
- Overlay/PTR and POS WebKit regression: 35/35 PASS.
- Approval/notification portal regression: 2/2 PASS.
- DailyEntry authority: 4/4 PASS; completeness smoke PASS.
- Production build: PASS.
- Production 390px acceptance: no horizontal overflow; setting rows are 68–79px high; header/back/refresh/notification controls and bottom safe area render correctly.
- Production desktop acceptance: four groups visible with no horizontal overflow.
- Production real authorities displayed: enterprise alert connected, WeCom personal binding unbound, and store summary `1 家 POS · 3 家人工`.
- Production POS secondary page loaded the four real stores and their current source/effective-date projections without a write.
- Production developer page retained manual binding debug, deleted records/audit and data-source explanation; secret exposure check PASS.
- Production notification overlay added the global overlay lock and removed it on close; no notification read or delivery fact was mutated.

## Rollback

- Previous runtime container/image `budu-prod-d46d1ae-notification-unread` remains stopped and recoverable.
- Nginx active configuration and the previously stale host template were reconciled to the new exact runtime.
- Protected rollback copies are under `/opt/budu/.rollback-assets/settings-ui2-3c7f56c-20260831T155103Z`.
- This was an application-only release; no production database write, migration or restore is required for application rollback.

## Recovery instruction

Start from the latest `codex/budu-authoritative-mainline`, then revalidate runtime SHA, `budu_bj006`, migration 62, failed migration count 0, writer count 1 and public health. The runtime commit is `3c7f56c6cc77573e252023b59e2dcdfd1522678d`; a later commit may be documentation-only.
