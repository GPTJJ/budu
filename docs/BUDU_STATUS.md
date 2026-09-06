# BUDU Stable Engineering Status

> Lightweight context-recovery index. This file is not production authority and cannot replace current Git, runtime, database, migration, or reconciliation evidence.

Last reviewed: 2026-09-06

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

- Runtime SHA `3838b35b6e2a`; container healthy with restart count 0 — VERIFIED on 2026-09-06.
- Database `budu_bj006`; Migration 67 applied / 0 failed; exactly one running
  container has the Production database authority — VERIFIED.
- `SweetCardBatch.businessPurpose` remains the typed batch-use authority.
- ISSUE 500,150 - REDEEM 160 + REFUND 100 = balance/Ledger 500,090 cents;
  delta 0. Commercial-only outstanding is 350,000 cents with zero commercial
  redemption/refund — VERIFIED.
- Store Availability denial-only matrix passed for all four direct stores;
  public/internal health, DB, POS channel configuration, permissions, and
  management separation passed. No real payment was created.
- Backup and rollback artifacts were not modified or revalidated during the
  A1/A2 Test-only Gate. Revalidate them before a later Production change.
- See `docs/checkpoints/2026-09-06-sweet-card-1.1a-a2-ready.md`.
- Revalidate all facts before further production action.

## Architecture Contracts

- One domain has one canonical authority and stable identity key.
- Historical business facts use stable IDs and immutable snapshots; current renames or disablement do not rewrite history.
- Client storage and display names are never business authority.
- Payment and payroll work are STRICT. Production cutover requires an explicit gate.

## Current Engineering Work

- Sweet Card 1.1A Gate A1/A2 is ready on local unpushed branch
  `codex/sweet-card-1-1a` at implementation commit `150683db05283655482beee15cf5103c488a1432`.
  Migrations 68/69 are applied only to Test database `budu_sc11a_test`; Production
  remains SHA `3838b35b6e2a` at Migration 67. A3 has not started. See
  `docs/checkpoints/2026-09-06-sweet-card-1.1a-a2-ready.md`.
- `codex/sweet-card-p7c-serialization` contains the deployed application-only serialization repair and subsequent documentation. Current blocker is P10 conflict error handling; continuation needs a separately authorized Candidate. No balance edits, automatic refunds or replay of completed acceptance orders.
- BUDU repository team-skill foundation lives under `.agents/skills/budu-*`.
- `budu-brand-system` is the canonical user-visible brand workflow. Formal names are lowercase `budu`; formal brand positions use the canonical wordmark source or its controlled derivatives. Internal identifiers and historical facts are not renamed.
- `budu-payroll-audit` is the canonical team workflow for asking whether calculated payroll is correct. It is always STRICT and read-only, reuses the current Payroll authority and stable `Employee.id`, and explicitly excludes paid/owed settlement reconciliation.
- Payroll Audit Report 2.0 renders one canonical audit model into a management email summary, complete Markdown and portrait PDF. Monthly execution is active for the first day of each month (Asia/Shanghai), audits the preceding full calendar month, and reuses immutable artifacts for email-only retries. See `docs/checkpoints/2026-09-01-payroll-audit-report-2.md`.
- System Settings UI 2.0 remains live within runtime SHA `f7fd6e54c4b8eac6fbdbc761d5e0788fddb1d9dc`; the later brand-slot release is application-only with no migration or business-authority change.
- Desktop navigation and the mobile drawer share `src/components/BrandSlot.jsx`: the approved simple character icon is paired with the unchanged canonical lowercase `budu` wordmark, and the former `甜蜜治愈日常` subtitle is absent.
- BrandSlot assets locally override the legacy global image outline with transparent, borderless presentation; the underlying icon and canonical wordmark assets remain unchanged.
- The settings surface now uses four browse-first groups with capability-aware secondary pages. Notification unread/routing, POS/DailyEntry source authority and all existing settings operations remain unchanged.
- Production Migration baseline is 67. Sweet Card 1.1A Migrations 68/69 remain Test-only candidates.
- Previous Production runtime `budu-prod-f7fd6e5-brand-slot-r2` and protected brand-border rollback assets are retained. See `docs/checkpoints/2026-09-01-budu-brand-slot-border-hotfix.md`.

## Rollback Notes

- Production releases use exact-SHA artifacts and retain rollback assets; verify their current presence before a release.
- A migration must have an explicit backup, compatibility, reconciliation, and rollback contract.

Update this file only when a stable architecture contract or verified production baseline materially changes. Keep task history in scoped checkpoints.
