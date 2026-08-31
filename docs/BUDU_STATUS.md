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

- Runtime SHA: `0cd28684e6da8327ca37bd13d3b9ee05236bccaa` — VERIFIED on 2026-08-31; revalidate before use.
- Database authority: `budu_bj006` — VERIFIED on 2026-08-31; revalidate before use.
- Migration ledger: 62, failed migration count 0 — VERIFIED on 2026-08-31; revalidate before use.
- Public/internal health and canonical-DB-connected runtime count: PASS / 1 — VERIFIED on 2026-08-31; revalidate before use.
- Authoritative mainline: `codex/budu-authoritative-mainline` at the exact Production SHA above, ahead/behind `0/0` — VERIFIED on 2026-08-31.
- Purchase receiving/UI release is physically live, but its acceptance gate is **AUTHORITY CONFLICT / HOLD** because three real production receive requests occurred after cutover without confirmation in the deployment conversation. Do not alter or reverse those inventory facts without a separate authorized correction gate.
- Latest Production checkpoint: `docs/checkpoints/2026-08-31-report-center-v1-production.md`.

## Architecture Contracts

- One domain has one canonical authority and stable identity key.
- Historical business facts use stable IDs and immutable snapshots; current renames or disablement do not rewrite history.
- Client storage and display names are never business authority.
- Payment and payroll work are STRICT. Production cutover requires an explicit gate.

## Current Engineering Work

- BUDU repository team-skill foundation lives under `.agents/skills/budu-*`.
- Purchase receiving/UI source candidate: `d695bde5c2ecadfc1a3c2d41cae3f27c69f47060` on `codex/purchase-receiving-ui`; no schema or migration change.
- Daily Entry V2 final implementation candidate: `cf60bc161b97c23e2a86314e958ef6abce46e800` on `codex/daily-entry-v2`; Gate C–G PASS, no schema/migration change, Production not deployed. Recovery checkpoint: `docs/checkpoints/2026-08-31-daily-entry-v2-autonomous-final-handoff.md`.
- Report Center V1 is Production LIVE at `0cd28684e6da8327ca37bd13d3b9ee05236bccaa`; migrations 59–62 are applied.
  Dashboard, comprehensive sales, real Order/OrderItem reports, coverage-aware projections and the unified operating-profit
  authority are live. Manual stores never receive guessed Order, item, COGS or profit facts; current Production cost configuration
  remains incomplete and is displayed as such. Sensitive report, cost, labor, external-order and manual-external-refund capabilities
  remain restricted to the existing minimal developer/admin boundary. Production checkpoint:
  `docs/checkpoints/2026-08-31-report-center-v1-production.md`.

## Rollback Notes

- Production releases use exact-SHA artifacts and retain rollback assets; verify their current presence before a release.
- A migration must have an explicit backup, compatibility, reconciliation, and rollback contract.

Update this file only when a stable architecture contract or verified production baseline materially changes. Keep task history in scoped checkpoints.
