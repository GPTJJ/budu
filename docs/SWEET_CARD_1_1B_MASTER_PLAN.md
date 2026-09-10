# Sweet Card 1.1B master delivery plan

Authority: user MASTER DELIVERY DIRECTIVE, 2026-09-11. Mode STRICT.
Scope is the complete checkout → reservation → verified settlement → fulfillment
→ source-correct full/partial refund chain. A component test is not delivery.

## Current baseline

Directly revalidated 2026-09-11: Production OS
`95cd9ce48b25de35570cc6f1f07154ab2e13cb78`; `budu_bj006`; migrations 70/0;
public health ok/dbOk; one running application targets that database.
Ledger sum and balance projection both 1,300,110 cents. Public Claim ON,
allowlist-only OFF remain protected. No production mutation in this task.
MiniProgram 3.5.1 is evidenced by the user's platform screenshot, not a source
hash attestation. CloudBase deployed sources were downloaded read-only for G0.5.
New MP worktree starts at `1332ab8` to retain the deployed refund repair and
short-scene compatibility. Local code is not assumed to equal deployed code.

## Architecture decisions

| Decision | Reason and authority | Invariant | Migration / rollback | Required evidence |
|---|---|---|---|---|
| PG financial settlement; CloudBase commerce mirror | User sections 3/9/30; existing PG ledger | No cross-database financial commit | Additive settlement/outbox; old orders unchanged | Native transactions, failed mirror retry |
| Stable external order identity | Existing CloudBase commerce compatibility | One checkout identity, one financial truth | Unique namespace + external ID; preserve history | Duplicate checkout, wrong-owner denial |
| Reserve then capture | User FIN-06–09 | Unpaid order has no economic debit | New holds; existing Ledger REDEEM/REFUND semantics | Account-level reconciliation, POS race |
| One card; shipping WeChat only | User section 6 supersedes Gate 0 shipping recommendation | SC <= eligible net merchandise; no SC shipping | Immutable quote/tenders | Integer boundary and allocation tests |
| Online eligibility separate | User section 24 | POS eligibility never implies online | Explicit channel/product policy; defaults deny | Blacklist/status/ownership/expiry tests |
| Verified provider truth | User sections 16–19 | Client success cannot settle | New provider identity/state facts | Signature, amount, merchant, currency, payer tests |
| Cancellation vs settlement serialized | User section 18 | Late payment is compensation, not fulfillment | Forward reconciliation; no history deletion | Native cancel/callback/expiry races |
| Cumulative proportional refunds | User section 21 | Refunds return original sources; exact final cent | Persist allocations; pending consumes limit | Parallel/full/partial/refund callback tests |
| Durable outbox | User section 30 | Mirror failure cannot undo money | Retryable versioned events | Crash/restart and out-of-order mirror tests |
| Independent rollout OFF | User section 25/48 | 1.1A/POS unaffected; in-flight recovery persists | Schema retained on code rollback | Flag OFF + old runtime compatibility |

Product identity is explicit, never inferred by name. CloudBase catalog prices
may be consumed only through the authenticated server adapter with immutable
snapshots; online policy and any OS InventoryItem mapping must be explicit.
No frontend price, SKU, discount, shipping, ownership or final-state authority.

## Gates and proof of completion

| Gate | Deliverable | Completion evidence |
|---|---|---|
| G0.6 | Existing WX safety repair | Verified responses/notifications, guarded transitions, unique identities, real endpoint configuration; no regression of repaired refunds |
| G1 | Contract freeze | Versioned API/identity/pricing/state/refund/outbox/rollout contract reviewed |
| G2 | Additive models/migration | Prisma validation, native migration up, constraints, old-code reads |
| G3 | PG orchestrator | Reserve/capture/release, immutable tenders, verified provider, compensation, outbox |
| G4 | Checkout | Authoritative quote, one card, three tenders, server-confirmed success |
| G5 | Refund engine | Persisted cumulative allocation, pending/success separation, original-source credit |
| G6 | Fulfillment/logistics | Paid-only fulfillment, address/carrier/tracking/timeline when available |
| G7 | Certification | Native PG concurrency, crash/retry, zero unexplained cents, full critical regression |
| G8 | Current production integration | Rediscover live SHA; exact accepted commits only, preserve newer hotfixes |
| G9 | Fresh clone | Fresh backup/restore, migrations, historical summaries, rollback compatibility |
| G10 | Controlled deploy OFF | All prior gates PASS, migration explicitly first, exact runtime and closed online flag |
| G11 | Human E2E | Real WX-only/SC-only/mixed/cancel/full/partial/logistics with controlled identities |
| G12 | Public rollout | All explicit release criteria, privacy and MiniProgram release satisfied |

## Safety and delivery boundaries

No production payments/refunds, customer phone actions, secret disclosure or
platform owner actions are performed by automation. A manual endpoint/config
step is recorded while safe code/test work continues. No automatic Claim flag
change, no test card issuance in production, no destructive rollback.
Conditional deployment authorization is usable only after G0.6–G9 evidence.
Backup, clone and rollback are currently UNVERIFIED for this new candidate.

## Skills routing

Used OS: task-router, context, data-authority, sweet-card (+ business contract),
payment-safety, regression, production-deploy, handoff. Used MP: task-router,
context, data-authority, payment-safety, cloudbase, api-contract, security,
regression. Read mobile/runtime/release/browser skills when executing those
stages. Historical skill baseline statements do not override live evidence or
the explicitly approved integration contract.
SKILL_NOT_AVAILABLE: dedicated Order, Refund, Logistics, PostgreSQL, Prisma,
Concurrency, Migration skills. Their requirements are covered by the above
domain skills and existing repository implementation/tests, not omitted.

## Terminal audit

Before any terminal READY claim, inspect each gate's actual evidence and every
FIN-01–20 invariant. Include authoritative pricing, holds, captures, three tender
types, verified callback, late payment, both refunds, source allocation, native
concurrency, reconciliation, logistics, privacy, 1.1A and Partner preservation,
exact artifact/runtime identity, flags, rollback and human E2E. Missing or
indirect evidence remains UNVERIFIED; do not substitute unit tests for live E2E.
