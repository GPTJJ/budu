-- Daily entry upgrade: store sales source, POS business date, actual attendance, audit.

ALTER TABLE "Store"
  ADD COLUMN "sales_data_source" TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN "sales_data_source_effective_date" TIMESTAMP(3);

ALTER TABLE "DailyEntry"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'draft',
  ADD COLUMN "sales_data_status" TEXT NOT NULL DEFAULT 'not_applicable',
  ADD COLUMN "pos_sync_at" TIMESTAMP(3),
  ADD COLUMN "hybrid_adjustment_cents" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "hybrid_adjustment_note" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "confirmed_at" TIMESTAMP(3),
  ADD COLUMN "confirmed_by" TEXT NOT NULL DEFAULT '';

CREATE TABLE "daily_store_staff" (
  "id" TEXT NOT NULL,
  "store_id" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "staff_id" TEXT NOT NULL,
  "staff_name_snapshot" TEXT NOT NULL DEFAULT '',
  "shift_id" TEXT NOT NULL DEFAULT '',
  "scheduled_start_time" TEXT NOT NULL DEFAULT '',
  "scheduled_end_time" TEXT NOT NULL DEFAULT '',
  "actual_start_time" TEXT NOT NULL DEFAULT '',
  "actual_end_time" TEXT NOT NULL DEFAULT '',
  "break_minutes" INTEGER NOT NULL DEFAULT 0,
  "scheduled_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "actual_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "attendance_status" TEXT NOT NULL DEFAULT 'normal',
  "source" TEXT NOT NULL DEFAULT 'manual',
  "created_by" TEXT NOT NULL DEFAULT '',
  "updated_by" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "daily_store_staff_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "daily_store_staff_store_id_date_staff_id_key" ON "daily_store_staff"("store_id", "date", "staff_id");
CREATE INDEX "daily_store_staff_store_id_date_idx" ON "daily_store_staff"("store_id", "date");

ALTER TABLE "daily_store_staff" ADD CONSTRAINT "daily_store_staff_store_id_fkey"
  FOREIGN KEY ("store_id") REFERENCES "Store"("key") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "daily_entry_audit_logs" (
  "id" TEXT NOT NULL,
  "store_id" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "module" TEXT NOT NULL DEFAULT '',
  "field_name" TEXT NOT NULL DEFAULT '',
  "before_value" JSONB,
  "after_value" JSONB,
  "reason" TEXT NOT NULL DEFAULT '',
  "operator_id" TEXT NOT NULL DEFAULT '',
  "operator_name" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "daily_entry_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "daily_entry_audit_logs_store_id_date_idx" ON "daily_entry_audit_logs"("store_id", "date");

ALTER TABLE "orders" ADD COLUMN "business_date" DATE;
UPDATE "orders" SET "business_date" = ("created_at" + interval '8 hours')::date WHERE "business_date" IS NULL;
CREATE INDEX "orders_store_id_business_date_idx" ON "orders"("store_id", "business_date");

ALTER TABLE "order_items"
  ADD COLUMN "sku_id" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "discount_amount" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "actual_amount" BIGINT NOT NULL DEFAULT 0;

UPDATE "order_items" SET "sku_id" = "sku_snapshot", "actual_amount" = "line_amount";
