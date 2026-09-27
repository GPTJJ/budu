-- Partner Replenishment Gate 6: additive, immutable Shipment authority.
-- Shipment facts are logistics evidence only. No StockLedger, Payment, legacy
-- Partner Supply or existing business row is mutated by this migration.

CREATE TABLE "ReplenishmentShipment" (
  "id" TEXT NOT NULL,
  "shipmentNo" TEXT NOT NULL,
  "replenishmentOrderId" TEXT NOT NULL,
  "fulfillmentStoreKey" TEXT NOT NULL,
  "fulfillmentStoreSnapshot" TEXT NOT NULL,
  "carrier" TEXT NOT NULL,
  "trackingNumber" TEXT NOT NULL,
  "freightType" TEXT NOT NULL,
  "shippedAt" TIMESTAMP(3) NOT NULL,
  "createdByActorId" TEXT NOT NULL,
  "createdByActorName" TEXT NOT NULL DEFAULT '',
  "idempotencyScope" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "idempotencyPayloadDigest" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReplenishmentShipment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReplenishmentShipment_freight_type_check" CHECK ("freightType" IN ('PREPAID', 'COLLECT')),
  CONSTRAINT "ReplenishmentShipment_carrier_check" CHECK (char_length("carrier") BETWEEN 1 AND 80),
  CONSTRAINT "ReplenishmentShipment_tracking_check" CHECK (char_length("trackingNumber") BETWEEN 1 AND 120),
  CONSTRAINT "ReplenishmentShipment_idempotency_key_check" CHECK (char_length("idempotencyKey") BETWEEN 8 AND 100),
  CONSTRAINT "ReplenishmentShipment_idempotency_digest_check" CHECK (char_length("idempotencyPayloadDigest") = 64),
  CONSTRAINT "ReplenishmentShipment_order_fkey"
    FOREIGN KEY ("replenishmentOrderId") REFERENCES "ReplenishmentOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReplenishmentShipment_store_fkey"
    FOREIGN KEY ("fulfillmentStoreKey") REFERENCES "Store"("key") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "ReplenishmentShipmentItem" (
  "id" TEXT NOT NULL,
  "replenishmentShipmentId" TEXT NOT NULL,
  "replenishmentOrderItemId" TEXT NOT NULL,
  "productNameSnapshot" TEXT NOT NULL,
  "orderUnitSnapshot" TEXT NOT NULL,
  "shippedQuantityBase" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReplenishmentShipmentItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReplenishmentShipmentItem_unit_check" CHECK ("orderUnitSnapshot" IN ('KG', 'PCS')),
  CONSTRAINT "ReplenishmentShipmentItem_quantity_check" CHECK ("shippedQuantityBase" > 0),
  CONSTRAINT "ReplenishmentShipmentItem_shipment_fkey"
    FOREIGN KEY ("replenishmentShipmentId") REFERENCES "ReplenishmentShipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReplenishmentShipmentItem_order_item_fkey"
    FOREIGN KEY ("replenishmentOrderItemId") REFERENCES "ReplenishmentOrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ReplenishmentShipment_shipmentNo_key" ON "ReplenishmentShipment"("shipmentNo");
CREATE UNIQUE INDEX "ReplenishmentShipment_idempotencyScope_idempotencyKey_key"
  ON "ReplenishmentShipment"("idempotencyScope", "idempotencyKey");
CREATE INDEX "ReplenishmentShipment_replenishmentOrderId_shippedAt_idx"
  ON "ReplenishmentShipment"("replenishmentOrderId", "shippedAt");
CREATE INDEX "ReplenishmentShipment_fulfillmentStoreKey_shippedAt_idx"
  ON "ReplenishmentShipment"("fulfillmentStoreKey", "shippedAt");
CREATE UNIQUE INDEX "ReplenishmentShipmentItem_shipment_order_item_key"
  ON "ReplenishmentShipmentItem"("replenishmentShipmentId", "replenishmentOrderItemId");
CREATE INDEX "ReplenishmentShipmentItem_order_item_created_idx"
  ON "ReplenishmentShipmentItem"("replenishmentOrderItemId", "createdAt");

CREATE FUNCTION "enforce_replenishment_shipment_header"()
RETURNS TRIGGER AS $$
DECLARE
  store_name TEXT;
  store_active BOOLEAN;
  order_status TEXT;
BEGIN
  SELECT "name", "active" INTO store_name, store_active
    FROM "Store" WHERE "key" = NEW."fulfillmentStoreKey";
  IF store_name IS NULL OR store_active IS NOT TRUE THEN
    RAISE EXCEPTION 'REPLENISHMENT_SHIPMENT_STORE_INVALID';
  END IF;
  IF NEW."fulfillmentStoreSnapshot" <> store_name THEN
    RAISE EXCEPTION 'REPLENISHMENT_SHIPMENT_STORE_SNAPSHOT_INVALID';
  END IF;
  SELECT "status" INTO order_status
    FROM "ReplenishmentOrder" WHERE "id" = NEW."replenishmentOrderId" FOR UPDATE;
  IF order_status NOT IN ('APPROVED', 'PARTIALLY_SHIPPED') THEN
    RAISE EXCEPTION 'REPLENISHMENT_SHIPMENT_ORDER_STATE_INVALID';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ReplenishmentShipment_header_guard"
BEFORE INSERT ON "ReplenishmentShipment"
FOR EACH ROW EXECUTE FUNCTION "enforce_replenishment_shipment_header"();

-- Lock the order, then the exact approved line before every shipment-item
-- insert. Concurrent transactions for the same line therefore serialize at
-- the database authority before cumulative quantity is checked.
CREATE FUNCTION "enforce_replenishment_shipment_quantity"()
RETURNS TRIGGER AS $$
DECLARE
  shipment_order_id TEXT;
  order_status TEXT;
  item_order_id TEXT;
  approved_quantity INTEGER;
  item_unit TEXT;
  item_product_name TEXT;
  already_shipped BIGINT;
BEGIN
  SELECT "replenishmentOrderId" INTO shipment_order_id
    FROM "ReplenishmentShipment" WHERE "id" = NEW."replenishmentShipmentId";
  IF shipment_order_id IS NULL THEN
    RAISE EXCEPTION 'REPLENISHMENT_SHIPMENT_NOT_FOUND';
  END IF;

  SELECT "status" INTO order_status
    FROM "ReplenishmentOrder" WHERE "id" = shipment_order_id FOR UPDATE;
  IF order_status NOT IN ('APPROVED', 'PARTIALLY_SHIPPED') THEN
    RAISE EXCEPTION 'REPLENISHMENT_SHIPMENT_ORDER_STATE_INVALID';
  END IF;

  SELECT "replenishmentOrderId", "approvedQuantityBase", "orderUnitSnapshot", "productNameSnapshot"
    INTO item_order_id, approved_quantity, item_unit, item_product_name
    FROM "ReplenishmentOrderItem"
    WHERE "id" = NEW."replenishmentOrderItemId"
    FOR UPDATE;

  IF item_order_id IS NULL OR item_order_id <> shipment_order_id THEN
    RAISE EXCEPTION 'REPLENISHMENT_SHIPMENT_ITEM_ORDER_MISMATCH';
  END IF;
  IF approved_quantity IS NULL OR approved_quantity <= 0 THEN
    RAISE EXCEPTION 'REPLENISHMENT_SHIPMENT_ITEM_NOT_APPROVED';
  END IF;
  IF NEW."orderUnitSnapshot" <> item_unit THEN
    RAISE EXCEPTION 'REPLENISHMENT_SHIPMENT_ITEM_UNIT_MISMATCH';
  END IF;
  IF NEW."productNameSnapshot" <> item_product_name THEN
    RAISE EXCEPTION 'REPLENISHMENT_SHIPMENT_ITEM_PRODUCT_SNAPSHOT_INVALID';
  END IF;

  SELECT COALESCE(SUM("shippedQuantityBase"), 0) INTO already_shipped
    FROM "ReplenishmentShipmentItem"
    WHERE "replenishmentOrderItemId" = NEW."replenishmentOrderItemId";
  IF already_shipped + NEW."shippedQuantityBase" > approved_quantity THEN
    RAISE EXCEPTION 'REPLENISHMENT_SHIPMENT_OVER_SHIP';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ReplenishmentShipmentItem_quantity_guard"
BEFORE INSERT ON "ReplenishmentShipmentItem"
FOR EACH ROW EXECUTE FUNCTION "enforce_replenishment_shipment_quantity"();

-- The database derives order fulfillment state from cumulative immutable
-- shipment items. Removed lines (approved = 0) are already complete.
CREATE FUNCTION "refresh_replenishment_order_shipping_status"()
RETURNS TRIGGER AS $$
DECLARE
  order_id TEXT;
  all_shipped BOOLEAN;
  next_status TEXT;
BEGIN
  SELECT "replenishmentOrderId" INTO order_id
    FROM "ReplenishmentShipment" WHERE "id" = NEW."replenishmentShipmentId";

  SELECT BOOL_AND(
    item."approvedQuantityBase" = 0
    OR COALESCE(shipped.total, 0) = item."approvedQuantityBase"
  ) INTO all_shipped
  FROM "ReplenishmentOrderItem" item
  LEFT JOIN (
    SELECT "replenishmentOrderItemId", SUM("shippedQuantityBase") AS total
    FROM "ReplenishmentShipmentItem"
    GROUP BY "replenishmentOrderItemId"
  ) shipped ON shipped."replenishmentOrderItemId" = item."id"
  WHERE item."replenishmentOrderId" = order_id;

  next_status := CASE WHEN all_shipped THEN 'SHIPPED' ELSE 'PARTIALLY_SHIPPED' END;
  UPDATE "ReplenishmentOrder"
    SET "status" = next_status, "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = order_id AND "status" IN ('APPROVED', 'PARTIALLY_SHIPPED');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER "ReplenishmentOrder_state_transition" ON "ReplenishmentOrder";
DROP FUNCTION "enforce_replenishment_order_state_transition"();

ALTER TABLE "ReplenishmentOrder"
  DROP CONSTRAINT "ReplenishmentOrder_status_check",
  DROP CONSTRAINT "ReplenishmentOrder_lifecycle_facts_check",
  ADD CONSTRAINT "ReplenishmentOrder_status_check"
    CHECK ("status" IN ('SUBMITTED', 'CANCELLED', 'APPROVED', 'REJECTED', 'PARTIALLY_SHIPPED', 'SHIPPED')),
  ADD CONSTRAINT "ReplenishmentOrder_lifecycle_facts_check" CHECK (
    ("status" = 'SUBMITTED'
      AND "cancelledAt" IS NULL AND "cancelledByType" IS NULL AND "cancelledByActorId" = ''
      AND "approvedTotalAmountCents" IS NULL AND "reviewAction" IS NULL AND "reviewReason" = ''
      AND "reviewedAt" IS NULL AND "reviewedByActorId" = '' AND "reviewedByActorName" = ''
      AND "reviewIdempotencyScope" IS NULL AND "reviewIdempotencyKey" IS NULL AND "reviewPayloadDigest" IS NULL)
    OR
    ("status" = 'CANCELLED'
      AND "cancelledAt" IS NOT NULL AND "cancelledByType" IS NOT NULL AND "cancelledByActorId" <> ''
      AND "approvedTotalAmountCents" IS NULL AND "reviewAction" IS NULL AND "reviewReason" = ''
      AND "reviewedAt" IS NULL AND "reviewedByActorId" = '' AND "reviewedByActorName" = ''
      AND "reviewIdempotencyScope" IS NULL AND "reviewIdempotencyKey" IS NULL AND "reviewPayloadDigest" IS NULL)
    OR
    ("status" IN ('APPROVED', 'PARTIALLY_SHIPPED', 'SHIPPED')
      AND "cancelledAt" IS NULL AND "cancelledByType" IS NULL AND "cancelledByActorId" = ''
      AND "approvedTotalAmountCents" > 0 AND "reviewAction" = 'APPROVE'
      AND "reviewedAt" IS NOT NULL AND "reviewedByActorId" <> ''
      AND "reviewIdempotencyScope" IS NOT NULL AND "reviewIdempotencyKey" IS NOT NULL AND "reviewPayloadDigest" IS NOT NULL)
    OR
    ("status" = 'REJECTED'
      AND "cancelledAt" IS NULL AND "cancelledByType" IS NULL AND "cancelledByActorId" = ''
      AND "approvedTotalAmountCents" IS NULL AND "reviewAction" = 'REJECT' AND char_length("reviewReason") BETWEEN 1 AND 500
      AND "reviewedAt" IS NOT NULL AND "reviewedByActorId" <> ''
      AND "reviewIdempotencyScope" IS NOT NULL AND "reviewIdempotencyKey" IS NOT NULL AND "reviewPayloadDigest" IS NOT NULL)
  );

CREATE FUNCTION "enforce_replenishment_order_state_transition"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" IS DISTINCT FROM NEW."status" AND NOT (
    (OLD."status" = 'SUBMITTED' AND NEW."status" IN ('CANCELLED', 'APPROVED', 'REJECTED'))
    OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('PARTIALLY_SHIPPED', 'SHIPPED'))
    OR (OLD."status" = 'PARTIALLY_SHIPPED' AND NEW."status" = 'SHIPPED')
  ) THEN
    RAISE EXCEPTION 'REPLENISHMENT_ORDER_STATE_TRANSITION_FORBIDDEN';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ReplenishmentOrder_state_transition"
