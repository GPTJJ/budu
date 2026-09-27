-- Store Transfer 2.0 is an additive-only migration.
-- Existing transfer rows and detail facts are intentionally left untouched.
ALTER TABLE "TransferRequest"
  ADD COLUMN "shippedBy" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "shippedAt" TIMESTAMP(3),
  ADD COLUMN "withdrawnBy" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "withdrawnAt" TIMESTAMP(3);

ALTER TABLE "TransferItem"
  ADD COLUMN "itemNameSnapshot" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "itemCodeSnapshot" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "categorySnapshot" TEXT NOT NULL DEFAULT '';
