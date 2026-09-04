# BUDU SWEET CARD 1.0 PRODUCTION FINAL REPORT

Date: 2026-09-04 (Asia/Shanghai)

## Final Decision

**PRODUCTION_HOLD**

Candidate code and additive migration are live, but `budu 甜意卡` remains explicitly disabled. No card, credential, redemption, Sweet Card refund, or Sweet Card ledger fact was created. The release stopped at Gate P6 because the exact Candidate cannot restrict POS redemption to approved test accounts.

## Authority and release identity

- Production baseline SHA: `ccdf1358938e53da99daf2a24d2cf3c6b13c8fed` — VERIFIED before release.
- Candidate SHA: `12c93379409d944c37e1ab9708ea972fb4be1474` — VERIFIED local/remote and clean.
- Deployed SHA: `12c93379409d944c37e1ab9708ea972fb4be1474` — VERIFIED by internal and public health.
- Candidate archive SHA256: `b459ea368c5903b65411d5afbb11260fa2fb21261ed8ee1c6d41093234984adf` — VERIFIED before build.
- Candidate image ID: `sha256:72a03e404c3d60fee606194743cf12a7a89ecdae4bb19c7ba51e6f3ca449a869`.
- Canonical PostgreSQL: `budu_bj006`.
- Migration: 63 applied / 0 failed; `20260904170000_sweet_card_candidate` applied once.
- Runtime: one production writer; previous `ccdf135…` runtime retained stopped.
- Feature flag: `SWEET_CARD_ENABLED=0` — VERIFIED after the HOLD decision.
- Model confirmation: operator confirmed GPT-5.6 Sol / high reasoning / Standard mode.

## Skills routing

STRICT route used: `budu-task-router`, `budu-context`, `budu-data-authority`, `budu-payment-safety`, `budu-regression`, `budu-production-deploy`, `budu-sweet-card`, `budu-mobile-ui`, `budu-brand-system`, and `budu-handoff`.

## Backup and rollback

- Backup root: `/opt/budu/.rollback-assets/sweet-card-12c9337-20260904T151115Z`.
- Pre-migration dump: `budu_bj006-migration62-pre-sweet-card-12c9337.dump`.
- Backup size: 37,374,864 bytes.
- Backup SHA256: `002250a8ea633d2583b94dc5f439ee278f60f6b73e827b579e21d272cfabbb28`.
- Protected duplicate: present, mode `0400`.
- `pg_restore --list`: PASS.
- Previous runtime, nginx configuration, runtime identity, environment-name inventory, schema before/after and reconciliation evidence: preserved.
- Application rollback: READY. The additive schema can remain dormant; database restore is not currently required.

## Gate results

| Gate | Result | Evidence |
|---|---|---|
| P0 Production revalidation | PASS | Baseline SHA, public/internal health, DB identity, migration 62, payment configuration presence and current business facts verified. |
| P1 Backup and rollback | PASS | Readable protected dump, checksum, runtime/nginx baseline and rollback route preserved. |
| P2 Migration safety audit | PASS | Production dump restored into isolated PostgreSQL 16; migration applied; 12 tables and 6 additive columns verified; 0 invalid constraints; complete legacy-table digest stable. |
| P3 Apply migration 63 | PASS | 63 applied / 0 failed; new Sweet Card tables empty; legacy digest stable; old runtime healthy; feature disabled. |
| P4 Deploy Candidate disabled | PASS | Exact archive/image, internal health, controlled network cutover, public health, one writer, old runtime stopped and retained. |
| P5 Legacy regression | PASS | POS products/orders readable; controlled cash order/refund; WeChat and Alipay provider status queries; legacy authority counts. |
| P6 Restricted enablement | **HOLD** | No POS test-account allowlist. Enabling any production store would expose Sweet Card to ordinary POS accounts at that store. |
| P7 Small-value Sweet Card E2E | NOT RUN | Blocked by P6; no production Sweet Card created. |
| P8 Mixed payment | NOT RUN | Blocked by P6. |
| P9 Single card and eligibility | NOT RUN | Blocked by P6. |
| P10 Concurrency/double spend | NOT RUN | Blocked by P6. |
| P11 Duplicate payment | NOT RUN | Blocked by P6. |
| P12 Refund | NOT RUN | Blocked by P6. |
| P13 Refund idempotency | NOT RUN | Blocked by P6. |
| P14 Lost/replacement | NOT RUN | Blocked by P6. |
| P15 QR security | NOT RUN | Blocked by P6. |
| P16 Ledger reconciliation | NOT RUN | No production Sweet Card ledger facts; blocked by P6. |
| P17 Audit/permission/report | NOT RUN | Blocked by P6. |
| P18 Secret/merchant safety | NOT RUN | Relevant secret/config presence was checked without values at P0; sequential release gate blocked at P6. |
| P19 Observation | NOT RUN | Sweet Card never enabled. Candidate disabled-state health is stable. |

