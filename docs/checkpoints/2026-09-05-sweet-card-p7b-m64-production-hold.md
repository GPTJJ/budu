# Sweet Card P7B Migration 64 production HOLD

Date: 2026-09-05 (Asia/Shanghai)

Final status: `PRODUCTION_HOLD`

## Production authority

- Production SHA: `00d7a77235de2a3f29f8bffbd49116f5e382b2fb`.
- Runtime: `budu-prod-00d7a77-sweet-card-p7b-m64-disabled`.
- PostgreSQL: `budu_bj006`.
- Migration: 64 applied / 0 failed.
- Public and internal health: PASS.
- Production database-connected application writers: exactly 1.
- Sweet Card global flag: disabled after the P7 response failure.
- Migration 64 remains applied; no database rollback was attempted because the new committed Sweet Card settlement fact is valid and must be preserved.

## Candidate and deployment

- Candidate branch: `codex/sweet-card-p7b-migration64-candidate`.
- Candidate SHA: `00d7a77235de2a3f29f8bffbd49116f5e382b2fb`.
- Candidate remote verification: PASS.
- Fresh pre-M64 backup and rollback assets: `/opt/budu/.rollback-assets/sweet-card-p7b-m64-00d7a77-20260904T181318Z` (protected mode; no Secret contents recorded here).
- Migration 64 production function/constraint checksums exactly matched the isolated Candidate.
- Columns, enums, indexes, non-target constraints, triggers, and non-target functions retained their pre-M64 catalog digests.
- Legacy First: normal POS, Product authority, historical Order/Refund, Cash, report API, WeChat official payment/refund query, and Alipay official payment/refund query PASS.

## Controlled rollout evidence

Before retrying P7, the rollout was restored only for the existing approved intersection:

- store: `xidan`;
- canonical authenticated principal: `daa77021…`;
- same-store ordinary POS: disabled;
- other store request: disabled;
- allowlist count: exactly 1;
- eligible-store policy count: exactly 1.

After the failure, the global flag was immediately disabled again. The allowlist and store policy remain inert database facts.

## P7 economic result

The acceptance request created a new 10-cent `xidan` order using the existing eligible test product. An ordinary POS request with a forged `operatorId` was denied with HTTP 403; approved inspect returned usable with a 10-cent maximum.

The redeem HTTP request returned 500, but the database transaction had already committed successfully:

- Card: `scv-ec6b…`.
- Initial P7 balance: 50 cents.
- Order: `ord-38dd6a42-2368-438b-9147-c18ad5c54ff0`.
- Order payable / committed Sweet Card settlement: 10 / 10 cents.
- Order status: `completed`; payment status: `paid`.
- Payment count: 0.
- Redemption: `scr-f9770281-1a4c-466a-8e75-b162d4b8c519`, exactly once, 10 cents.
- Redemption Ledger: `scl-4cd441d9-fb8a-449d-a7b3-61a087c1a33a`, exactly once, -10 cents.
- Allocation: exactly one row totaling 10 cents.
- Balance: 50 → 40 cents.
- Sweet Card refunds: 0.
- Reconciliation: `50 - 10 + 0 = 40`; unexplained delta: 0 cents.
- Current totals: 1 card / 1 redemption / 0 Sweet Card refunds.

## New blocker

The server log records `TypeError: Do not know how to serialize a BigInt` in `server/sweet-card.js` at the redeem response. The route converts `redemption.amountCents`, `order.payableAmount`, and `order.sweetCardAmount`, but spreads other BigInt redemption fields into `res.json()`. Consequently the financial transaction commits and the client receives HTTP 500.

This is a newly discovered application defect after the one authorized Migration 64 fix. The one-fix limit requires an immediate HOLD; it must not be repaired automatically in this Gate.

## Stop

- P7 economic invariant: PASS.
- P7 end-to-end/API result: FAIL / HOLD.
- P8–P19: NOT STARTED.
- Do not re-enable Sweet Card or repeat the redemption request until a separately authorized application-only response-serialization Candidate is reviewed, tested against the already-committed redemption, deployed, and reconciled.
