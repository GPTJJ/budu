# budu SKU Authority 1.0 — candidate contract

Status: non-production candidate. The repository baseline is
`5ad27a06d731fbc94de5ae3776060b4350b886e8`; this is **not** proof of the
complete running production identity, database, migration ledger, or rollback
asset. No production migration or cutover is authorized by this document.

## Authority and identity

| Fact | Authority |
| --- | --- |
| Product identity and current product fields | PostgreSQL `InventoryItem.id` |
| Current internal SKU | `InventoryItem.sku`, allocated by the server and recorded once in `ProductSkuAssignment` |
| Next BD/TP number | PostgreSQL `ProductSkuSequence`, one locked row per prefix |
| Historical SKU search | PostgreSQL `ProductSkuAlias`, read-only lookup to `InventoryItem.id` |
| Mini-program identity | Existing `OnlineProductPolicy` external IDs; `productId` still references `InventoryItem.id` |

AUTHORITATIVE_SOURCE = PostgreSQL `InventoryItem` and the SKU allocation records.
WRITER = product creation service; the controlled migration is the sole historical
exception. STABLE_ID = `InventoryItem.id`. STATE_TRANSITION = unassigned legacy
SKU → assigned current BD/TP SKU once; new product → assigned SKU once; disabled
product → re-enabled with the same ID/SKU. CONCURRENCY_GUARD = transaction and
row-locked sequence allocation, unique SKU/assignment/alias constraints, product
version CAS for edits. ROLLBACK/REVERSAL = restore a verified pre-migration
database backup before any subsequent writes. An application-only rollback
while retaining the additive schema is permitted only after an old-writer
compatibility rehearsal proves it can read the new SKUs and respects the
immutable-name/SKU guard. Never casually reverse an allocated SKU or reuse a
number.

The canonical format is `^(BD|TP)-\d{6}$`. `BD` means budu-owned; `TP` means
external brand. The currently confirmed third-party sources are `森醒` and
`12 样商店`; other products default to `BD`. The prefixes have independent
monotonic series starting at `000001`. The server allocates numbers; neither
page, POS, import, transfer, Partner, nor mini-program is an allocator.
Numbers are never recycled, including after cancellation, deactivation or
deletion. A new SKU cannot equal a reserved canonical SKU or legacy alias.
`barcode` remains the manufacturer's barcode, not a budu SKU. No second
persistent origin/brand authority is added; creation accepts a one-time source
choice solely to select the sequence.

## Product lifecycle

An advanced administrator can propose an override only in the initial create
request. The server checks role, exact format, chosen prefix, canonical and
alias occupancy, and records actor/time/reason. After creation, SKU and formal
name are immutable. A formal name change creates a new `InventoryItem.id` and
new SKU; the old product is disabled and retained. Re-enabling the same named
disabled product restores that exact ID/SKU. Packaging design, recipe or price
changes do not allocate a SKU. An independently sold form or promotion bundle
is a separate product. NO.1–NO.12 candy flavors are separate products/SKUs.
The current `InventoryItem.name @unique` remains in force; name alone must not
be used to upsert or silently link imported products.

Existing `transferCode` is compatibility presentation only. New internal
business snapshots take the current SKU from the `InventoryItem.id` row; old
`TransferItem.itemCodeSnapshot`, `OrderItem.skuSnapshot`, Partner and
Replenishment snapshots are immutable and never backfilled. A legacy alias can
find a product in read-only search, but is never accepted as a current SKU,
write identity, import/upsert key or transfer/partner authority. The mini-program
keeps `c1/s1/g24`, `externalProductId`, `externalSkuId` and menu codes unchanged;
existing active mappings must still resolve their `productId` after migration.

## Controlled mapping and release gate

All 178 products in the 2026-09-27 UI audit, including 65 disabled products,
are expected in migration. That audit observed 113 enabled and 33 missing SKU,
with no duplicate nonempty SKU. These are dated observations, not an executable
database snapshot. Before allocation, a single read-only authoritative extract
must confirm count/status/SKU drift, IDs, names, `createdAt`, category/brand
basis, existing SKU, `transferCode`, and online mappings. Classification must
use the confirmed third-party categories/brand evidence; any ambiguous row
stops the affected mapping. Within each prefix sort by `createdAt ASC`, then
`InventoryItem.id ASC`; produce an immutable mapping artifact with old/new SKU,
ID, active state, classification basis, transfer code before/after and alias.
Verify its digest and expected count at apply time. Allocation, alias creation,
SKU update and audit must be one transaction with an explicit actor, timestamp
and reason. The operation must fail closed on drift, occupied codes or aliases.

Production release requires a fresh backup and verified restore route, complete
runtime SHA, application-runtime read-only database probe, migration ledger,
single writer, release image and rollback assets. Reconcile any new production
deployment before building a release candidate. Apply the schema and data
migration only under separately authorized production gates. Reconcile exact
`InventoryItem.id` sets, SKU uniqueness, aliases, unchanged historical
snapshots and unchanged online external IDs/product mappings before cutover.

Inventory 1.0 remains out of scope: no stock pool, POS stock decrement,
StockBalance/StockLedger behavior, candy inventory logic, or inventory authority
transfer is introduced here.
