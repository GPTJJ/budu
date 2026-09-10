# Sweet Card 1.1B financial contract v1

Status: candidate contract, implementation/certification incomplete.
Authority: user master directive; supersedes earlier audit shipping alternatives.

## Trust and APIs

The existing signed CloudBase gateway and customer session resolve `User.id`.
Never accept userId/openid/card ownership from a customer body. CloudBase resolves
catalog/SKU IDs and server prices from the current catalog authority; PG accepts
that catalog envelope only through the authenticated server adapter, not a
public quote endpoint. The adapter constructs it from a whitelist of client
intent fields and cannot forward client price/eligibility fields.

New namespace `/api/v2/miniprogram/checkout` uses the existing gateway signature,
environment binding and customer bearer session. Do not relax the 1.1A router.
Every object read checks stable User.id. Merchant operations require a separate
capability check and never trust a client `isMerchant` Boolean.

| Operation | Intent | Authoritative result |
|---|---|---|
| POST /quotes | productId/skuId/quantity; delivery intent; optional walletRef and desired cents | Expiring quote ID, copied server item snapshot, shipping, eligible net goods, SC/WX allocation |
| POST /settlements | quoteId + requestKey | Same existing settlement on retry, or single newly reserved/paid settlement |
| GET /settlements/:id | Identity only | Financial state, immutable tenders/refunds and retryable confirmation status |
| POST /settlements/:id/cancel | requestKey | Serialized cancellation/close workflow; paid orders reject cancellation |
| POST /settlements/:id/reconcile | No client payment claim | Provider query processed by the same verified finalizer |
| POST /settlements/:id/refunds | Merchant-approved line quantities and freight refund intent + requestKey | Persisted original-source allocation and pending/settled status |

Provider payment/refund notifications are separate public HTTPS routes. Preserve
the raw body, verify RSA signature/key identity/timestamp/nonce before parsing,
decrypt resource and validate event, currency, merchant, AppID, immutable amount,
trade/refund identity, payer and state. A signed response from one order cannot
settle another. No unsigned error response becomes authoritative failure.

Checkout request keys are scoped by User.id and bound to an immutable request
fingerprint. A reused key with different input returns a safe 409. IDs are random
and opaque. Retry never creates a second provider payment. Amount strings in
JSON are canonical nonnegative integer cents (bounded at 2,000,000,000); no float
arithmetic. New purchases require the online flag; recovery of existing intents
does not, so disabling rollout cannot strand money.

## Data and transaction contracts

Planned additive PG concepts:

- `OnlineCheckoutQuote`: User FK, immutable quote/snapshot, expiry, request hash.
- `OnlineSettlement`: unique external namespace/order ID, User FK, one quote,
  immutable total/eligible/shipping/SC/WX, state/version/expiry.
- `SweetCardReservation`: account/User/settlement FKs, positive amount, unique
  settlement/request identity, RESERVED/CAPTURED/RELEASED/EXPIRED timestamps.
- `OnlineTender`: one SC and one WX maximum per settlement; immutable allocated
  amount, provider identities/prepay/state/verified settlement evidence.
- `OnlineRefund`: request uniqueness, original allocation, pending occupancy,
  cumulative goods/SC allocation, provider refund identity, completion evidence.
- `OnlinePaymentCompensation`: unique verified late provider transaction,
  actual WX amount, deterministic provider refund ID, PENDING/SETTLED evidence;
  independent of merchandise refund capacity (the order may never have paid).
- `OnlineOutbox`: unique event identity, settlement/version, retry/lease/error;
  no raw provider secret, payer or recipient PII in ordinary logs.

Capture and refund credit append to existing `SweetCardLedger` using REDEEM and
REFUND respectively. Link their unique ledger IDs from new financial facts;
metadata contains the stable settlement/refund identity. Never invent a fake POS
Order/cashier or POS credential to satisfy old table foreign keys. Historical
POS order/refund contracts stay untouched. New ledger rows must be included in
global reconciliation without changing existing POS-specific joins. Unique ledger
FKs and deferred constraints must prove matching account, type and signed amount
for every capture/credit; metadata alone is not a monetary constraint. Existing
POS Payment/Refund triggers do not certify the new online financial facts.
Provide a separate online settlement/refund report plus combined per-account
ledger reconciliation. Keep existing POS redemption reports explicitly POS-only;
do not silently omit online debits from a report labeled all-channel.

