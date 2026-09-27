-- Availability reuses sweet_card_store_policies. No economic/history backfill.
CREATE TYPE "StoreOperationType" AS ENUM ('UNKNOWN', 'DIRECT', 'NON_DIRECT');
ALTER TABLE "Store" ADD COLUMN "operation_type" "StoreOperationType" NOT NULL DEFAULT 'UNKNOWN';
CREATE TABLE "sweet_card_control" (
  "id" TEXT NOT NULL PRIMARY KEY CHECK ("id" = 'GLOBAL'),
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "updated_by_id" TEXT NOT NULL DEFAULT '',
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
