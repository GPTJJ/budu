-- Enterprise asset center: files, versions, grants, logs, reminders.

CREATE TABLE "asset_files" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "company" TEXT NOT NULL DEFAULT '',
  "store_key" TEXT NOT NULL DEFAULT '',
  "tags" JSONB NOT NULL DEFAULT '[]',
  "description" TEXT NOT NULL DEFAULT '',
  "file_type" TEXT NOT NULL DEFAULT '',
  "file_size" INTEGER NOT NULL DEFAULT 0,
  "storage_provider" TEXT NOT NULL DEFAULT 'local',
  "storage_key" TEXT NOT NULL DEFAULT '',
  "current_version" INTEGER NOT NULL DEFAULT 1,
  "issuing_authority" TEXT NOT NULL DEFAULT '',
  "license_no" TEXT NOT NULL DEFAULT '',
  "issue_date" TIMESTAMP(3),
  "expiry_date" TIMESTAMP(3),
  "is_permanent" BOOLEAN NOT NULL DEFAULT false,
  "deleted_at" TIMESTAMP(3),
  "created_by" TEXT NOT NULL DEFAULT '',
  "updated_by" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "asset_files_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "asset_files_category_deleted_at_idx" ON "asset_files"("category", "deleted_at");
CREATE INDEX "asset_files_store_key_deleted_at_idx" ON "asset_files"("store_key", "deleted_at");
CREATE INDEX "asset_files_expiry_date_idx" ON "asset_files"("expiry_date");

CREATE TABLE "asset_file_versions" (
  "id" TEXT NOT NULL,
  "file_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "file_type" TEXT NOT NULL DEFAULT '',
  "file_size" INTEGER NOT NULL DEFAULT 0,
  "data_url" TEXT NOT NULL,
  "storage_provider" TEXT NOT NULL DEFAULT 'local',
  "storage_key" TEXT NOT NULL DEFAULT '',
  "uploader_id" TEXT NOT NULL DEFAULT '',
  "uploader_name" TEXT NOT NULL DEFAULT '',
  "note" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "asset_file_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "asset_file_versions_file_id_version_key" ON "asset_file_versions"("file_id", "version");
CREATE INDEX "asset_file_versions_file_id_idx" ON "asset_file_versions"("file_id");

ALTER TABLE "asset_file_versions" ADD CONSTRAINT "asset_file_versions_file_id_fkey"
  FOREIGN KEY ("file_id") REFERENCES "asset_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "asset_access_grants" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "granted_by" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "asset_access_grants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "asset_access_grants_user_id_key" ON "asset_access_grants"("user_id");

CREATE TABLE "asset_operation_logs" (
  "id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "user_id" TEXT NOT NULL DEFAULT '',
  "username" TEXT NOT NULL DEFAULT '',
  "file_id" TEXT NOT NULL DEFAULT '',
  "file_name" TEXT NOT NULL DEFAULT '',
  "store_key" TEXT NOT NULL DEFAULT '',
  "detail" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "asset_operation_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "asset_operation_logs_created_at_idx" ON "asset_operation_logs"("created_at");
CREATE INDEX "asset_operation_logs_file_id_idx" ON "asset_operation_logs"("file_id");

CREATE TABLE "asset_reminders" (
  "id" TEXT NOT NULL,
  "file_id" TEXT NOT NULL,
  "file_name" TEXT NOT NULL DEFAULT '',
  "store_key" TEXT NOT NULL DEFAULT '',
  "remind_type" TEXT NOT NULL,
  "days_left" INTEGER NOT NULL DEFAULT 0,
  "sent" BOOLEAN NOT NULL DEFAULT false,
  "notified_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "asset_reminders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "asset_reminders_file_id_remind_type_key" ON "asset_reminders"("file_id", "remind_type");
CREATE INDEX "asset_reminders_created_at_idx" ON "asset_reminders"("created_at");
