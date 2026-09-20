-- Partner Replenishment Gate 4: additive order, immutable submission snapshot,
-- persisted idempotency and audit-compatible authority. No legacy facts change.
CREATE UNIQUE INDEX "PartnerStore_partnerId_id_key" ON "PartnerStore"("partnerId", "id");

CREATE TABLE "ReplenishmentOrder" (
  "id" TEXT NOT NULL,
  "orderNo" TEXT NOT NULL,
  "partnerId" TEXT NOT NULL,
  "partnerStoreId" TEXT NOT NULL,
  "partnerNameSnapshot" TEXT NOT NULL,
  "partnerStoreNameSnapshot" TEXT NOT NULL,
  "contactNameSnapshot" TEXT NOT NULL DEFAULT '',
  "phoneSnapshot" TEXT NOT NULL DEFAULT '',
  "provinceSnapshot" TEXT NOT NULL DEFAULT '',
  "citySnapshot" TEXT NOT NULL DEFAULT '',
  "districtSnapshot" TEXT NOT NULL DEFAULT '',
  "addressLineSnapshot" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
  "createdByType" TEXT NOT NULL,
  "createdByActorId" TEXT NOT NULL,
  "createdByActorName" TEXT NOT NULL DEFAULT '',
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cancelledAt" TIMESTAMP(3),
  "cancelledByType" TEXT,
  "cancelledByActorId" TEXT NOT NULL DEFAULT '',
  "cancelledByActorName" TEXT NOT NULL DEFAULT '',
  "requestedTotalAmountCents" BIGINT NOT NULL,
  "idempotencyScope" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "idempotencyPayloadDigest" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReplenishmentOrder_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReplenishmentOrder_status_check" CHECK ("status" IN ('SUBMITTED', 'CANCELLED')),
  CONSTRAINT "ReplenishmentOrder_created_by_type_check" CHECK ("createdByType" IN ('PARTNER', 'INTERNAL')),
  CONSTRAINT "ReplenishmentOrder_cancelled_by_type_check" CHECK ("cancelledByType" IS NULL OR "cancelledByType" IN ('PARTNER', 'INTERNAL')),
  CONSTRAINT "ReplenishmentOrder_total_check" CHECK ("requestedTotalAmountCents" > 0),
  CONSTRAINT "ReplenishmentOrder_idempotency_key_check" CHECK (char_length("idempotencyKey") BETWEEN 8 AND 100),
  CONSTRAINT "ReplenishmentOrder_idempotency_digest_check" CHECK (char_length("idempotencyPayloadDigest") = 64),
  CONSTRAINT "ReplenishmentOrder_cancel_state_check" CHECK (
    ("status" = 'SUBMITTED' AND "cancelledAt" IS NULL AND "cancelledByType" IS NULL AND "cancelledByActorId" = '')
    OR
    ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "cancelledByType" IS NOT NULL AND "cancelledByActorId" <> '')
  ),
  CONSTRAINT "ReplenishmentOrder_partnerId_fkey"
    FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReplenishmentOrder_partner_store_fkey"
    FOREIGN KEY ("partnerId", "partnerStoreId") REFERENCES "PartnerStore"("partnerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "ReplenishmentOrderItem" (
  "id" TEXT NOT NULL,
  "replenishmentOrderId" TEXT NOT NULL,
  "inventoryItemId" TEXT NOT NULL,
  "productNameSnapshot" TEXT NOT NULL,
  "skuSnapshot" TEXT NOT NULL DEFAULT '',
  "productCodeSnapshot" TEXT NOT NULL DEFAULT '',
  "orderUnitSnapshot" TEXT NOT NULL,
  "requestedQuantityBase" INTEGER NOT NULL,
  "basePriceSnapshotCents" BIGINT NOT NULL,
  "discountBpsSnapshot" INTEGER NOT NULL,
  "requestedLineAmountCents" BIGINT NOT NULL,
  "minimumOrderBaseQtySnapshot" INTEGER NOT NULL,
  "orderStepBaseQtySnapshot" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReplenishmentOrderItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReplenishmentOrderItem_order_unit_check" CHECK ("orderUnitSnapshot" IN ('KG', 'PCS')),
  CONSTRAINT "ReplenishmentOrderItem_quantity_check" CHECK ("requestedQuantityBase" > 0),
  CONSTRAINT "ReplenishmentOrderItem_base_price_check" CHECK ("basePriceSnapshotCents" > 0),
  CONSTRAINT "ReplenishmentOrderItem_discount_check" CHECK ("discountBpsSnapshot" BETWEEN 1 AND 10000),
  CONSTRAINT "ReplenishmentOrderItem_line_amount_check" CHECK ("requestedLineAmountCents" > 0),
  CONSTRAINT "ReplenishmentOrderItem_moq_check" CHECK ("minimumOrderBaseQtySnapshot" > 0),
  CONSTRAINT "ReplenishmentOrderItem_step_check" CHECK ("orderStepBaseQtySnapshot" > 0),
  CONSTRAINT "ReplenishmentOrderItem_order_fkey"
    FOREIGN KEY ("replenishmentOrderId") REFERENCES "ReplenishmentOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReplenishmentOrderItem_inventory_item_fkey"
    FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ReplenishmentOrder_orderNo_key" ON "ReplenishmentOrder"("orderNo");
CREATE UNIQUE INDEX "ReplenishmentOrder_idempotencyScope_idempotencyKey_key" ON "ReplenishmentOrder"("idempotencyScope", "idempotencyKey");
CREATE INDEX "ReplenishmentOrder_partnerId_submittedAt_idx" ON "ReplenishmentOrder"("partnerId", "submittedAt");
CREATE INDEX "ReplenishmentOrder_partnerId_status_submittedAt_idx" ON "ReplenishmentOrder"("partnerId", "status", "submittedAt");
CREATE INDEX "ReplenishmentOrder_partnerStoreId_createdAt_idx" ON "ReplenishmentOrder"("partnerStoreId", "createdAt");
CREATE INDEX "ReplenishmentOrder_status_submittedAt_idx" ON "ReplenishmentOrder"("status", "submittedAt");
CREATE UNIQUE INDEX "ReplenishmentOrderItem_replenishmentOrderId_inventoryItemId_key" ON "ReplenishmentOrderItem"("replenishmentOrderId", "inventoryItemId");
CREATE INDEX "ReplenishmentOrderItem_inventoryItemId_idx" ON "ReplenishmentOrderItem"("inventoryItemId");

CREATE FUNCTION "prevent_replenishment_order_snapshot_update"()
RETURNS TRIGGER AS $$
BEGIN
  IF ROW(
    NEW."orderNo", NEW."partnerId", NEW."partnerStoreId", NEW."partnerNameSnapshot",
    NEW."partnerStoreNameSnapshot", NEW."contactNameSnapshot", NEW."phoneSnapshot",
    NEW."provinceSnapshot", NEW."citySnapshot", NEW."districtSnapshot", NEW."addressLineSnapshot",
    NEW."createdByType", NEW."createdByActorId", NEW."createdByActorName", NEW."submittedAt",
    NEW."requestedTotalAmountCents", NEW."idempotencyScope", NEW."idempotencyKey",
    NEW."idempotencyPayloadDigest", NEW."createdAt"
  ) IS DISTINCT FROM ROW(
    OLD."orderNo", OLD."partnerId", OLD."partnerStoreId", OLD."partnerNameSnapshot",
    OLD."partnerStoreNameSnapshot", OLD."contactNameSnapshot", OLD."phoneSnapshot",
    OLD."provinceSnapshot", OLD."citySnapshot", OLD."districtSnapshot", OLD."addressLineSnapshot",
    OLD."createdByType", OLD."createdByActorId", OLD."createdByActorName", OLD."submittedAt",
    OLD."requestedTotalAmountCents", OLD."idempotencyScope", OLD."idempotencyKey",
    OLD."idempotencyPayloadDigest", OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'REPLENISHMENT_ORDER_SNAPSHOT_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ReplenishmentOrder_snapshot_immutable"
BEFORE UPDATE ON "ReplenishmentOrder"
FOR EACH ROW EXECUTE FUNCTION "prevent_replenishment_order_snapshot_update"();

CREATE FUNCTION "prevent_replenishment_order_delete"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'REPLENISHMENT_ORDER_DELETE_FORBIDDEN';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ReplenishmentOrder_delete_forbidden"
BEFORE DELETE ON "ReplenishmentOrder"
FOR EACH ROW EXECUTE FUNCTION "prevent_replenishment_order_delete"();

CREATE FUNCTION "prevent_replenishment_order_item_snapshot_update"()
RETURNS TRIGGER AS $$
BEGIN
  IF ROW(
    NEW."replenishmentOrderId", NEW."inventoryItemId", NEW."productNameSnapshot",
    NEW."skuSnapshot", NEW."productCodeSnapshot", NEW."orderUnitSnapshot",
    NEW."requestedQuantityBase", NEW."basePriceSnapshotCents", NEW."discountBpsSnapshot",
    NEW."requestedLineAmountCents", NEW."minimumOrderBaseQtySnapshot",
    NEW."orderStepBaseQtySnapshot", NEW."createdAt"
  ) IS DISTINCT FROM ROW(
    OLD."replenishmentOrderId", OLD."inventoryItemId", OLD."productNameSnapshot",
    OLD."skuSnapshot", OLD."productCodeSnapshot", OLD."orderUnitSnapshot",
    OLD."requestedQuantityBase", OLD."basePriceSnapshotCents", OLD."discountBpsSnapshot",
    OLD."requestedLineAmountCents", OLD."minimumOrderBaseQtySnapshot",
    OLD."orderStepBaseQtySnapshot", OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'REPLENISHMENT_ORDER_ITEM_SNAPSHOT_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ReplenishmentOrderItem_snapshot_immutable"
BEFORE UPDATE ON "ReplenishmentOrderItem"
FOR EACH ROW EXECUTE FUNCTION "prevent_replenishment_order_item_snapshot_update"();

CREATE FUNCTION "prevent_replenishment_order_item_delete"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'REPLENISHMENT_ORDER_ITEM_DELETE_FORBIDDEN';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ReplenishmentOrderItem_delete_forbidden"
BEFORE DELETE ON "ReplenishmentOrderItem"
FOR EACH ROW EXECUTE FUNCTION "prevent_replenishment_order_item_delete"();
