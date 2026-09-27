-- Schema only. Historical product data is NOT rewritten by Prisma migrate.
CREATE TABLE "product_sku_sequences" (
  "prefix" TEXT NOT NULL PRIMARY KEY,
  "next_value" INTEGER NOT NULL DEFAULT 1,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_sku_sequences_prefix_check" CHECK ("prefix" IN ('BD', 'TP')),
  CONSTRAINT "product_sku_sequences_range_check" CHECK ("next_value" BETWEEN 1 AND 1000000)
);
INSERT INTO "product_sku_sequences" ("prefix", "next_value") VALUES ('BD', 1), ('TP', 1);

CREATE TABLE "product_sku_assignments" (
  "sku" TEXT NOT NULL PRIMARY KEY,
  "item_id" TEXT NOT NULL UNIQUE,
  "old_sku" TEXT,
  "actor_user_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_sku_assignments_format_check" CHECK ("sku" ~ '^(BD|TP)-[0-9]{6}$'),
  CONSTRAINT "product_sku_assignments_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "product_sku_aliases" (
  "alias" TEXT NOT NULL PRIMARY KEY,
  "item_id" TEXT NOT NULL,
  "actor_user_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_sku_aliases_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "product_sku_aliases_item_id_idx" ON "product_sku_aliases"("item_id");


-- Rollback compatibility guard: only the new SKU Authority writer may create products.
-- The capability is transaction-local via set_config(..., true), so it cannot leak
-- through the connection pool into the next transaction.
CREATE OR REPLACE FUNCTION product_sku_insert_guard() RETURNS trigger AS $sku_guard$
BEGIN
  IF NEW.category = 'product'
     AND current_setting('budu.sku_authority_writer', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'product creation requires SKU Authority writer';
  END IF;
  RETURN NEW;
END;
$sku_guard$ LANGUAGE plpgsql;
CREATE TRIGGER product_sku_insert_authority BEFORE INSERT ON "InventoryItem"
  FOR EACH ROW EXECUTE FUNCTION product_sku_insert_guard();

-- Preserve existing nonempty SKU as a canonical or alias, never both.
CREATE OR REPLACE FUNCTION product_sku_code_disjoint() RETURNS trigger AS $$
BEGIN
  -- Cross-table uniqueness requires both insert paths to share a lock.
  PERFORM pg_advisory_xact_lock(738211, 1);
  IF TG_TABLE_NAME = 'product_sku_aliases' THEN
    IF EXISTS (SELECT 1 FROM "product_sku_assignments" WHERE sku = NEW.alias) THEN
      RAISE EXCEPTION 'legacy SKU is a canonical allocation';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM "product_sku_aliases" WHERE alias = NEW.sku) THEN
      RAISE EXCEPTION 'canonical SKU is a legacy alias';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER product_sku_alias_disjoint BEFORE INSERT OR UPDATE ON "product_sku_aliases"
  FOR EACH ROW EXECUTE FUNCTION product_sku_code_disjoint();
CREATE TRIGGER product_sku_assignment_disjoint BEFORE INSERT OR UPDATE ON "product_sku_assignments"
  FOR EACH ROW EXECUTE FUNCTION product_sku_code_disjoint();

CREATE OR REPLACE FUNCTION product_sku_assignment_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'SKU allocations and aliases are append-only'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "InventoryItem" WHERE id = NEW.item_id AND sku = NEW.sku AND category = 'product') THEN
    RAISE EXCEPTION 'SKU allocation must match the canonical product';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER product_sku_assignment_append_only BEFORE INSERT OR UPDATE OR DELETE ON "product_sku_assignments"
  FOR EACH ROW EXECUTE FUNCTION product_sku_assignment_guard();
CREATE TRIGGER product_sku_alias_append_only BEFORE UPDATE OR DELETE ON "product_sku_aliases"
  FOR EACH ROW EXECUTE FUNCTION product_sku_assignment_guard();

CREATE OR REPLACE FUNCTION product_sku_product_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.category = 'product' AND EXISTS (SELECT 1 FROM "product_sku_assignments" WHERE item_id = OLD.id) THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.category IS DISTINCT FROM OLD.category OR NEW.name IS DISTINCT FROM OLD.name OR NEW.sku IS DISTINCT FROM OLD.sku THEN
      RAISE EXCEPTION 'assigned product identity, name and SKU are immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER product_sku_product_immutable BEFORE UPDATE ON "InventoryItem"
  FOR EACH ROW EXECUTE FUNCTION product_sku_product_guard();