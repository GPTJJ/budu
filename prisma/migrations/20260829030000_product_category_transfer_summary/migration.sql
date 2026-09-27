-- Formal product classification authority. Existing products stay NULL and
-- therefore remain in the system-defined "未分类" bucket; no product facts are
-- rewritten or inferred.
CREATE TABLE "ProductCategory" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductCategory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductCategory_name_key" ON "ProductCategory"("name");
CREATE INDEX "ProductCategory_active_sort_idx" ON "ProductCategory"("isActive", "sortOrder");

ALTER TABLE "InventoryItem" ADD COLUMN "productCategoryId" TEXT;
CREATE INDEX "InventoryItem_productCategoryId_idx" ON "InventoryItem"("productCategoryId");
ALTER TABLE "InventoryItem"
  ADD CONSTRAINT "InventoryItem_productCategoryId_fkey"
  FOREIGN KEY ("productCategoryId") REFERENCES "ProductCategory"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- New transfers snapshot the category name. Existing history remains blank
-- instead of being reclassified from today's master data.
ALTER TABLE "TransferItem"
  ADD COLUMN "productCategoryNameSnapshot" TEXT NOT NULL DEFAULT '';
