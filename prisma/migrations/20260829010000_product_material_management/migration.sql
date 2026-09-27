-- Product/material management is separate from POS merchandising. These
-- additive fields prevent transfer availability and order from changing POS.
ALTER TABLE "InventoryItem"
  ADD COLUMN "transferCode" TEXT,
  ADD COLUMN "transferEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "transferSortOrder" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "PurchaseItem"
  ADD COLUMN "itemNameSnapshot" TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX "InventoryItem_transferCode_key"
  ON "InventoryItem"("transferCode");

CREATE INDEX "InventoryItem_transfer_master_idx"
  ON "InventoryItem"("category", "transferEnabled", "transferSortOrder");

-- Preserve the exact selector that was visible immediately before this
-- release: NO.1–NO.12 products and the 26 material rows. Other InventoryItem
-- rows (including POS-only products) remain disabled for transfer selection.
UPDATE "InventoryItem" AS item
SET
  "transferEnabled" = true,
  "transferSortOrder" = seed.sort_order,
  "transferCode" = seed.code
FROM (VALUES
  ('NO.1树莓', 1, 'NO.1'),
  ('NO.2柠檬', 2, 'NO.2'),
  ('NO.3百香果', 3, 'NO.3'),
  ('NO.4橙子', 4, 'NO.4'),
  ('NO.5英式伯爵茶', 5, 'NO.5'),
  ('NO.6泰式奶茶', 6, 'NO.6'),
  ('NO.7抹茶', 7, 'NO.7'),
  ('NO.8榛子', 8, 'NO.8'),
  ('NO.9海盐焦糖', 9, 'NO.9'),
  ('NO.10香草', 10, 'NO.10'),
  ('NO.11生椰拿铁', 11, 'NO.11'),
  ('NO.12巧克力', 12, 'NO.12'),
  ('物料-8颗礼盒（长）', 1, NULL),
  ('物料8颗礼盒（方）', 2, NULL),
  ('物料12颗礼盒', 3, NULL),
  ('物料24颗礼盒', 4, NULL),
  ('丝带-红', 5, NULL),
  ('丝带-蓝', 6, NULL),
  ('手提袋', 7, NULL),
  ('散糖袋', 8, NULL),
  ('冰袋', 9, NULL),
  ('巧克力豆礼盒', 10, NULL),
  ('巧克力豆礼盒手提袋', 11, NULL),
  ('保温袋', 12, NULL),
  ('酒精', 13, NULL),
  ('手套', 14, NULL),
  ('纸巾', 15, NULL),
  ('湿巾', 16, NULL),
  ('背贴', 17, NULL),
  ('胶带', 18, NULL),
  ('糖果口味卡', 19, NULL),
  ('生巧保存提示卡', 20, NULL),
  ('封口贴', 21, NULL),
  ('试吃签', 22, NULL),
  ('冰淇淋小勺', 23, NULL),
  ('冰淇淋碗-圆', 24, NULL),
  ('冰淇淋碗内-方', 25, NULL),
  ('小票打印纸', 26, NULL)
) AS seed(name, sort_order, code)
WHERE item.name = seed.name;