## Legacy production regression

- Product authority: 86 active POS-selectable products returned; `InventoryItem.id` remains canonical.
- POS/order read: PASS on deployed Candidate.
- Controlled cash regression: ¥0.10 order `ord-2cbd…` → payment `pay-a2d6…` → full refund `ref-3347…`; order/payment/refund idempotency PASS. Net retained test value: ¥0.00.
- WeChat: existing completed payment `pay-1021…` read and official provider query PASS.
- Alipay: existing completed payment `pay-51e5…` read and official provider query PASS.
- Canonical counts after deployment were readable: 4 stores, 12 employees, 140 daily entries, 198 inventory items, 6 stock balances, 28 transfers, 10 approvals, 15 payroll notices.
- No uncontrolled real payment or refund was initiated.

## P6 blocker and permission evidence

The Candidate's POS configuration enables Sweet Card from only two conditions: global feature flag and eligible store policy. POS inspect/redeem authorization checks `STORE_POS`; it does not check a rollout-user allowlist or Sweet Card account capability.

Every production store has ordinary active POS accounts:

- Beijing Chaowai: 8 ordinary POS accounts.
- Beijing Guanshe: 4 ordinary POS accounts.
- Beijing Tongying Center: 4 ordinary POS accounts.
- Beijing Xidan: 3 ordinary POS accounts.

Therefore no existing production store can be enabled for only a developer/super-admin test account. Enabling a store would violate the explicit P6 scope. Permission was not broadened and no store policy was created.

## Sweet Card data and reconciliation

- All 12 Sweet Card tables: 0 rows after P5.
- Card / credential / QR token: NONE.
- Real Sweet Card order/payment/refund IDs: NONE.
- Mixed payment: NOT EXECUTED.
- Concurrency and duplicate payment: NOT EXECUTED in Production.
- Refund idempotency: NOT EXECUTED for Sweet Card.
- Ledger reconciliation: no Sweet Card facts exist; production closed-loop reconciliation remains UNVERIFIED.
- Audit/report: no Sweet Card production facts exist; end-to-end audit/report remains UNVERIFIED.

## Secret and merchant safety

Production payment secret/certificate configuration presence was verified without reading or recording values. No secret was replaced, printed, committed, or copied into this report. P18 was not reached and must be revalidated in a future release gate.

## Production business-data impact

1. Additive migration 63 added 12 Sweet Card tables, 6 enum types and 6 nullable/default-safe columns; historical values were not rewritten.
2. One controlled ¥0.10 cash regression order was created and fully refunded. The immutable order/payment/refund audit facts remain intentionally preserved.
3. WeChat and Alipay existing successful payments were queried read-only at the providers and remained successful.
4. No Sweet Card business fact exists and the feature remains unavailable.

## Required next action

Create a new reviewed Candidate, based on the current Production SHA, that adds a server-enforced rollout account allowlist to POS config, inspect and redeem paths. It must be independent of `STORE_POS`, fail closed, and be covered by permission tests proving ordinary accounts at an eligible store cannot see or redeem Sweet Card. Do not alter the current Candidate or enable the current production feature flag.
