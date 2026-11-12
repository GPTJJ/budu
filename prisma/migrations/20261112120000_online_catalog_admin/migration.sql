-- ONLINE-CATALOG-ADMIN-001
-- Online catalog management tables. The CloudBase `products` collection remains
-- the MiniProgram read model; these tables are the OS-side management authority.

CREATE TABLE "online_categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "online_categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "online_categories_name_key" ON "online_categories"("name");
CREATE INDEX "online_categories_is_active_sort_order_idx" ON "online_categories"("is_active", "sort_order");

CREATE TABLE "online_product_profiles" (
    "id" TEXT NOT NULL,
    "inventory_item_id" TEXT NOT NULL,
    "mp_id" TEXT NOT NULL,
    "online_category_id" TEXT,
    "title" TEXT NOT NULL DEFAULT '',
    "subtitle" TEXT NOT NULL DEFAULT '',
    "spec" TEXT NOT NULL DEFAULT '',
    "unit" TEXT NOT NULL DEFAULT '',
    "price_cents" BIGINT,
    "shelf_life" TEXT NOT NULL DEFAULT '',
    "storage" TEXT NOT NULL DEFAULT '',
    "media" JSONB NOT NULL DEFAULT '{}',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "publish_state" TEXT NOT NULL DEFAULT 'UNPUBLISHED',
    "published_version" INTEGER NOT NULL DEFAULT 0,
    "published_at" TIMESTAMP(3),
    "last_error" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "online_product_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "online_product_profiles_inventory_item_id_key" ON "online_product_profiles"("inventory_item_id");
CREATE UNIQUE INDEX "online_product_profiles_mp_id_key" ON "online_product_profiles"("mp_id");
CREATE INDEX "online_product_profiles_status_sort_order_idx" ON "online_product_profiles"("status", "sort_order");
CREATE INDEX "online_product_profiles_online_category_id_sort_order_idx" ON "online_product_profiles"("online_category_id", "sort_order");

ALTER TABLE "online_product_profiles"
    ADD CONSTRAINT "online_product_profiles_inventory_item_id_fkey"
    FOREIGN KEY ("inventory_item_id") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "online_product_profiles"
    ADD CONSTRAINT "online_product_profiles_online_category_id_fkey"
    FOREIGN KEY ("online_category_id") REFERENCES "online_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