Lock order for online transactions: settlement advisory lock → account advisory
lock (existing `lockSweetCardAccount`) → re-read. Refund locks settlement first.
POS already locks POS order then the same account; it must deduct active holds
from spendable value. No path locks an account and then waits for another order.
Serializable failures retry the whole DB unit with a bounded policy; network
calls stay outside transactions and retries use original merchant identities.

Quote may show current availability, but checkout revalidates under account lock.
Expired holds remain occupied until provider reconciliation authorizes release.
An expired timestamp alone never frees spending power.
After reservation, freezing/loss/ownership revocation can invalidate capture.
If provider money is then verified, persist compensation-required state and
refund the received WX tender without SC capture; do not throw away the provider
fact behind an eligibility error. A provider payment made within the snapshotted
validity interval may settle after a delayed callback; validate provider success
time as part of that contract. Ambiguous time/authority retains reconciliation.

## States and races

| Current | Verified event | Result |
|---|---|---|
| CREATED/PENDING | WX SUCCESS or SC-only local capture | PAID + capture once + paid outbox |
| PENDING | Cancel request wins lock | CLOSING; provider close/query pending, no fulfillment |
| CLOSING | Verified unpaid/closed | CANCELLED + RELEASED |
| PENDING/CLOSING | Verified paid before release | PAID + CAPTURED; cancellation cannot overwrite |
| CANCELLED/EXPIRED after release | Verified late paid | RECONCILIATION_REQUIRED + compensation intent; no SC capture or fulfillment |
| PAID | Duplicate same payment | No-op; preserve later fulfillment/refund state |
| PAID/PARTIALLY_REFUNDED | Approved refund | Refund PENDING occupies allocation |
| Refund PENDING | Verified external refund success | Original-account SC credit once + refund SETTLED |
| Refund PENDING | Provider PROCESSING/unknown | Remain pending, query/retry same provider identity |

Provider CLOSE cannot be inferred from timeout or NOTPAY alone when racing a
payment. Close then query/reconcile; ambiguous outcomes retain holds. A late
payment after released cancellation creates a WX-only compensation for the
actual received WX amount. It is not a merchandise refund and does not credit SC.

## Refund allocation

Server translates approved line quantities into immutable snapshot net amounts;
caller never chooses eligible cents or tender destination. Count pending and
completed allocations while holding the settlement lock. For eligible goods:

`cumulativeSC = floor(cumulativeEligibleRefund * originalSC / originalEligible)`.

The current refund is the difference from prior cumulative SC. Full eligible
refund reaches original SC exactly. Ineligible goods and freight always return
via WX. Later intents depend on earlier cumulative positions, so a failed
provider attempt retries its original refund intent; do not delete its occupied
allocation or recompute successors. Zero-WX refund settles locally atomically.
For discounted multi-quantity lines, refunded net cents are the delta of
`floor(cumulative refunded quantity * original line net / original quantity)`.
Persist line quantity occupancy with pending intents and force the final quantity
to return the exact line net. Never floor each independent partial refund.

## Mirror and fulfillment

The transaction emits a versioned outbox event only after authoritative state
change. CloudBase applies each event idempotently and ignores older versions.
It cannot declare PAID from client events or ship a new online settlement while
PG is unpaid/reconciling. A failed mirror is retryable; no economic reversal.
CloudBase retains recipient/address/fulfillment authority. Minimum shipment
adapter records carrier/tracking/state; timeline optional when provider absent.
Money settlement does not depend on tracking-service availability.

## Certification and rollback

Required proofs: Native PG same-account reservation versus POS, duplicate
checkout/callback/capture, cancellation/expiry/provider races, full/partial
refund races, serialization retries and process crash at every boundary.
Reconcile per-account ledger, active holds, captures, original tenders, refunds,
compensation and outbox versions. No summed-only reconciliation that hides two
opposite account discrepancies.

Additive migration rehearsed on fresh isolated restore; verify historical domain
summaries and old-runtime reads. Deploy migration explicitly before runtime.
Online flag stays OFF. Once facts exist retain schema, keep reconciliation
workers runnable and use forward fixes/code rollback without deleting facts.
The rollback runtime MUST retain hold-aware POS availability plus recovery while
any reservation is active. Baseline95cd9ce ignores holds and is NOT a safe
rollback target with active reservations. Reverting to it requires verified
provider reconciliation and draining every reservation first; flag OFF alone is
insufficient. This must be rehearsed in G9.
Real-money E2E and platform owner steps remain human-only.
