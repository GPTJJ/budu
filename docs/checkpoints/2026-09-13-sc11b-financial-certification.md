# Sweet Card 1.1B — isolated financial certification

Reviewed 2026-09-13. Candidate scope only; no Production deployment, configuration,
business data, payment, refund, or MiniProgram release operation occurred.
This checkpoint does not certify deployed WeChat or CloudBase infrastructure.

## Authority and delivered integration

Continuation of OS `86a23e7bf05aa4e143c2ba2b1f87e77ced36f523` and MiniProgram
`77c91456030d961a0df1f636ea1122d9c50ca607`, both `codex/sweet-card-1-1b`.
PostgreSQL remains the sole financial authority. Existing quote/reservation/
immutable tender/capture/outbox core is retained. All amounts are integer cents.

- Actual CloudBase entry-point code supports capabilities, quote, submit,
  prepare, confirm/query, cancel, customer refund intent, merchant approval and
  fulfillment. Customer runtime identity and PG user identity remain distinct,
  authenticated authorities; client amounts never replace server amounts.
- Client payment success only starts server confirmation. Closing the page
  cannot subsequently open payment. A durable user-scoped reference preserves
  original request identities through lost acknowledgments and app restart.
  It contains no secret, amount or local payment conclusion.
- Expired quote recovery is definitive only after the original settlement is
  proven absent under the same advisory lock. Ambiguous network outcomes retain
  their original request identity.
- Refund intents use original quote item quantities and immutable cumulative
  proportional allocation. Shipping refunds return through WeChat only.
- WeChat refund acceptance/PROCESSING is not completion. Original refund number
  recovery verifies signed query/notification evidence. Verified SUCCESS credits
  the original card once; SC-only refunds settle in a single local transaction.
- Refund allocation, approval actor/reason and fulfillment authorization are
  immutable. Concurrent full/partial refunds cannot overallocate. Late-payment
  compensation returns WeChat funds only and never credits a card.
- Merchant authority stays in the existing CloudBase merchant allowlist/PIN
  contract. A separate gateway key attests only narrow merchant routes; the
  customer gateway key cannot approve refunds or authorize shipping. PG resolves
  the stable actor and rechecks active status within the transaction.
- Fulfillment locks the settlement and requires paid, reconciled tenders with
  no pending refund/compensation. Carrier/tracking use the existing commerce
  fulfillment receipt, separate from the financial mirror. No second logistics
  provider or invented tracking events were added.

## Migration scope

Native PostgreSQL 16.14, loopback-only `budu_sc11b_native`, has 73 migrations.
Two additional additive candidate migrations in this checkpoint:

1. `20260913010000_online_fulfillment_authorization`: immutable authorization.
2. `20260913020000_online_refund_approval_reason`: nullable immutable audit reason.

They are applied only to the isolated synthetic database. Production migration
count and runtime SHA were not re-read in this phase and remain UNVERIFIED now.
The earlier 70-migration Production observation is historical evidence.

## Direct local evidence

- Online integration suite: 183/183 PASS, including real native PostgreSQL
  constraints, concurrent payment/cancellation/refund transactions, crash/retry,
  raw signed callback/query verification and cross-repository HTTP handlers.
  This count also includes unit/transport cases, not 183 separate native tests.
- Companion MiniProgram: 235/235 PASS, including 82 frontend cases. Local
  Production-target packaging PASS; not compiled/uploaded by WeChat DevTools.
- Actual existing POS redemption versus online reservation: reservation-first,
  simultaneous race and POS-first all PASS under native PostgreSQL.
- Existing protected unit/provider regression: 197/197 PASS across Sweet Card,
  Claim/POS, payment, WeChat, Alipay, reconciliation, permissions and POS core.
- OS production build: PASS. No build was deployed.
- Broad critical runner: 48 files passed initially; 20 additional database files
  passed after using the isolated PostgreSQL connection instead of absent port
  5432. Eleven unchanged baseline test files remain stale/unrelated failures;
  see the regression exception record. They are not reported as passing.

Provider messages use synthetic RSA/AES fixtures; no real provider money moved.
CloudBase code is exercised with offline transactional adapters and HTTP
contracts. Deployed CloudBase SDK/ACL/index/routing behavior remains a release
verification requirement, not a claim made by local tests.

## Machine reconciliation

Run `scripts/reconcile-online-isolated.mjs` with `SC11B_NATIVE_CONFIG` pointing to
the private loopback configuration. The script rejects any other database target
and exports counts only. It checks settlement/tender totals, refund allocation
caps, capture/refund ledger facts, per-account ledger balance and reserved funds.

Current run: 627 synthetic settlements, 325 settled, mismatch count 0,
monetary delta 0 cents. Pending refund/compensation and expired reservation
fixtures are deliberately retained by failure tests. `operationallyClear=false`
is explicit: this accumulated test database is not an operational backlog
certification. Tests verify bounded recovery and safe handling of each scenario;
unknown provider outcomes must never be force-released merely to clear a count.

## Remaining external/release gates

- Fresh Production runtime/Git authority rediscovery and a Production-compatible
  database clone migration rehearsal with historical comparison have not run.
- Provision/verify separate merchant signing configuration and private CloudBase
  collections/indexes/ACLs, payment/refund notify HTTP mappings, mirror endpoint,
  and real merchant/AppID/key binding before controlled release.
- Entire runtime must remain enabled while obligations exist; the new-purchase
  switch can be OFF without disabling query/cancel/refund/recovery.
- Native WeChat device checkout/payment/refund and current privacy declaration
  confirmation remain manual controlled-release boundaries. Historical privacy
  screenshots are not evidence of current approval.
- Logistics carrier/tracking presentation is implemented. Provider event feeds
  are unavailable in the existing capability and are not fabricated.

No public rollout, new real test card, real payment/refund, Production migration,
or MiniProgram upload/review was performed. Full 1.1B completion is not claimed.
