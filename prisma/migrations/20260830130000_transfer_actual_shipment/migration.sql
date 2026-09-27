-- Each Migration 57 TransferItem row already represents exactly one requested
-- unit (legacy, box, or piece). Store the actual shipped quantity on that same
-- physical unit row so requested and shipped facts never require conversion.
ALTER TABLE "TransferItem"
  ADD COLUMN "shippedQuantity" INTEGER;

ALTER TABLE "TransferItem"
  ADD CONSTRAINT "TransferItem_shippedQuantity_valid"
    CHECK (
      "shippedQuantity" IS NULL
      OR ("shippedQuantity" >= 0 AND "shippedQuantity" <= quantity)
    ),
  ADD CONSTRAINT "TransferItem_request_item_unit_unique"
    UNIQUE ("requestId", "itemId", "quantityUnit");

-- Historical rows intentionally remain NULL. A NULL value means that no exact
-- actual-shipment quantity fact was captured for that historical transfer.
