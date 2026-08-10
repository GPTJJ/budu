-- POS phase 1 is additive: existing inventory items remain valid and keep SKU = NULL.
ALTER TABLE "InventoryItem"
  ADD COLUMN "sku" TEXT,
  ADD COLUMN "posCategory" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "salePriceCents" BIGINT,
  ADD COLUMN "costPriceCents" BIGINT,
  ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "trackInventory" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX "InventoryItem_sku_key" ON "InventoryItem"("sku");

CREATE TABLE "orders" (
  "id" TEXT NOT NULL,
  "order_no" TEXT NOT NULL,
  "store_id" TEXT NOT NULL,
  "cashier_id" TEXT NOT NULL,
  "cashier_name_snapshot" TEXT NOT NULL DEFAULT '',
  "subtotal" BIGINT NOT NULL DEFAULT 0,
  "discount_amount" BIGINT NOT NULL DEFAULT 0,
  "payable_amount" BIGINT NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "payment_status" TEXT NOT NULL DEFAULT 'unpaid',
  "payment_method" TEXT,
  "payment_mode" TEXT NOT NULL DEFAULT 'mock',
  "checkout_key" TEXT NOT NULL,
  "cart_hash" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "order_items" (
  "id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "product_id" TEXT NOT NULL,
  "product_name_snapshot" TEXT NOT NULL,
  "sku_snapshot" TEXT NOT NULL,
  "unit_snapshot" TEXT NOT NULL DEFAULT '',
  "unit_price" BIGINT NOT NULL,
  "cost_price_snapshot" BIGINT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "line_amount" BIGINT NOT NULL,
  CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "orders_order_no_key" ON "orders"("order_no");
CREATE UNIQUE INDEX "orders_checkout_key_key" ON "orders"("checkout_key");
CREATE INDEX "orders_store_id_created_at_idx" ON "orders"("store_id", "created_at");
CREATE INDEX "orders_cashier_id_created_at_idx" ON "orders"("cashier_id", "created_at");
CREATE INDEX "orders_status_payment_status_idx" ON "orders"("status", "payment_status");
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");
CREATE INDEX "order_items_product_id_idx" ON "order_items"("product_id");

ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_fkey"
  FOREIGN KEY ("store_id") REFERENCES "Store"("key") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
