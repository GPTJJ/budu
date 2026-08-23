-- Data Authority DA-3：排班权威迁移至 PostgreSQL
CREATE TABLE "schedules" (
    "id" TEXT NOT NULL,
    "week_start" TEXT NOT NULL,
    "store_key" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "shifts" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "schedules_week_start_store_key_date_key" ON "schedules"("week_start", "store_key", "date");
CREATE INDEX "schedules_week_start_idx" ON "schedules"("week_start");
