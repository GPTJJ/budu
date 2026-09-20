-- Partner Replenishment Gate 8: additive after-sales evidence only.
-- This migration does not create Refund, Payment, StockLedger or inventory-return facts.

CREATE TABLE "ReplenishmentAfterSalesRequest" (
  "id" TEXT NOT NULL,
  "requestNo" TEXT NOT NULL,
  "partnerId" TEXT NOT NULL,
  "replenishmentOrderId" TEXT NOT NULL,
  "replenishmentShipmentItemId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "quantityBase" INTEGER NOT NULL,
  "description" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "resultNote" TEXT NOT NULL DEFAULT '',
  "createdByActorId" TEXT NOT NULL,
  "createdByActorName" TEXT NOT NULL DEFAULT '',
  "handledByActorId" TEXT NOT NULL DEFAULT '',
  "handledByActorName" TEXT NOT NULL DEFAULT '',
  "handledAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReplenishmentAfterSalesRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReplenishmentAfterSalesRequest_partnerId_id_key" UNIQUE ("partnerId", "id"),
  CONSTRAINT "ReplenishmentAfterSalesRequest_type_check" CHECK ("type" IN ('DAMAGED', 'WRONG_ITEM', 'RETURN')),
  CONSTRAINT "ReplenishmentAfterSalesRequest_status_check" CHECK ("status" IN ('PENDING', 'PROCESSING', 'RESOLVED', 'REJECTED')),
  CONSTRAINT "ReplenishmentAfterSalesRequest_quantity_check" CHECK ("quantityBase" > 0),
  CONSTRAINT "ReplenishmentAfterSalesRequest_description_check" CHECK (char_length("description") BETWEEN 1 AND 1000),
  CONSTRAINT "ReplenishmentAfterSalesRequest_partner_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReplenishmentAfterSalesRequest_order_fkey" FOREIGN KEY ("replenishmentOrderId") REFERENCES "ReplenishmentOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReplenishmentAfterSalesRequest_shipment_item_fkey" FOREIGN KEY ("replenishmentShipmentItemId") REFERENCES "ReplenishmentShipmentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "ReplenishmentAfterSalesAttachment" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "partnerId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "fileType" TEXT NOT NULL,
  "fileSize" INTEGER NOT NULL,
  "dataUrl" TEXT NOT NULL,
  "storageProvider" TEXT NOT NULL DEFAULT 'local',
  "storageKey" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReplenishmentAfterSalesAttachment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReplenishmentAfterSalesAttachment_size_check" CHECK ("fileSize" > 0 AND "fileSize" <= 5242880),
  CONSTRAINT "ReplenishmentAfterSalesAttachment_type_check" CHECK ("fileType" IN ('image/jpeg', 'image/png', 'image/webp')),
  CONSTRAINT "ReplenishmentAfterSalesAttachment_request_fkey" FOREIGN KEY ("partnerId", "requestId") REFERENCES "ReplenishmentAfterSalesRequest"("partnerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ReplenishmentAfterSalesRequest_requestNo_key" ON "ReplenishmentAfterSalesRequest"("requestNo");
CREATE INDEX "ReplenishmentAfterSalesRequest_partnerId_createdAt_idx" ON "ReplenishmentAfterSalesRequest"("partnerId", "createdAt");
CREATE INDEX "ReplenishmentAfterSalesRequest_status_createdAt_idx" ON "ReplenishmentAfterSalesRequest"("status", "createdAt");
CREATE INDEX "ReplenishmentAfterSalesRequest_replenishmentOrderId_createdAt_idx" ON "ReplenishmentAfterSalesRequest"("replenishmentOrderId", "createdAt");
CREATE INDEX "ReplenishmentAfterSalesRequest_shipmentItem_status_idx" ON "ReplenishmentAfterSalesRequest"("replenishmentShipmentItemId", "status");
CREATE INDEX "ReplenishmentAfterSalesAttachment_requestId_idx" ON "ReplenishmentAfterSalesAttachment"("requestId");
CREATE INDEX "ReplenishmentAfterSalesAttachment_partnerId_createdAt_idx" ON "ReplenishmentAfterSalesAttachment"("partnerId", "createdAt");

CREATE FUNCTION "enforce_replenishment_after_sales_quantity"()
RETURNS TRIGGER AS $$
DECLARE
  shipped_quantity INTEGER;
  actual_order_id TEXT;
  actual_partner_id TEXT;
  claimed_quantity BIGINT;
BEGIN
  SELECT si."shippedQuantityBase", s."replenishmentOrderId", o."partnerId"
    INTO shipped_quantity, actual_order_id, actual_partner_id
    FROM "ReplenishmentShipmentItem" si
    JOIN "ReplenishmentShipment" s ON s."id" = si."replenishmentShipmentId"
    JOIN "ReplenishmentOrder" o ON o."id" = s."replenishmentOrderId"
    WHERE si."id" = NEW."replenishmentShipmentItemId"
    FOR UPDATE OF si;
  IF shipped_quantity IS NULL OR actual_order_id <> NEW."replenishmentOrderId" OR actual_partner_id <> NEW."partnerId" THEN
    RAISE EXCEPTION 'REPLENISHMENT_AFTER_SALES_SCOPE_INVALID';
  END IF;
  SELECT COALESCE(SUM("quantityBase"), 0) INTO claimed_quantity
    FROM "ReplenishmentAfterSalesRequest"
    WHERE "replenishmentShipmentItemId" = NEW."replenishmentShipmentItemId" AND "status" <> 'REJECTED';
  IF claimed_quantity + NEW."quantityBase" > shipped_quantity THEN
    RAISE EXCEPTION 'REPLENISHMENT_AFTER_SALES_QUANTITY_EXCEEDED';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ReplenishmentAfterSalesRequest_quantity_guard"
BEFORE INSERT ON "ReplenishmentAfterSalesRequest"
FOR EACH ROW EXECUTE FUNCTION "enforce_replenishment_after_sales_quantity"();

CREATE FUNCTION "protect_replenishment_after_sales_core"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."id" <> OLD."id"
    OR NEW."requestNo" <> OLD."requestNo"
    OR NEW."partnerId" <> OLD."partnerId"
    OR NEW."replenishmentOrderId" <> OLD."replenishmentOrderId"
    OR NEW."replenishmentShipmentItemId" <> OLD."replenishmentShipmentItemId"
    OR NEW."type" <> OLD."type"
    OR NEW."quantityBase" <> OLD."quantityBase"
    OR NEW."description" <> OLD."description"
    OR NEW."createdByActorId" <> OLD."createdByActorId"
    OR NEW."createdByActorName" <> OLD."createdByActorName"
    OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'REPLENISHMENT_AFTER_SALES_CORE_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ReplenishmentAfterSalesRequest_core_guard"
BEFORE UPDATE ON "ReplenishmentAfterSalesRequest"
FOR EACH ROW EXECUTE FUNCTION "protect_replenishment_after_sales_core"();

CREATE FUNCTION "protect_replenishment_after_sales_delete"()
RETURNS TRIGGER AS $$ BEGIN RAISE EXCEPTION 'REPLENISHMENT_AFTER_SALES_DELETE_FORBIDDEN'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "ReplenishmentAfterSalesRequest_delete_guard" BEFORE DELETE ON "ReplenishmentAfterSalesRequest" FOR EACH ROW EXECUTE FUNCTION "protect_replenishment_after_sales_delete"();
CREATE TRIGGER "ReplenishmentAfterSalesAttachment_update_guard" BEFORE UPDATE OR DELETE ON "ReplenishmentAfterSalesAttachment" FOR EACH ROW EXECUTE FUNCTION "protect_replenishment_after_sales_delete"();
