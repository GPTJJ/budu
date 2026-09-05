# SWEET_CARD_AUTHORITY_MAP

Status: Production authority through Commercial Release R1. Commercial issuance
remains disabled pending an explicit launch action and approved batch inputs.

## Existing authorities

| Domain | Canonical authority | Sweet Card integration |
| --- | --- | --- |
| Operator identity | PostgreSQL `User.id`; module permissions in `User.permissions` | Dedicated `sweetCard` capabilities; POS redemption continues to require `store-pos`. |
| Store | PostgreSQL `Store.key` | `Store` has no ownership/direct-store field. A fail-closed `SweetCardStorePolicy` keyed by `Store.key` records eligibility; no store-name or four-store hardcoding. |
| Product | PostgreSQL `InventoryItem.id` | Reused without copying product data. |
| Category | PostgreSQL `ProductCategory.id` | Default allow; deny policies use the stable category id. Names remain display-only. |
| Order | PostgreSQL `Order.id` | One order remains the sale authority. Sweet Card is an internal tender linked to the same order, never a second Order or payment provider. |
| Payment | PostgreSQL `Payment` and `SettlementCoordinator` | External/cash Payment settles only the remaining amount. Exact invariant: `Order.payableAmount = SweetCardRedemption.amount + Payment.amount`. Existing orders retain zero Sweet Card amount and unchanged behavior. |
| Refund | PostgreSQL `Refund` / `RefundItem` | The same Refund request allocates its total deterministically between provider refund and restoration to the original value account. Item allocations are based on checkout snapshots. |
| Payment audit | `PaymentLog` | Provider events stay here. Sweet Card domain events use `SweetCardAuditLog`; no fake provider or fake Payment row. |
| Customer/member | `Member.id` is the only stable customer-like id; no verified self-service login/binding flow exists | Admin binding can reference an existing Member id and records verification metadata. Recipient free text is never identity. A future self-bind hook is provided; no second customer directory or SMS system is created. |
| Reporting | Order facts and report-center PostgreSQL queries | Card issuance is excluded from sales. Completed POS orders remain sales; settlement composition adds Sweet Card from redemption facts. |
| Batch purpose | `SweetCardBatch.businessPurpose` (`SweetCardBatchPurpose`) | Closed values distinguish `ACCEPTANCE_TEST` from `COMMERCIAL`. Names and free-text notes are never classification authority. |

## New authorities

- `SweetCardAccount` is the stable value account and balance projection.
- `SweetCardLedger` is the immutable monetary authority (`ISSUE`, `REDEEM`, `REFUND`, `REVERSAL`). Every projection change occurs in the same locked transaction as a ledger entry.
- `SweetCardCredential` is replaceable and separate from value. The database stores a verifier plus encrypted recovery material, never a directly consumable plaintext token.
- `SweetCardRedemption` and item allocations freeze checkout-time category eligibility and tender allocation.
- `SweetCardStorePolicy` is deliberately fail-closed because the existing Store authority lacks an ownership attribute.
- `SweetCardCategoryPolicy` is default-allow and only stores authoritative `ProductCategory.id` deny rules.
- `SweetCardBatch.businessPurpose` is required for every batch. Commercial
  operation reports default to `COMMERCIAL`; acceptance views explicitly select
  `ACCEPTANCE_TEST`; financial/Ledger reconciliation always includes all real
  facts regardless of purpose.

## Settlement and refund contract

At redemption, the service takes a PostgreSQL advisory transaction lock for the value account and order, verifies store, credential, binding, expiry, one-card-per-order and item eligibility, then writes the redemption, item allocation, ledger entry and balance projection atomically. It never allows a negative balance.

For mixed tender, Payment amount is the exact remainder. The settlement coordinator accepts a successful Payment only when `payment.amount + order.sweetCardAmount == order.payableAmount`. A Sweet-Card-only order is completed by the same coordinator through an internal-tender method.

Refund allocation uses original order-item Sweet Card allocations and cumulative refunded quantities. Restored Sweet Card cents are idempotent and cannot exceed the original redemption. Any external remainder follows the existing provider refund authority. Historical category state is never re-read for refund calculation.

## Security and rollout

- QR namespace: `budu:sc:v1:`; payment barcode routing checks this before WeChat/Alipay patterns.
- Credentials use high-entropy random tokens. Logs, audit metadata and normal list/detail APIs omit them.
- QR export is capability-gated, audited, generated as a private download, and requires a local encryption key.
- `SWEET_CARD_ENABLED` defaults off and all mutation/redemption endpoints fail closed when disabled.
- Initial Migration 63 is additive: new tables, enums, nullable snapshot columns
  and zero-default projections only. Migration 65 adds the typed batch-purpose
  field and backfills only the verified pre-commercial batches as
  `ACCEPTANCE_TEST`; it does not rewrite any economic amount or event.
