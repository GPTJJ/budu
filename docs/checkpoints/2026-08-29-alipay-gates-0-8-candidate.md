# BUDU Alipay Gates 0–8 Candidate Checkpoint

Date: 2026-08-29

Status: CANDIDATE READY FOR REVIEW — NOT DEPLOYED

## Authority and production baseline

- Production runtime SHA was directly revalidated as `35951cfdc8b24f0291b157a25ccf097f6e7c4522` in container `budu-prod-35951cf-product-group`.
- Production PostgreSQL authority remains `budu_bj006`; migration ledger remains 56 with no Alipay migration.
- Production Payment counts before and after candidate work are identical: cash success 35; mock/cash refunded 2 and success 12; WeChat refunded 1 and success 40.
- Production Refund count remains completed 5; pending Payment, unresolved Payment and pending Refund are all zero.
- Production has zero multi-success orders, zero Payment/Order amount mismatch and zero over-refunded Payment.
- No production Alipay environment variable is present; production Alipay is disabled.

## Candidate implementation

- Official `alipay-sdk` OpenAPI V3 adapter with `trade/pay`, `trade/query`, `trade/cancel`, `trade/refund` and refund query.
- RSA2 callback verification plus strict app, seller, trade number, amount, currency and state validation.
- Generic provider capabilities, pending guard, reconciler and refund reconciler; current WeChat APIv2 protocol is unchanged.
- Payment authority remains server-side. Ambiguous/timeout results remain pending and reuse the original merchant trade number.
- Alipay authCode exists only in the scanner/request/provider call stack and is excluded from persistence and logs.
- POS Alipay UI is exposed only when `PAYMENT_MODE=live`, `ALIPAY_ENABLED=1`, configuration is complete and the order store is allowed.
- No schema migration and no historical Payment mutation.

## Verification evidence

- Payment/WeChat/Alipay focused suite: PASS 124/124.
- Alipay provider tests: create/query/cancel, real synthetic RSA2 signature, amount mismatch, timeout, duplicate click, callback/query race, crash recovery and refund reconciliation PASS.
- Isolated PostgreSQL test: all 56 migrations applied; duplicate Payment request, single-success transition, PaymentLog provider trace and concurrent different-requestKey refund guard PASS.
- POS iPad/WebKit suite: PASS 27/27, including live-gated Alipay scan and 375 px pending-channel lock.
- Candidate production-mode build: PASS; Prisma schema validation and `git diff --check`: PASS.
- Dependency review: Alipay SDK transitive `urllib` pinned to fixed 4.9.1; no Alipay-introduced npm advisory remains. Other audit findings predate this candidate and were not changed out of scope.
- Full legacy test runner: 85 scripts passed and 6 pre-existing stale scripts failed. Five assert the obsolete fixed migration count 55 or stage only a subset before the later safe-delete migration; one expects an obsolete deployment-script phrase. The same contradictions exist at the candidate base commit and are unrelated to payment behavior, so they were not modified.

## Rollback contract

- Candidate is not routed and production remains on SHA `35951cfdc8b24f0291b157a25ccf097f6e7c4522`; immediate rollback is therefore already the active production state.
- There is no database rollback because there is no migration and no production data write.
- Keep `ALIPAY_ENABLED=0` and omit Alipay secrets until a separately authorized production cutover Gate.
- If a later cutover is rejected, route back to the retained production container/image and verify health, writer count, migration ledger and the payment reconciliation queries before reopening POS.

## STOP

Reviewer authorization is required before any production flag change, nginx switch, real Alipay payment or real refund.
