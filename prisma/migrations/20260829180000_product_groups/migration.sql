-- ProductGroup is display-only POS organization. Existing InventoryItem IDs,
-- order identities, prices, eligibility and historical facts remain unchanged.
CREATE TABLE "ProductGroup" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "coverImage" TEXT NOT NULL DEFAULT '',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductGroup_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "InventoryItem"
  ADD COLUMN "productGroupId" TEXT,
  ADD COLUMN "variantName" TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX "ProductGroup_name_key" ON "ProductGroup"("name");
CREATE INDEX "ProductGroup_isActive_sortOrder_idx" ON "ProductGroup"("isActive", "sortOrder");
CREATE INDEX "InventoryItem_productGroupId_idx" ON "InventoryItem"("productGroupId");

ALTER TABLE "InventoryItem"
  ADD CONSTRAINT "InventoryItem_productGroupId_fkey"
  FOREIGN KEY ("productGroupId") REFERENCES "ProductGroup"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
