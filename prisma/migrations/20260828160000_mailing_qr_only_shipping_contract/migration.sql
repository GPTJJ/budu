-- Mailing QR-only workflow needs structured, immutable shipping facts on the
-- official record. All columns are nullable so historical records remain valid
-- without a backfill or reinterpretation.
ALTER TABLE "MailingRecord"
  ADD COLUMN "store_key" TEXT,
  ADD COLUMN "shipping_tier" TEXT,
  ADD COLUMN "shipping_amount_cents" INTEGER,
  ADD COLUMN "shipping_payment_mode" TEXT,
  ADD COLUMN "shipping_payment_confirmed_at" TIMESTAMP(3),
  ADD COLUMN "shipping_payment_confirmed_by" TEXT;

CREATE INDEX "MailingRecord_store_key_status_createdAt_idx"
  ON "MailingRecord"("store_key", "status", "createdAt");
