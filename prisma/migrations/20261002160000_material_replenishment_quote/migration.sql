-- Independent material quotation; never default from retail/cost or enable sales.
ALTER TABLE "InventoryItem" ADD COLUMN "partnerMaterialPriceCents" BIGINT;
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_material_quote_nonnegative"
  CHECK ("partnerMaterialPriceCents" IS NULL OR "partnerMaterialPriceCents" >= 0);
