-- Unified Product Center: partner supply eligibility is independent from POS
-- and store-transfer eligibility. Existing products remain disabled until an
-- administrator explicitly opts them in.
ALTER TABLE "InventoryItem"
  ADD COLUMN "partnerSupplyEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "InventoryItem_category_partnerSupplyEnabled_idx"
  ON "InventoryItem"("category", "partnerSupplyEnabled");
