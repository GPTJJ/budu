# BUDU Stable Engineering Status

> Lightweight context-recovery index. This file is not production authority and cannot replace current Git, runtime, database, migration, or reconciliation evidence.

Last reviewed: 2026-09-01

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

- Runtime SHA: `3c7f56c6cc77573e252023b59e2dcdfd1522678d` — VERIFIED on 2026-09-01; revalidate before use.
- Database authority: `budu_bj006` — VERIFIED on 2026-09-01; revalidate before use.
- Migration ledger: 62, failed migration count 0 — VERIFIED on 2026-09-01; revalidate before use.
- Public/internal health and canonical-DB-connected runtime count: PASS / 1 — VERIFIED on 2026-09-01; revalidate before use.
- Latest Production checkpoint: `docs/checkpoints/2026-09-01-system-settings-ui2-production.md`.

## Architecture Contracts

- One domain has one canonical authority and stable identity key.
- Historical business facts use stable IDs and immutable snapshots; current renames or disablement do not rewrite history.
- Client storage and display names are never business authority.
- Payment and payroll work are STRICT. Production cutover requires an explicit gate.

## Current Engineering Work

- BUDU repository team-skill foundation lives under `.agents/skills/budu-*`.
- System Settings UI 2.0 is live at runtime SHA `3c7f56c6cc77573e252023b59e2dcdfd1522678d`; it is an application-only release with no migration or business-authority change.
- The settings surface now uses four browse-first groups with capability-aware secondary pages. Notification unread/routing, POS/DailyEntry source authority and all existing settings operations remain unchanged.
- Report Center migrations 59–62 are deployed in the canonical production ledger. Future work must treat 62 as the current migration baseline and revalidate before assigning the next number.
- Production rollback runtime `budu-prod-d46d1ae-notification-unread` and settings release rollback assets are retained. See `docs/checkpoints/2026-09-01-system-settings-ui2-production.md`.

## Rollback Notes

- Production releases use exact-SHA artifacts and retain rollback assets; verify their current presence before a release.
- A migration must have an explicit backup, compatibility, reconciliation, and rollback contract.

Update this file only when a stable architecture contract or verified production baseline materially changes. Keep task history in scoped checkpoints.
