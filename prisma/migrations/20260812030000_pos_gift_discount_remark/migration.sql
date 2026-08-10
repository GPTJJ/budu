-- POS gift / discount / remark.

ALTER TABLE "orders"
  ADD COLUMN "discount_percent" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN "remark" TEXT NOT NULL DEFAULT '';

ALTER TABLE "order_items"
  ADD COLUMN "is_gift" BOOLEAN NOT NULL DEFAULT false;
