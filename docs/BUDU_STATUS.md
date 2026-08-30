# BUDU Stable Engineering Status

> Lightweight context-recovery index. This file is not production authority and cannot replace current Git, runtime, database, migration, or reconciliation evidence.

Last reviewed: 2026-08-30

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

- Runtime SHA: `afc9df1baf038161743ec43f93ed6ac796d02393` — VERIFIED on 2026-08-30; revalidate before use.
- Database authority: `budu_bj006` — VERIFIED on 2026-08-30; revalidate before use.
- Migration ledger: 57 — VERIFIED on 2026-08-30; revalidate before use.
- Runtime health and single writer: PASS / 1 — VERIFIED on 2026-08-30; revalidate before use.
- Production Alipay provider: disabled at that verification.
- Latest checkpoint: `docs/checkpoints/2026-08-30-transfer-box-piece-production.md`.

## Architecture Contracts

- One domain has one canonical authority and stable identity key.
- Historical business facts use stable IDs and immutable snapshots; current renames or disablement do not rewrite history.
- Client storage and display names are never business authority.
- Payment and payroll work are STRICT. Production cutover requires an explicit gate.

## Current Engineering Work

- BUDU repository team-skill foundation lives under `.agents/skills/budu-*`.
- No business module, database migration, or production release is part of the skills-foundation change.

## Rollback Notes

- Production releases use exact-SHA artifacts and retain rollback assets; verify their current presence before a release.
- A migration must have an explicit backup, compatibility, reconciliation, and rollback contract.

Update this file only when a stable architecture contract or verified production baseline materially changes. Keep task history in scoped checkpoints.
