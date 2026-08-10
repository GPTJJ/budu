-- Item-level refunds: unique refund request key + refund_items table.

ALTER TABLE "refunds" ADD COLUMN "request_key" TEXT;
UPDATE "refunds" SET "request_key" = 'legacy-' || "id" WHERE "request_key" IS NULL;
ALTER TABLE "refunds" ALTER COLUMN "request_key" SET NOT NULL;
CREATE UNIQUE INDEX "refunds_request_key_key" ON "refunds"("request_key");

CREATE TABLE "refund_items" (
  "id" TEXT NOT NULL,
  "refund_id" TEXT NOT NULL,
  "order_item_id" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "amount_cents" BIGINT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "refund_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "refund_items_quantity_positive" CHECK ("quantity" > 0),
  CONSTRAINT "refund_items_amount_positive" CHECK ("amount_cents" > 0)
);

CREATE INDEX "refund_items_refund_id_idx" ON "refund_items"("refund_id");
CREATE INDEX "refund_items_order_item_id_idx" ON "refund_items"("order_item_id");

ALTER TABLE "refund_items" ADD CONSTRAINT "refund_items_refund_id_fkey"
  FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "refund_items" ADD CONSTRAINT "refund_items_order_item_id_fkey"
  FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
