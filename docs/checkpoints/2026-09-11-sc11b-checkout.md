# G3 quote/reservation/card-only candidate

Local implementation; no route/provider deployment.

Implemented server quote/submit primitive in online-checkout.js. Catalog input is
obtained only from injected internal resolveCatalog adapter, never forwarded from
customer monetary fields. Customer intent whitelist contains SKU/quantity,
fulfillment/address reference, one walletRef and desired integer cents. Existing
Claim.id/User.id is wallet authority. Server checks active user, online flags,
claim ownership, current binding, card state/validity, account online policy and
available balance under canonical account lock.

Online product policy uses explicit external SKU -> InventoryItem identity and
separate enabled flag; canonical product identity is frozen in quote and rechecked
at submit. Existing category blacklist is not bypassed. Prices are frozen, not
recomputed after submit. Quote and checkout keys bind to immutable fingerprints.
Duplicate key with changed intent rejects; duplicate quote has unique settlement.

Mixed submit creates RESERVED without Ledger debit. Card-only creates CAPTURED,
REDEEM Ledger, balance projection, SUCCEEDED card tender, PAID and outbox within
one Serializable transaction. WX-only needs no card or reservation. Provider
prepay/verified settlement remains next work, not implemented by this primitive.

VERIFIED: native PG16.14 synthetic checkout tests13/13, including same-card
reservation race, concurrent duplicate capture, WX-only double-key/one-quote
uniqueness (not merely EXHAUSTED guard), ownership, frozen card, revoked product
policy, client-price rejection and feature-OFF replay. Each fixture reconciles
account amounts where money/holds tested. Real provider is not called.

Independent read-only review: no proven money/identity violation in primitive;
requested stronger quote uniqueness test, now added. Scope limitations remain:
- actual CloudBase catalog/pricing adapter, stock and durable commerce draft
- stable fulfillment/store identity and immutable delivery context
- HTTP customer identity/DTO integration
- prepay, callback/query, cancellation/expiry/compensation recovery
- refunds, fulfillment, UI and full G7–G12 certification

Do not expose this primitive to customers until those integration requirements
are implemented. Current externalOrderId is settlement identity reserved for the
future mirror; existing CloudBase domain must establish its durable mapping.
No production data/config/code mutation; no production migration.
