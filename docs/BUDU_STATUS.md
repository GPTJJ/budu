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

- Runtime SHA: `cd5551352420b18e2347294604b51b28b4b92dda` — VERIFIED on 2026-09-05.
- Database: `budu_bj006`; Migration 64 applied / 0 failed — VERIFIED on 2026-09-05.
- Public/internal health PASS; exactly one production writer — VERIFIED on 2026-09-05.
- Routed runtime: `budu-prod-cd55513-sweet-card-p7c-disabled`.
- Sweet Card is DISABLED after P10 HOLD. P7C BigInt repair and P7/P8/P9 pass;
  P10 loser rolled back safely but exposed Prisma P2034 as HTTP 500. No second fix.
- Existing acceptance card: issue 50, five debits totaling 50, balance 0, refunds 0,
  delta 0; original P7 preserved. P11–P19 NOT STARTED.
- See `docs/checkpoints/2026-09-05-sweet-card-p7c-production-hold.md`.
- Revalidate all facts before further production action.

## Architecture Contracts

- One domain has one canonical authority and stable identity key.
- Historical business facts use stable IDs and immutable snapshots; current renames or disablement do not rewrite history.
- Client storage and display names are never business authority.
- Payment and payroll work are STRICT. Production cutover requires an explicit gate.

## Current Engineering Work

- `codex/sweet-card-p7c-serialization` contains the deployed application-only serialization repair and subsequent documentation. Current blocker is P10 conflict error handling; continuation needs a separately authorized Candidate. No balance edits, automatic refunds or replay of completed acceptance orders.
- BUDU repository team-skill foundation lives under `.agents/skills/budu-*`.
- `budu-brand-system` is the canonical user-visible brand workflow. Formal names are lowercase `budu`; formal brand positions use the canonical wordmark source or its controlled derivatives. Internal identifiers and historical facts are not renamed.
- `budu-payroll-audit` is the canonical team workflow for asking whether calculated payroll is correct. It is always STRICT and read-only, reuses the current Payroll authority and stable `Employee.id`, and explicitly excludes paid/owed settlement reconciliation.
- Payroll Audit Report 2.0 renders one canonical audit model into a management email summary, complete Markdown and portrait PDF. Monthly execution is active for the first day of each month (Asia/Shanghai), audits the preceding full calendar month, and reuses immutable artifacts for email-only retries. See `docs/checkpoints/2026-09-01-payroll-audit-report-2.md`.
- System Settings UI 2.0 remains live within runtime SHA `f7fd6e54c4b8eac6fbdbc761d5e0788fddb1d9dc`; the later brand-slot release is application-only with no migration or business-authority change.
- Desktop navigation and the mobile drawer share `src/components/BrandSlot.jsx`: the approved simple character icon is paired with the unchanged canonical lowercase `budu` wordmark, and the former `甜蜜治愈日常` subtitle is absent.
- BrandSlot assets locally override the legacy global image outline with transparent, borderless presentation; the underlying icon and canonical wordmark assets remain unchanged.
- The settings surface now uses four browse-first groups with capability-aware secondary pages. Notification unread/routing, POS/DailyEntry source authority and all existing settings operations remain unchanged.
- Report Center migrations 59–62 and Sweet Card migrations 63–64 are deployed. Current migration baseline is 64; no migration is authorized by the P7C application-only repair.
- Previous Production runtime `budu-prod-f7fd6e5-brand-slot-r2` and protected brand-border rollback assets are retained. See `docs/checkpoints/2026-09-01-budu-brand-slot-border-hotfix.md`.

## Rollback Notes

- Production releases use exact-SHA artifacts and retain rollback assets; verify their current presence before a release.
- A migration must have an explicit backup, compatibility, reconciliation, and rollback contract.

Update this file only when a stable architecture contract or verified production baseline materially changes. Keep task history in scoped checkpoints.
