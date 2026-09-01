# budu Payroll Issuance Snapshot Hotfix Checkpoint

Date: 2026-09-01 (Asia/Shanghai)

## Scope and root cause

- Scope was limited to the August 2026 payroll issuance preflight, UI projection and submit guard contract.
- Li Feiyan's authoritative payroll, Personnel card and issuance-list amount were all `843645` cents.
- The rejected snapshot differed only at `snapshot.days[3].explanation.bigOrderBonuses[0].receiptPresent`: the browser-side cached bonus projection omitted the receipt presence while the server authority retained it. The total remained unchanged.
- The hotfix introduces one versioned, digested canonical issuance snapshot produced by the server preflight. Both the issuance list and submit payload consume that snapshot; the final server guard still recomputes and validates the authority.
- Stale snapshots trigger a fresh server preflight and require the user to review and select again. Amount, component, duplicate and overlapping-period guards remain fail-closed.

## Verification

- Li Feiyan authority / Personnel card / issuance list: `843645 / 843645 / 843645` cents.
- Client snapshot / server snapshot: MATCH; difference `0` cents.
- Li Feiyan issuance preflight: PASS; no production PayrollNotice was created.
- Exact prior mismatch field was reproduced as `snapshot.days[3].explanation.bigOrderBonuses[0].receiptPresent`.
- Amount mismatch guard reports `totalCents`; component mismatch guard reports `snapshot.summary.commission`.
- Wang Hongyun's existing August overlapping PayrollNotice remains detected.
- Isolated PostgreSQL identity/overlap/concurrency/snapshot tests: PASS.
- Payroll resolver/readiness/explanation tests: PASS.
- WebKit issuance UI: 7/7 PASS.
- Build: PASS.
- Migration: NONE; production ledger remains 62 with failed count 0.

## Historical reconciliation

- Pre/post authority digest: `27fc156ea622ece3c772450f5634c5d1dc7972f810b20364796f0b91fa40129e`.
- `DailyEntry`, `DailyStoreStaff`, `DailyPayAdjustment`, `BigOrderBonus`, `Employee`, `Schedule` and `PayrollNotice` counts and canonical digests are unchanged.
- Payroll formula and historical payroll facts were not modified.

## Production

- Previous runtime: `cc63b1857782929992ab391d616586240b592619`.
- Deployed runtime: `9a8e48727069aeac46f0938f37a115eec21a57be`.
- Production container: `budu-prod-9a8e487-payroll-snapshot`.
- Database: `budu_bj006`; migration ledger 62; failed migration count 0.
- Public/internal health: PASS; canonical writer count: 1.
- Fresh protected backup and rollback evidence: `/opt/budu/.rollback-assets/payroll-snapshot-9a8e487-20260901T032822Z`.
- Previous runtime container remains stopped and recoverable.

## Handoff

- Runtime branch: `codex/payroll-snapshot-hotfix`.
- Runtime commit: `9a8e48727069aeac46f0938f37a115eec21a57be`.
- Any later commit on this branch is documentation-only.
- Before any subsequent production work, revalidate runtime SHA, database, migration ledger, health and writer count.
