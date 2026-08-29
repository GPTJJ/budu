-- Partner Supply 1.0 is an additive business ledger. It does not update stock,
-- transfer, product, purchase, or historical order facts.
CREATE TABLE "Partner" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "contactName" TEXT NOT NULL DEFAULT '',
  "contactPhone" TEXT NOT NULL DEFAULT '',
  "defaultStoreKey" TEXT NOT NULL,
  "defaultDiscountBps" INTEGER NOT NULL DEFAULT 6500,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "note" TEXT NOT NULL DEFAULT '',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdBy" TEXT NOT NULL DEFAULT '',
  "updatedBy" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Partner_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Partner_defaultDiscountBps_check" CHECK ("defaultDiscountBps" BETWEEN 1 AND 10000)
);

CREATE TABLE "PartnerSupplyOrder" (
  "id" TEXT NOT NULL,
  "orderNo" TEXT NOT NULL,
  "partnerId" TEXT NOT NULL,
  "partnerNameSnapshot" TEXT NOT NULL,
  "fromStoreKey" TEXT NOT NULL,
  "fromStoreNameSnapshot" TEXT NOT NULL,
  "businessDate" DATE NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "defaultDiscountBpsSnapshot" INTEGER NOT NULL,
  "effectiveDiscountBps" INTEGER NOT NULL,
  "totalAmountCents" BIGINT NOT NULL,
  "note" TEXT NOT NULL DEFAULT '',
  "createdById" TEXT NOT NULL DEFAULT '',
  "createdBy" TEXT NOT NULL DEFAULT '',
  "priceOverrideById" TEXT NOT NULL DEFAULT '',
  "priceOverrideBy" TEXT NOT NULL DEFAULT '',
  "priceOverrideAt" TIMESTAMP(3),
  "shippedById" TEXT NOT NULL DEFAULT '',
  "shippedBy" TEXT NOT NULL DEFAULT '',
  "shippedAt" TIMESTAMP(3),
  "withdrawnById" TEXT NOT NULL DEFAULT '',
  "withdrawnBy" TEXT NOT NULL DEFAULT '',
  "withdrawnAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PartnerSupplyOrder_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PartnerSupplyOrder_status_check" CHECK ("status" IN ('pending', 'shipped', 'withdrawn')),
  CONSTRAINT "PartnerSupplyOrder_defaultDiscount_check" CHECK ("defaultDiscountBpsSnapshot" BETWEEN 1 AND 10000),
  CONSTRAINT "PartnerSupplyOrder_effectiveDiscount_check" CHECK ("effectiveDiscountBps" BETWEEN 1 AND 10000),
  CONSTRAINT "PartnerSupplyOrder_total_check" CHECK ("totalAmountCents" >= 0)
);

CREATE TABLE "PartnerSupplyItem" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "productCodeSnapshot" TEXT NOT NULL,
  "productNameSnapshot" TEXT NOT NULL,
  "productCategoryNameSnapshot" TEXT NOT NULL DEFAULT '',
  "retailPriceCentsSnapshot" BIGINT NOT NULL,
  "discountBpsSnapshot" INTEGER NOT NULL,
  "partnerUnitPriceCents" BIGINT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "subtotalCents" BIGINT NOT NULL,
  CONSTRAINT "PartnerSupplyItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PartnerSupplyItem_price_check" CHECK ("retailPriceCentsSnapshot" > 0 AND "partnerUnitPriceCents" > 0 AND "subtotalCents" > 0),
  CONSTRAINT "PartnerSupplyItem_discount_check" CHECK ("discountBpsSnapshot" BETWEEN 1 AND 10000),
  CONSTRAINT "PartnerSupplyItem_quantity_check" CHECK ("quantity" BETWEEN 1 AND 999999)
);

CREATE TABLE "PartnerReceipt" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "amountCents" BIGINT NOT NULL,
  "receivedDate" DATE NOT NULL,
  "note" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdById" TEXT NOT NULL DEFAULT '',
  "createdBy" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "voidedById" TEXT NOT NULL DEFAULT '',
  "voidedBy" TEXT NOT NULL DEFAULT '',
  "voidedAt" TIMESTAMP(3),
  "voidReason" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "PartnerReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PartnerReceipt_amount_check" CHECK ("amountCents" > 0),
  CONSTRAINT "PartnerReceipt_status_check" CHECK ("status" IN ('active', 'voided'))
);

CREATE UNIQUE INDEX "Partner_name_key" ON "Partner"("name");
CREATE INDEX "Partner_isActive_name_idx" ON "Partner"("isActive", "name");
CREATE UNIQUE INDEX "PartnerSupplyOrder_orderNo_key" ON "PartnerSupplyOrder"("orderNo");
CREATE INDEX "PartnerSupplyOrder_partnerId_businessDate_idx" ON "PartnerSupplyOrder"("partnerId", "businessDate");
CREATE INDEX "PartnerSupplyOrder_fromStoreKey_businessDate_idx" ON "PartnerSupplyOrder"("fromStoreKey", "businessDate");
CREATE INDEX "PartnerSupplyOrder_status_businessDate_idx" ON "PartnerSupplyOrder"("status", "businessDate");
CREATE UNIQUE INDEX "PartnerSupplyItem_orderId_productId_key" ON "PartnerSupplyItem"("orderId", "productId");
CREATE INDEX "PartnerSupplyItem_productId_idx" ON "PartnerSupplyItem"("productId");
CREATE INDEX "PartnerReceipt_orderId_status_idx" ON "PartnerReceipt"("orderId", "status");
CREATE INDEX "PartnerReceipt_receivedDate_idx" ON "PartnerReceipt"("receivedDate");

ALTER TABLE "Partner" ADD CONSTRAINT "Partner_defaultStoreKey_fkey"
  FOREIGN KEY ("defaultStoreKey") REFERENCES "Store"("key") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartnerSupplyOrder" ADD CONSTRAINT "PartnerSupplyOrder_partnerId_fkey"
  FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartnerSupplyOrder" ADD CONSTRAINT "PartnerSupplyOrder_fromStoreKey_fkey"
  FOREIGN KEY ("fromStoreKey") REFERENCES "Store"("key") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartnerSupplyItem" ADD CONSTRAINT "PartnerSupplyItem_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "PartnerSupplyOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartnerSupplyItem" ADD CONSTRAINT "PartnerSupplyItem_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartnerReceipt" ADD CONSTRAINT "PartnerReceipt_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "PartnerSupplyOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Current real partner is explicit project data, not a runtime constant. Fresh
-- empty test databases may not have stores yet, so seed only when the canonical
-- Beijing Guanshe store row exists.
INSERT INTO "Partner" (
  "id", "name", "defaultStoreKey", "defaultDiscountBps", "note", "createdBy", "updatedBy"
)
SELECT
  'partner-qinhuangdao-v1', '秦皇岛合作商', 'guanshe', 6500,
  '合作商供货 1.0 初始合作商', 'system-migration', 'system-migration'
WHERE EXISTS (SELECT 1 FROM "Store" WHERE "key" = 'guanshe')
ON CONFLICT ("name") DO NOTHING;
