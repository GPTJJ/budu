-- RC-6A / migration 61: append-only product cost configuration authority.
-- Historical OrderItem.cost_price_snapshot facts are deliberately untouched.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE "inventory_item_cost_histories" (
  "id" TEXT NOT NULL,
  "inventory_item_id" TEXT NOT NULL,
  "cost_price_cents" BIGINT NOT NULL,
  "effective_from" DATE NOT NULL,
  "effective_to" DATE,
  "reason" TEXT NOT NULL DEFAULT '',
  "created_by" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inventory_item_cost_histories_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "inventory_item_cost_histories_cost_nonnegative" CHECK ("cost_price_cents" >= 0),
  CONSTRAINT "inventory_item_cost_histories_range_valid" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from"),
  CONSTRAINT "inventory_item_cost_histories_inventory_item_id_fkey"
    FOREIGN KEY ("inventory_item_id") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "inventory_item_cost_histories_item_from_key"
  ON "inventory_item_cost_histories"("inventory_item_id", "effective_from");
CREATE INDEX "inventory_item_cost_histories_item_range_idx"
  ON "inventory_item_cost_histories"("inventory_item_id", "effective_from", "effective_to");
ALTER TABLE "inventory_item_cost_histories"
  ADD CONSTRAINT "inventory_item_cost_histories_no_overlap"
  EXCLUDE USING gist (
    "inventory_item_id" WITH =,
    daterange("effective_from", COALESCE("effective_to", 'infinity'::date), '[)') WITH &&
  );

-- The existing current-cost projection becomes an explicit baseline only from
-- migration cutover. It is not backdated to item creation and cannot recalculate orders.
INSERT INTO "inventory_item_cost_histories" (
  "id", "inventory_item_id", "cost_price_cents", "effective_from", "reason", "created_by"
)
SELECT
  'ich-initial-' || "id",
  "id",
  "costPriceCents",
  (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date,
  'Migration 61 current-cost baseline; no historical inference',
  'migration-61'
FROM "InventoryItem"
WHERE "costPriceCents" IS NOT NULL;

-- Defense in depth: every future InventoryItem insertion or direct current-cost
-- projection change is versioned even if a caller bypasses the HTTP service.
CREATE OR REPLACE FUNCTION budu_guard_inventory_item_cost_history()
RETURNS trigger AS $$
DECLARE
  same_day RECORD;
  business_day DATE := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date;
BEGIN
  IF NEW."costPriceCents" IS NULL OR (TG_OP = 'UPDATE' AND NEW."costPriceCents" IS NOT DISTINCT FROM OLD."costPriceCents") THEN
    RETURN NEW;
  END IF;

  SELECT * INTO same_day
  FROM "inventory_item_cost_histories"
  WHERE "inventory_item_id" = NEW."id" AND "effective_from" = business_day
  LIMIT 1;

  IF FOUND THEN
    IF same_day."cost_price_cents" = NEW."costPriceCents" THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'product cost can only change once per business date; use audited future version';
  END IF;

  UPDATE "inventory_item_cost_histories"
  SET "effective_to" = business_day
  WHERE "inventory_item_id" = NEW."id" AND "effective_to" IS NULL AND "effective_from" < business_day;

  INSERT INTO "inventory_item_cost_histories" (
    "id", "inventory_item_id", "cost_price_cents", "effective_from", "reason", "created_by"
  ) VALUES (
    'ich-db-' || md5(NEW."id" || clock_timestamp()::text || random()::text),
    NEW."id", NEW."costPriceCents", business_day,
    CASE WHEN TG_OP = 'INSERT' THEN '商品创建初始成本' ELSE '数据库当前成本投影变更守卫' END,
    'database-cost-guard'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "inventory_item_cost_history_guard"
AFTER INSERT OR UPDATE OF "costPriceCents" ON "InventoryItem"
FOR EACH ROW EXECUTE FUNCTION budu_guard_inventory_item_cost_history();
