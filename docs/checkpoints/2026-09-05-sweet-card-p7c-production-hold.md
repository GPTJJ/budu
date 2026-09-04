# budu Sweet Card P7C deployment and P10 HOLD

Final status: **PRODUCTION_HOLD**. Verified 2026-09-05, Asia/Shanghai.
Model configuration: MODEL_CONFIGURATION_NOT_VERIFIABLE; no switch claimed.

## Delivered repair and release identity

- Previous production: `00d7a77235de2a3f29f8bffbd49116f5e382b2fb`.
- Application Candidate / current production: `cd5551352420b18e2347294604b51b28b4b92dda`.
- Remote branch: `codex/sweet-card-p7c-serialization`.
- Image: `budu-api:sweet-card-p7c-cd55513`, full revision label verified.
- Final routed runtime: `budu-prod-cd55513-sweet-card-p7c-disabled`.
- Database `budu_bj006`; Migration 64 applied / 0 failed; one writer; public/internal health PASS — VERIFIED.
- Runtime change: only four missing decimal-string mappings in the redemption response.
- Migration/schema/functions/constraints/settlement/refund/Payment/Order state-machine changes: **NO**.
- Application repair requires DB changes: **NO**. Authorized acceptance subsequently created new economic facts; see below. No manual balance/Ledger edits, historical rewrite, fake Payment or database rollback occurred.
- [Exact application diff](p7c-evidence/application.diff).
- [Root cause, contract, precision proof and Candidate tests](2026-09-05-sweet-card-p7c-candidate.md).

The source commit changed server/sweet-card.js, two isolated API test scripts and
the Candidate report. Subsequent changes in this branch are documentation/evidence
only and are not a second application repair or a new deployed runtime SHA.

## Gates

| Gate | Current result | Direct evidence |
| --- | --- | --- |
| P7C Candidate | PASS | 168/168 local targeted; real PG Alipay and RC2A/B/C; issue/bind/query API; build; original COMMIT+500 repro and repaired 201/200 |
| Exact release / deployment | PASS | Full-SHA remote/image; unrouted read-only smoke; fresh M64 backup; pre/post health, DB, single writer |
| P7 re-acceptance | PASS | New order 10 cents, HTTP 201; same requestKey/order/card/intent replay HTTP 200; one debit; balance 40→30 |
| P8 mixed payment | PASS | Order 20 = Sweet Card 10 + genuine Cash-channel remainder Payment 10; balance 30→20 |
| P9 eligibility / single slot | PASS | Existing settled order rejects new redemption key with 409; blacklist maximum 0 and debit denied 409; spoof denied 403; paid/gift basket allocation 10/0; balance 20→10 |
| P9 mini reconciliation | PASS | ISSUE 50 - cumulative REDEEM 40 = balance 10; delta 0 |
| P10 economic concurrency invariants | PASS | Two orders race for 10; only one debit/Redemption/allocation commits; other transaction rolls back; no negative balance/lost update |
| P10 overall | **HOLD** | Losing request returned HTTP 500 for unhandled Prisma P2034 conflict |
| P11–P19 | NOT STARTED | Stopped at new application defect; no refund/loss/replacement/secret Gate performed |

The P8–P19 definitions were recovered from the original user attachment in the
historical task “8.28 OS支付宝开发线路” (autonomous final acceptance V2). Its historical
SHA/M64 predecessor facts were not treated as current authority. The current P7C
instruction supplies present authorization and supersedes its old one-fix scope.

P9 temporarily blocked only the existing test product category via the formal rules
API, within the unchanged xidan + one-principal scope. No product price or category
identity changed. Original empty category blacklist was restored and reverified.
Gift item was excluded by the server and had zero Sweet Card allocation. No second
card was issued; single-slot rejection used a new request key against an already
redeemed Order, together with the existing unique Order identity contract.

## New blocker: P10 conflict response

Direct production log:

```
PrismaClientKnownRequestError:
Transaction failed due to a write conflict or a deadlock. Please retry your transaction
code: P2034
modelName: SweetCardRedemption
server/sweet-card.js:145:24
server/sweet-card.js:472:18
```

The route wrapper at server/sweet-card.js:35–40 uses error.status || 500 and has no
P2034 handling; redeemSweetCard has no bounded conflict retry. The controlled race
returned [201,500]. This is a separate concurrent-write error-handling defect,
not BigInt serialization, not a second debit, and not a post-COMMIT response failure
for the losing request. Direct DB inspection proves that losing transaction left
no Redemption, Ledger debit, allocation debit, Payment or paid Order.

The temporary P10 script emitted `P10_PASS` for its economic assertions (which
explicitly allowed a rejected contender). That label is not the overall Gate
result: subsequent direct log and source audit established the new error-handling
blocker. Overall P10 is HOLD. No second application patch or P11 request was run.
The prepared P11 script was not executed.

