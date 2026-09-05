# BUDU Stable Engineering Status

> Lightweight context-recovery index. This file is not production authority and cannot replace current Git, runtime, database, migration, or reconciliation evidence.

Last reviewed: 2026-09-05

## Repository

- Remote: `https://github.com/GPTJJ/budu.git`.
- Local HEAD must never be assumed to equal production.
- Preserve unknown working-tree changes and reconcile branch authority before deployment.

## Canonical Authorities

- Business data: PostgreSQL.
- Employee identity: `Employee.id`; self-account link: `User.employeeId → Employee.id`.
- Product identity: `InventoryItem.id`; classification: `ProductCategory`.
- POS, transfer, and partner-supply eligibility are attributes of the same `InventoryItem`.
- Financial authority: PostgreSQL `Order` / `Payment` / `Refund` and server-side transition/reconciliation services.

## Last Directly Verified Production Baseline

- 2026-09-05 07:35 UTC: `SWEET_CARD_STORE_AVAILABILITY_1_0_COMPLETE` — VERIFIED.
- Runtime SHA `3838b35b6e2abd2196a8183901462329d610636b`, container `budu-prod-3838b35-sweet-card-availability`.
- PostgreSQL `budu_bj006`: Migration 67 applied / 0 failed; public/internal health PASS; one writer.
- Store identity `Store.key`; `Store.active` + new `Store.operationType` determines ACTIVE DIRECT eligibility. User confirmed tongying/chaowai/guanshe/xidan all DIRECT. All four enabled.
- Reuses `SweetCardStorePolicy.eligible`; missing policy DENY. DB singleton `SweetCardControl.GLOBAL.enabled` is ON; existing environment flags preserved.
- Current normal POS module + store scope automatically grants redemption. `sweetCardPosRedeem` is legacy and not authoritative for new redemption. Management capabilities remain separate. Disabling store/global never blocks original historical Refund services.
- Full Ledger/balance 400090 cents; ISSUE 400150 − REDEEM 160 + REFUND 100; delta 0. Commercial outstanding 250000, acceptance outstanding 150090; economic digest unchanged by release.
- Canonical backup `/opt/budu/.rollback-assets/sweet-card-availability-3838b35-20260905T073120Z/current-canonical-budu_bj006-m67-store-availability.dump`; SHA256 `227ee02340969b43478ed422a9e16327e3d5dc2c235f6c081114455d683e605f`; listing and actual restore PASS.
- Prior app, M66/M67 pre-promotion backups, earlier P19 baseline and DO-NOT-RESTORE artifacts retained. Four-store first-day heartbeat ACTIVE.
- Full evidence, authority contract, test limits and rollback: `docs/BUDU_SWEET_CARD_STORE_AVAILABILITY_1_0.md`.
- Revalidate current facts before future production work; this index is not live authority.

## Architecture Contracts

- One domain has one canonical authority and stable identity key.
- Historical business facts use stable IDs and immutable snapshots; current renames or disablement do not rewrite history.
- Client storage and display names are never business authority.
- Payment and payroll work are STRICT. Production cutover requires an explicit gate.

## Current Engineering Work

- `codex/sweet-card-store-availability` contains deployed Store Availability 1.0 and final evidence. P7/P10 release notes are historical, not current blockers. No additional commercial card issuance is authorized by this completed task.
- BUDU repository team-skill foundation lives under `.agents/skills/budu-*`.
- `budu-brand-system` is the canonical user-visible brand workflow. Formal names are lowercase `budu`; formal brand positions use the canonical wordmark source or its controlled derivatives. Internal identifiers and historical facts are not renamed.
- `budu-payroll-audit` is the canonical team workflow for asking whether calculated payroll is correct. It is always STRICT and read-only, reuses the current Payroll authority and stable `Employee.id`, and explicitly excludes paid/owed settlement reconciliation.
- Payroll Audit Report 2.0 renders one canonical audit model into a management email summary, complete Markdown and portrait PDF. Monthly execution is active for the first day of each month (Asia/Shanghai), audits the preceding full calendar month, and reuses immutable artifacts for email-only retries. See `docs/checkpoints/2026-09-01-payroll-audit-report-2.md`.
- System Settings UI 2.0 remains live within runtime SHA `f7fd6e54c4b8eac6fbdbc761d5e0788fddb1d9dc`; the later brand-slot release is application-only with no migration or business-authority change.
- Desktop navigation and the mobile drawer share `src/components/BrandSlot.jsx`: the approved simple character icon is paired with the unchanged canonical lowercase `budu` wordmark, and the former `甜蜜治愈日常` subtitle is absent.
- BrandSlot assets locally override the legacy global image outline with transparent, borderless presentation; the underlying icon and canonical wordmark assets remain unchanged.
- The settings surface now uses four browse-first groups with capability-aware secondary pages. Notification unread/routing, POS/DailyEntry source authority and all existing settings operations remain unchanged.
- Report Center migrations 59–62 and Sweet Card migrations 63–65 are deployed. Current migration baseline is 65; Migration 65 adds the typed batch-purpose authority without changing economic amounts.
- Previous Production runtime `budu-prod-f7fd6e5-brand-slot-r2` and protected brand-border rollback assets are retained. See `docs/checkpoints/2026-09-01-budu-brand-slot-border-hotfix.md`.

## Rollback Notes

- Production releases use exact-SHA artifacts and retain rollback assets; verify their current presence before a release.
- A migration must have an explicit backup, compatibility, reconciliation, and rollback contract.

Update this file only when a stable architecture contract or verified production baseline materially changes. Keep task history in scoped checkpoints.
