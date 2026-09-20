-- Partner Replenishment Gate 3: additive shared catalogue configuration.
-- Quantity is tagged by partnerOrderUnit: grams for KG, pieces for PCS.
-- Existing BOX, transfer, Partner Supply and inventory records are untouched.
ALTER TABLE "InventoryItem"
  ADD COLUMN "partnerReplenishmentEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "partnerOrderUnit" TEXT,
  ADD COLUMN "partnerKgBasePriceCents" BIGINT,
  ADD COLUMN "partnerMinOrderBaseQty" INTEGER,
  ADD COLUMN "partnerOrderStepBaseQty" INTEGER;

ALTER TABLE "InventoryItem"
  ADD CONSTRAINT "InventoryItem_partner_order_unit_check"
    CHECK ("partnerOrderUnit" IS NULL OR "partnerOrderUnit" IN ('KG', 'PCS')),
  ADD CONSTRAINT "InventoryItem_partner_kg_price_check"
    CHECK ("partnerKgBasePriceCents" IS NULL OR "partnerKgBasePriceCents" > 0),
  ADD CONSTRAINT "InventoryItem_partner_moq_check"
    CHECK ("partnerMinOrderBaseQty" IS NULL OR "partnerMinOrderBaseQty" > 0),
  ADD CONSTRAINT "InventoryItem_partner_step_check"
    CHECK ("partnerOrderStepBaseQty" IS NULL OR "partnerOrderStepBaseQty" > 0),
  ADD CONSTRAINT "InventoryItem_partner_enabled_config_check"
    CHECK (
      "partnerReplenishmentEnabled" = FALSE OR (
        "partnerOrderUnit" IN ('KG', 'PCS')
        AND "partnerMinOrderBaseQty" IS NOT NULL
        AND "partnerOrderStepBaseQty" IS NOT NULL
        AND (
          ("partnerOrderUnit" = 'KG' AND "partnerKgBasePriceCents" IS NOT NULL)
          OR
          ("partnerOrderUnit" = 'PCS' AND "salePriceCents" IS NOT NULL AND "salePriceCents" > 0)
        )
      )
    );

CREATE INDEX "InventoryItem_category_partnerReplenishmentEnabled_isActive_idx"
  ON "InventoryItem"("category", "partnerReplenishmentEnabled", "isActive");
