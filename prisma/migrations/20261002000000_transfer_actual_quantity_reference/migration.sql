-- Requested quantity remains an immutable reference. The existing physical
-- unit row records actual shipment independently, within the transfer limit.
-- Historical rows, unit uniqueness, status transitions and inventory stay intact.
BEGIN;
ALTER TABLE "TransferItem"
  DROP CONSTRAINT "TransferItem_shippedQuantity_valid";
ALTER TABLE "TransferItem"
  ADD CONSTRAINT "TransferItem_shippedQuantity_valid"
    CHECK ("shippedQuantity" IS NULL OR ("shippedQuantity" >= 0 AND "shippedQuantity" <= 999999))
    NOT VALID;
ALTER TABLE "TransferItem" VALIDATE CONSTRAINT "TransferItem_shippedQuantity_valid";
COMMIT;