BEFORE UPDATE ON "ReplenishmentOrder"
FOR EACH ROW EXECUTE FUNCTION "enforce_replenishment_order_state_transition"();

CREATE TRIGGER "ReplenishmentShipmentItem_refresh_order_status"
AFTER INSERT ON "ReplenishmentShipmentItem"
FOR EACH ROW EXECUTE FUNCTION "refresh_replenishment_order_shipping_status"();

CREATE FUNCTION "prevent_replenishment_shipment_rewrite"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'REPLENISHMENT_SHIPMENT_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ReplenishmentShipment_immutable_update"
BEFORE UPDATE ON "ReplenishmentShipment"
FOR EACH ROW EXECUTE FUNCTION "prevent_replenishment_shipment_rewrite"();
CREATE TRIGGER "ReplenishmentShipment_immutable_delete"
BEFORE DELETE ON "ReplenishmentShipment"
FOR EACH ROW EXECUTE FUNCTION "prevent_replenishment_shipment_rewrite"();
CREATE TRIGGER "ReplenishmentShipmentItem_immutable_update"
BEFORE UPDATE ON "ReplenishmentShipmentItem"
FOR EACH ROW EXECUTE FUNCTION "prevent_replenishment_shipment_rewrite"();
CREATE TRIGGER "ReplenishmentShipmentItem_immutable_delete"
BEFORE DELETE ON "ReplenishmentShipmentItem"
FOR EACH ROW EXECUTE FUNCTION "prevent_replenishment_shipment_rewrite"();
