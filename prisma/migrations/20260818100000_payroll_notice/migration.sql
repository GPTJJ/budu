-- CreateTable
CREATE TABLE "payroll_notices" (
    "id" TEXT NOT NULL,
    "period_type" TEXT NOT NULL,
    "period_key" TEXT NOT NULL,
    "employee_name" TEXT NOT NULL,
    "store_key" TEXT NOT NULL,
    "target_username" TEXT NOT NULL DEFAULT '',
    "snapshot" JSONB NOT NULL,
    "total_cents" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "confirmed_at" TIMESTAMP(3),
    "confirmed_by" TEXT NOT NULL DEFAULT '',
    "created_by" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payroll_notices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payroll_notices_target_username_status_idx" ON "payroll_notices"("target_username", "status");

-- CreateIndex
CREATE INDEX "payroll_notices_period_key_idx" ON "payroll_notices"("period_key");
