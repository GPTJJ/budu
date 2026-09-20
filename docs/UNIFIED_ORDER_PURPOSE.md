# Unified order purpose and controlled test deletion

`ReplenishmentOrder.purpose` and `TransferRequest.purpose` use the same PostgreSQL
`OrderPurpose` enum: REAL, TEST, ACCEPTANCE_TEST, LEGACY_UNCLASSIFIED. No secondary
test flag is introduced. Migration 84 backfills existing rows as unknown, then
changes the insert default to REAL in the same transaction. Existing fields and
the original 83 migrations are unchanged.

The user explicitly confirmed that existing `admin` means super_admin for this
feature. The new narrow permission permits active developer/admin, using the
current database User on every server operation. Finance, manager, staff, HR,
customer and Partner principals are denied. No role/account is upgraded.

Settings → 订单用途与测试清理 provides per-order classification, separately labelled
purpose correction, explicit TEST/ACCEPTANCE_TEST copies using existing product
and store selections, and reason-required permanent deletion. Partner copies use
the normal submission/pricing service; transfer copies use the normal transfer
creation validation. Ordinary creation cannot set purpose. Test creation does
not send real WeCom notifications. Normal REAL/legacy notification routing is
unchanged. The original business lifecycle is unchanged.

Safety scans reject economic references, stock facts, fulfillment, after-sales,
and notification obligations. All existing shipment/notification records are
conservatively retained: there is no independent proof that these represent
test-only external effects. An order's TEST purpose is never taken as proof that
its shipment or delivery was harmless. This release therefore only physically
deletes headers/items for orders with zero such effects; it does not erase
shipment, notification, Partner audit, or financial history. Payroll/report
sources have no reference/writer from these two order domains in this release.

Classification/correction/deletion run in serializable transactions with an
exact parent row lock and fresh scan. Permanent OrderPurposeAudit stores actor,
role, reason, before/after purpose, safe snapshot, scan, deleted counts and
transaction identity. DB triggers reject unaudited changes, test inserts without
creation audits, non-test deletion and audit modification. The two previous
Partner blanket deletion triggers are replaced only by exact-order,
same-transaction audit guards. Existing lifecycle/snapshot guards stay intact.
Notification insertion locks its parent and rejects missing/test parents,
preventing a delayed notification from appearing after deletion/classification.

Repeated deletion returns 404 ORDER_NOT_FOUND_OR_DELETED; concurrent changes
return 409. Deleted-order creation replay is blocked by permanent audit
tombstones. Partner audit records remain available independently of the order.
The management center displays permanent operations even after order deletion.

Deployment rollback: retain the old exact application image and nginx configs.
This additive schema is compatible with the previous application (omitted
purpose defaults to REAL). Prefer application-only rollback on ledger 84;
never restore a pre-cutover backup after public traffic resumes. No production
classification, test creation or deletion is part of rollout. A frozen backup,
isolated restore, 83→84 replay, and before/after fact hashes are release gates.

Targeted validation: `scripts/test-order-purpose-native.mjs` uses a loopback
disposable PostgreSQL database, replays 83 migrations, seeds history, applies
migration 84 through Prisma, and exercises real HTTP/DB operations, concurrent
requests, rollback failure injection, audit retention and protected fact hashes.
`tests/order-purpose-harness.html` is isolated UI test data only.
