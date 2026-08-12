-- 新店签约合并到品牌信息

UPDATE "asset_files" SET "category" = 'brand' WHERE "category" = 'store';

DELETE FROM "asset_categories" WHERE "key" = 'store';

UPDATE "asset_categories" SET "sort" = 2 WHERE "key" = 'brand';
UPDATE "asset_categories" SET "sort" = 3 WHERE "key" = 'contract';
UPDATE "asset_categories" SET "sort" = 4 WHERE "key" = 'quality';
UPDATE "asset_categories" SET "sort" = 5 WHERE "key" = 'other';
