-- AlterTable
ALTER TABLE "BigOrderBonus" ADD COLUMN "date" DATE;

-- 历史记录按创建日期回填
UPDATE "BigOrderBonus" SET "date" = "createdAt"::date;

-- AlterTable
ALTER TABLE "BigOrderBonus" ALTER COLUMN "date" SET NOT NULL;
