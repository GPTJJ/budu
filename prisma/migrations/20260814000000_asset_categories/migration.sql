-- budu 档案馆：动态分类表 + 内置分类种子 + 旧分类归并

CREATE TABLE "asset_categories" (
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "builtin" BOOLEAN NOT NULL DEFAULT false,
  "sort" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "asset_categories_pkey" PRIMARY KEY ("key")
);

INSERT INTO "asset_categories" ("key", "name", "builtin", "sort") VALUES
  ('license', '企业证照', true, 1),
  ('store', '新店签约', true, 2),
  ('brand', '品牌信息', true, 3),
  ('contract', '合同中心', true, 4),
  ('quality', '产品质检', true, 5),
  ('other', '其他文件', true, 6);

-- 旧分类（门店资料/人员资料/经营资料）统一归入“其他文件”，数据不丢失
UPDATE "asset_files" SET "category" = 'other' WHERE "category" IN ('store', 'staff', 'operation');
