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

- Runtime SHA: `4a25cd49d373c442543af5063928daf73715bb55` — VERIFIED on 2026-08-31; revalidate before use.
- Database authority: `budu_bj006` — VERIFIED on 2026-08-31; revalidate before use.
- Migration ledger: 58, failed migration count 0 — VERIFIED on 2026-08-31; revalidate before use.
- Public/internal health and canonical-DB-connected runtime count: PASS / 1 — VERIFIED on 2026-08-31; revalidate before use.
- Purchase receiving/UI release is physically live, but its acceptance gate is **AUTHORITY CONFLICT / HOLD** because three real production receive requests occurred after cutover without confirmation in the deployment conversation. Do not alter or reverse those inventory facts without a separate authorized correction gate.
- Latest Production checkpoint: `docs/checkpoints/2026-08-30-purchase-receiving-ui-production-handoff.md`.

## Architecture Contracts

- One domain has one canonical authority and stable identity key.
- Historical business facts use stable IDs and immutable snapshots; current renames or disablement do not rewrite history.
- Client storage and display names are never business authority.
- Payment and payroll work are STRICT. Production cutover requires an explicit gate.

## Current Engineering Work

- BUDU repository team-skill foundation lives under `.agents/skills/budu-*`.
- Purchase receiving/UI source candidate: `d695bde5c2ecadfc1a3c2d41cae3f27c69f47060` on `codex/purchase-receiving-ui`; no schema or migration change.
- Daily Entry V2 final implementation candidate: `cf60bc161b97c23e2a86314e958ef6abce46e800` on `codex/daily-entry-v2`; Gate C–G PASS, no schema/migration change, Production not deployed. Recovery checkpoint: `docs/checkpoints/2026-08-31-daily-entry-v2-autonomous-final-handoff.md`.
- Report Center RC-5 candidate is isolated on `codex/report-center-rc5-candidate`, based on RC-4
  SHA `2bc9e4bcf8cedd074bcb38489f2f93794b49d287` and authoritative
  `4a25cd49d373c442543af5063928daf73715bb55`. RC-2A through RC-5 candidate gates are PASS;
  migrations 59/60 remain undeployed and RC-5 adds no migration. The Dashboard reuses the RC-3/RC-4
  query authority, classifies today pending-close separately from historical gaps, provides coverage-aware
  daily/weekly/monthly trends and same-store previous/year comparisons, and never projects the legacy Finance
  calculation as operating profit. Existing core/legacy report entry points remain preserved. Do not merge or
  deploy this candidate without an explicit reviewer gate. Checkpoint:
  `docs/checkpoints/2026-08-31-report-center-rc5-candidate.md`.

## Rollback Notes

- Production releases use exact-SHA artifacts and retain rollback assets; verify their current presence before a release.
- A migration must have an explicit backup, compatibility, reconciliation, and rollback contract.

Update this file only when a stable architecture contract or verified production baseline materially changes. Keep task history in scoped checkpoints.
