-- Upgrade V1 POS orders to the formal order state machine.
ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 'draft';
UPDATE "orders" SET "status" = 'pending_payment' WHERE "status" = 'pending';

CREATE TABLE "payments" (
  "id" TEXT NOT NULL,
  "payment_no" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "amount" BIGINT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'CNY',
  "status" TEXT NOT NULL DEFAULT 'created',
  "merchant_trade_no" TEXT NOT NULL,
  "provider_trade_no" TEXT,
  "provider" TEXT NOT NULL,
  "request_key" TEXT NOT NULL,
  "failure_code" TEXT NOT NULL DEFAULT '',
  "failure_message" TEXT NOT NULL DEFAULT '',
  "provider_metadata" JSONB NOT NULL DEFAULT '{}',
  "callback_count" INTEGER NOT NULL DEFAULT 0,
  "last_callback_id" TEXT NOT NULL DEFAULT '',
  "last_callback_at" TIMESTAMP(3),
  "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paid_at" TIMESTAMP(3),
  "failed_at" TIMESTAMP(3),
  "closed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payments_amount_positive" CHECK ("amount" > 0)
);

CREATE UNIQUE INDEX "payments_payment_no_key" ON "payments"("payment_no");
CREATE UNIQUE INDEX "payments_merchant_trade_no_key" ON "payments"("merchant_trade_no");
CREATE UNIQUE INDEX "payments_provider_trade_no_key" ON "payments"("provider_trade_no");
CREATE UNIQUE INDEX "payments_request_key_key" ON "payments"("request_key");
CREATE UNIQUE INDEX "payments_one_active_per_order_idx" ON "payments"("order_id")
  WHERE "status" IN ('created', 'pending', 'success');
CREATE INDEX "payments_order_id_created_at_idx" ON "payments"("order_id", "created_at");
CREATE INDEX "payments_order_id_status_idx" ON "payments"("order_id", "status");
CREATE INDEX "payments_provider_status_idx" ON "payments"("provider", "status");

ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- V1 completed orders already represent successful mock payments. Backfill one
-- immutable payment record per order so historical orders remain reconcilable.
INSERT INTO "payments" (
  "id", "payment_no", "order_id", "channel", "amount", "currency", "status",
  "merchant_trade_no", "provider_trade_no", "provider", "request_key",
  "callback_count", "last_callback_id", "last_callback_at", "requested_at",
  "paid_at", "created_at", "updated_at"
)
SELECT
  'pay-legacy-' || md5(o."id"),
  'PAYLEGACY' || upper(md5(o."id")),
  o."id",
  COALESCE(NULLIF(o."payment_method", ''), 'cash'),
  o."payable_amount",
  'CNY',
  'success',
  'MTLEGACY' || upper(md5(o."id")),
  'MOCKLEGACY' || upper(md5(o."id")),
  'mock',
  'legacy:' || o."id",
  1,
  'legacy-migration',
  COALESCE(o."completed_at", o."updated_at"),
  o."created_at",
  COALESCE(o."completed_at", o."updated_at"),
  o."created_at",
  o."updated_at"
FROM "orders" o
WHERE o."status" = 'completed'
  AND o."payment_status" = 'paid'
  AND o."payable_amount" > 0;
