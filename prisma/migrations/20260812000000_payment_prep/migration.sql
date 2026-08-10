-- Real-payment preparation: extend payments, add refunds + payment audit logs.

ALTER TABLE "payments"
  ADD COLUMN "payment_method" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "request_payload" JSONB,
  ADD COLUMN "response_payload" JSONB,
  ADD COLUMN "raw_callback" JSONB;

CREATE TABLE "refunds" (
  "id" TEXT NOT NULL,
  "refund_no" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "payment_id" TEXT NOT NULL,
  "refund_amount" BIGINT NOT NULL,
  "reason" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "provider_refund_no" TEXT,
  "requested_by" TEXT NOT NULL DEFAULT '',
  "approved_by" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "refunds_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "refunds_refund_amount_positive" CHECK ("refund_amount" > 0)
);

CREATE UNIQUE INDEX "refunds_refund_no_key" ON "refunds"("refund_no");
CREATE UNIQUE INDEX "refunds_provider_refund_no_key" ON "refunds"("provider_refund_no");
CREATE INDEX "refunds_order_id_created_at_idx" ON "refunds"("order_id", "created_at");
CREATE INDEX "refunds_payment_id_created_at_idx" ON "refunds"("payment_id", "created_at");

ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "payment_logs" (
  "id" TEXT NOT NULL,
  "payment_id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "store_key" TEXT NOT NULL DEFAULT '',
  "cashier_id" TEXT NOT NULL DEFAULT '',
  "event" TEXT NOT NULL,
  "channel" TEXT NOT NULL DEFAULT '',
  "amount" BIGINT NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT '',
  "provider_trade_no" TEXT,
  "failure_code" TEXT NOT NULL DEFAULT '',
  "failure_message" TEXT NOT NULL DEFAULT '',
  "callback_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payment_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "payment_logs_order_id_created_at_idx" ON "payment_logs"("order_id", "created_at");
CREATE INDEX "payment_logs_payment_id_created_at_idx" ON "payment_logs"("payment_id", "created_at");

ALTER TABLE "payment_logs" ADD CONSTRAINT "payment_logs_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payment_logs" ADD CONSTRAINT "payment_logs_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
