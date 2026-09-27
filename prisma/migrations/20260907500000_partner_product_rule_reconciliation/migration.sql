-- Partner Replenishment Gate 9A: reconcile Partner quantity/unit rules with
-- InventoryItem as the single product, unit and standard-price authority.
-- Existing MOQ/step columns and historical snapshots remain intact. New
-- application writes use 1/1 compatibility snapshots and positive quantities.

ALTER TABLE "InventoryItem"
  DROP CONSTRAINT "InventoryItem_partner_order_unit_check",
  DROP CONSTRAINT "InventoryItem_partner_enabled_config_check",
  ADD CONSTRAINT "InventoryItem_partner_order_unit_check"
    CHECK ("partnerOrderUnit" IS NULL OR "partnerOrderUnit" IN ('KG', 'PCS', 'NATIVE')),
  ADD CONSTRAINT "InventoryItem_partner_enabled_config_check"
    CHECK (
      "partnerReplenishmentEnabled" = FALSE OR (
        "partnerOrderUnit" IN ('KG', 'PCS', 'NATIVE')
        AND "partnerMinOrderBaseQty" IS NOT NULL
        AND "partnerOrderStepBaseQty" IS NOT NULL
        AND (
          ("partnerOrderUnit" = 'KG' AND "partnerKgBasePriceCents" IS NOT NULL)
          OR
          ("partnerOrderUnit" = 'PCS' AND "salePriceCents" IS NOT NULL AND "salePriceCents" > 0)
          OR
          ("partnerOrderUnit" = 'NATIVE' AND char_length(trim("unit")) BETWEEN 1 AND 20
            AND "salePriceCents" IS NOT NULL AND "salePriceCents" > 0)
        )
      )
    );

ALTER TABLE "ReplenishmentOrderItem"
  ADD COLUMN "nativeUnitSnapshot" TEXT NOT NULL DEFAULT '',
  DROP CONSTRAINT "ReplenishmentOrderItem_order_unit_check",
  ADD CONSTRAINT "ReplenishmentOrderItem_order_unit_check"
    CHECK ("orderUnitSnapshot" IN ('KG', 'PCS', 'NATIVE')),
  ADD CONSTRAINT "ReplenishmentOrderItem_native_unit_check"
    CHECK (
      ("orderUnitSnapshot" = 'NATIVE' AND char_length(trim("nativeUnitSnapshot")) BETWEEN 1 AND 20)
      OR ("orderUnitSnapshot" IN ('KG', 'PCS') AND "nativeUnitSnapshot" = '')
    );

CREATE OR REPLACE FUNCTION "prevent_replenishment_order_item_snapshot_update"()
RETURNS TRIGGER AS $$
BEGIN
  IF ROW(
    NEW."replenishmentOrderId", NEW."inventoryItemId", NEW."productNameSnapshot",
    NEW."skuSnapshot", NEW."productCodeSnapshot", NEW."orderUnitSnapshot", NEW."nativeUnitSnapshot",
    NEW."requestedQuantityBase", NEW."basePriceSnapshotCents", NEW."discountBpsSnapshot",
    NEW."requestedLineAmountCents", NEW."minimumOrderBaseQtySnapshot",
    NEW."orderStepBaseQtySnapshot", NEW."createdAt"
  ) IS DISTINCT FROM ROW(
    OLD."replenishmentOrderId", OLD."inventoryItemId", OLD."productNameSnapshot",
    OLD."skuSnapshot", OLD."productCodeSnapshot", OLD."orderUnitSnapshot", OLD."nativeUnitSnapshot",
    OLD."requestedQuantityBase", OLD."basePriceSnapshotCents", OLD."discountBpsSnapshot",
    OLD."requestedLineAmountCents", OLD."minimumOrderBaseQtySnapshot",
    OLD."orderStepBaseQtySnapshot", OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'REPLENISHMENT_ORDER_ITEM_SNAPSHOT_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE "ReplenishmentShipmentItem"
  ADD COLUMN "nativeUnitSnapshot" TEXT NOT NULL DEFAULT '',
  DROP CONSTRAINT "ReplenishmentShipmentItem_unit_check",
  ADD CONSTRAINT "ReplenishmentShipmentItem_unit_check"
    CHECK ("orderUnitSnapshot" IN ('KG', 'PCS', 'NATIVE')),
  ADD CONSTRAINT "ReplenishmentShipmentItem_native_unit_check"
    CHECK (
      ("orderUnitSnapshot" = 'NATIVE' AND char_length(trim("nativeUnitSnapshot")) BETWEEN 1 AND 20)
      OR ("orderUnitSnapshot" IN ('KG', 'PCS') AND "nativeUnitSnapshot" = '')
    );

CREATE OR REPLACE FUNCTION "enforce_replenishment_shipment_quantity"()
RETURNS TRIGGER AS $$
DECLARE
  shipment_order_id TEXT;
  order_status TEXT;
  item_order_id TEXT;
  approved_quantity INTEGER;
  item_unit TEXT;
  item_native_unit TEXT;
  item_product_name TEXT;
  already_shipped BIGINT;
BEGIN
  SELECT "replenishmentOrderId" INTO shipment_order_id
    FROM "ReplenishmentShipment" WHERE "id" = NEW."replenishmentShipmentId";
  IF shipment_order_id IS NULL THEN RAISE EXCEPTION 'REPLENISHMENT_SHIPMENT_NOT_FOUND'; END IF;

  SELECT "status" INTO order_status
    FROM "ReplenishmentOrder" WHERE "id" = shipment_order_id FOR UPDATE;
  IF order_status NOT IN ('APPROVED', 'PARTIALLY_SHIPPED') THEN
    RAISE EXCEPTION 'REPLENISHMENT_SHIPMENT_ORDER_STATE_INVALID';
  END IF;

  SELECT "replenishmentOrderId", "approvedQuantityBase", "orderUnitSnapshot", "nativeUnitSnapshot", "productNameSnapshot"
    INTO item_order_id, approved_quantity, item_unit, item_native_unit, item_product_name
    FROM "ReplenishmentOrderItem" WHERE "id" = NEW."replenishmentOrderItemId" FOR UPDATE;
  IF item_order_id IS NULL OR item_order_id <> shipment_order_id THEN
    RAISE EXCEPTION 'REPLENISHMENT_SHIPMENT_ITEM_ORDER_MISMATCH';
  END IF;
  IF approved_quantity IS NULL OR approved_quantity <= 0 THEN
    RAISE EXCEPTION 'REPLENISHMENT_SHIPMENT_ITEM_NOT_APPROVED';
  END IF;
  IF NEW."orderUnitSnapshot" <> item_unit OR NEW."nativeUnitSnapshot" <> item_native_unit THEN
    RAISE EXCEPTION 'REPLENISHMENT_SHIPMENT_ITEM_UNIT_MISMATCH';
  END IF;
  IF NEW."productNameSnapshot" <> item_product_name THEN
    RAISE EXCEPTION 'REPLENISHMENT_SHIPMENT_ITEM_PRODUCT_SNAPSHOT_INVALID';
  END IF;

  SELECT COALESCE(SUM("shippedQuantityBase"), 0) INTO already_shipped
    FROM "ReplenishmentShipmentItem" WHERE "replenishmentOrderItemId" = NEW."replenishmentOrderItemId";
  IF already_shipped + NEW."shippedQuantityBase" > approved_quantity THEN
    RAISE EXCEPTION 'REPLENISHMENT_SHIPMENT_OVER_SHIP';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
