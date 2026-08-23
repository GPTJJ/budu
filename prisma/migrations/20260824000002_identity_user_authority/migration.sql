-- Data Authority DA-2：账号权威迁移至 PostgreSQL（扩展 User 表承载完整账号）
ALTER TABLE "User" ADD COLUMN "display_name" TEXT NOT NULL DEFAULT '';
ALTER TABLE "User" ADD COLUMN "store_keys" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "User" ADD COLUMN "staff_key" TEXT NOT NULL DEFAULT '';
ALTER TABLE "User" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "User" ADD COLUMN "second_password_hash" TEXT NOT NULL DEFAULT '';
ALTER TABLE "User" ADD COLUMN "binding_legacy_exempt" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "asset_center" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "permissions" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "User" ADD COLUMN "disabled_at" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "User" ADD COLUMN "permissions_updated_at" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "permissions_updated_by" TEXT NOT NULL DEFAULT '';
-- 统一 User 时间列命名为 snake_case（原表列为 "createdAt"）
ALTER TABLE "User" RENAME COLUMN "createdAt" TO "created_at";