## Economic reconciliation

Only the existing account `scv-ec6b…` was used. Initial issue Ledger remains
`scl-e6095aa6-0a73-41d7-8d2e-e8967e731bc4`, +50 cents.

| Fact | Order | Payable | Card debit | Payment |
| --- | --- | ---: | ---: | ---: |
| Original committed P7, preserved | ord-38dd6a42-2368-438b-9147-c18ad5c54ff0 | 10 | 10 | 0 |
| New P7C acceptance | ord-3a2fc973-3525-4b6f-99a0-06fae19ef889 | 10 | 10 | 0 |
| P8 mixed | ord-77e6dd94-5be6-4f0d-b6d9-5df908a672cb | 20 | 10 | 10 Cash |
| P9 basket | ord-baaff36a-18e6-4998-ace0-160a4f13bc4d | 10 | 10 | 0 |
| P10 winner | ord-f423189a-e80e-4152-943f-3c88f9560eb3 | 10 | 10 | 0 |
| P10 loser, pending/unpaid | ord-a5999931-7fbe-4980-b5a5-8a3c4f376a6d | 10 | 0 | 0 |

All amounts are integer cents. Completed Order coverage is 60 = 50 Card + 10 Cash.
Account: ISSUE 50 + credits 0 - debits 50 = **balance 0** (EXHAUSTED).
Counts: 1 card, 1 ISSUE, 5 REDEEM Ledgers, 5 Redemptions, 0 Sweet Card refunds.
Every committed Redemption has exactly one matching debit and exact allocation.
No double spend or duplicate debit observed. No refund was performed; refund and
refund-idempotency production Gates remain unverified rather than assumed PASS.
Final unexplained delta: **0 cents**.

[Full sanitized IDs and direct final DB reconciliation](p7c-evidence/final-reconciliation.json).

Before new acceptance, old P7 was directly proven balance 40, debit/Redemption/
allocation exactly once and Payment 0. It was never retried or refunded. Its exact
Redemption and Ledger IDs remain unchanged; later authorized orders account for
40 further cents of consumption. The earlier failed order ord-7a88e48c… and all
historical acceptance evidence were preserved.

## Final production and safety state

- Sweet Card globally **DISABLED**. Stored allowlist remains one approved principal
  daa77021… and one eligible store xidan; original blacklist is restored empty.
- Ordinary POS, Product API (86 products), Cash Order detail, Order/Report API,
  WeChat official payment/refund queries, Alipay official payment/refund queries:
  PASS before/after deployment and rechecked after HOLD.
- Existing provider query APIs may append ordinary query/audit logs; no new WeChat
  or Alipay charge/refund was initiated. Cash acceptance Payment is exactly 10 cents.
- Production health / DB / Migration 64 / one writer: VERIFIED after disabling.
- No rollout beyond the approved intersection; no PRODUCTION_COMPLETE claim.
- Runtime rollback required: **NO**. The deployed serialization repair works;
  legacy production and financial data remain healthy. Restoring old app would
  reintroduce the known BigInt defect.

## Backup and executable rollback baseline

Protected root:
`/opt/budu/.rollback-assets/sweet-card-p7c-cd55513-20260905`.

- production-m64.dump: fresh pre-cutover M64 snapshot, includes original P7.
- production-m64-post-p10-hold.dump: fresh final snapshot retaining ALL new facts.
- Both pg_restore --list and SHA256SUMS validation PASS.
- rollback-app.sh, pre-P7C nginx configs and disabled-runtime configs retained.
- Old 00d7a77 image/container and current disabled/enabled containers retained.
- Database restore is NOT authorized or needed. Never restore the pre-cutover dump
  over the subsequent valid acceptance transactions to make testing appear clean.

## Handoff and next single action

Create a separately authorized application-only Candidate for P2034 conflict
handling in Sweet Card redemption, with a bounded/reconciled retry or explicit
controlled conflict response following the formal API contract. Reproduce the
losing-transaction rollback and retest sequential/concurrent idempotency in an
isolated database before any production continuation. Do not add value, delete
orders, refund the original P7, or rerun completed acceptance scripts blindly.

Repository: GPTJJ/budu; current work is on codex/sweet-card-p7c-serialization.
The source Candidate is pushed. This report/evidence is committed locally as
a documentation-only handoff; it is not automatically pushed (project instruction).
Use git log/status/upstream to find its exact SHA and ahead count.
Uncommitted work cannot be recovered remotely; committed but unpushed work also
cannot. Unknown dirty documentation in the separate P6A worktree was preserved
and excluded. The original main workspace was not switched or modified.
