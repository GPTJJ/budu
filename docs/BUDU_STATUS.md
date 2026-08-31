# BUDU Stable Engineering Status

> Lightweight context-recovery index. This file is not production authority and cannot replace current Git, runtime, database, migration, or reconciliation evidence.

Last reviewed: 2026-08-31

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

- Runtime SHA: `1199f9bb1214bf13d9a93f304b9982df79d73a02` — VERIFIED on 2026-08-31; revalidate before use.
- Authoritative mainline: `codex/budu-authoritative-mainline` at `1199f9bb1214bf13d9a93f304b9982df79d73a02` — VERIFIED after fast-forward on 2026-08-31.
- Database authority: `budu_bj006` — VERIFIED on 2026-08-31; revalidate before use.
- Migration ledger: 58, failed migration count 0 — VERIFIED on 2026-08-31; revalidate before use.
- Public/internal health and canonical-DB-connected runtime count: PASS / 1 — VERIFIED on 2026-08-31; revalidate before use.
- Daily Entry V2 is LIVE with read-only Production acceptance PASS. Final real write acceptance is `PENDING USER NORMAL USE`; do not manufacture DailyEntry or payroll facts for testing.
- Purchase receiving/UI release is physically live, but its acceptance gate is **AUTHORITY CONFLICT / HOLD** because three real production receive requests occurred after cutover without confirmation in the deployment conversation. Do not alter or reverse those inventory facts without a separate authorized correction gate.
- Latest Production checkpoint: `docs/checkpoints/2026-08-31-daily-entry-v2-production-acceptance.md`.

## Architecture Contracts

- One domain has one canonical authority and stable identity key.
- Historical business facts use stable IDs and immutable snapshots; current renames or disablement do not rewrite history.
- Client storage and display names are never business authority.
- Payment and payroll work are STRICT. Production cutover requires an explicit gate.

## Current Engineering Work

- BUDU repository team-skill foundation lives under `.agents/skills/budu-*`.
- Purchase receiving/UI source candidate: `d695bde5c2ecadfc1a3c2d41cae3f27c69f47060` on `codex/purchase-receiving-ui`; no schema or migration change.
- Daily Entry V2 deployed source: `1199f9bb1214bf13d9a93f304b9982df79d73a02`; Gate C–G and Production read-only acceptance PASS, no schema/migration change. Final real write acceptance remains `PENDING USER NORMAL USE`. Production checkpoint: `docs/checkpoints/2026-08-31-daily-entry-v2-production-acceptance.md`.
- Report Center remains paused on its independent `codex/report-center-rc2b` branch. Do not merge it into purchase work or production without a new gate.

## Rollback Notes

- Production releases use exact-SHA artifacts and retain rollback assets; verify their current presence before a release.
- A migration must have an explicit backup, compatibility, reconciliation, and rollback contract.

Update this file only when a stable architecture contract or verified production baseline materially changes. Keep task history in scoped checkpoints.
