CREATE TABLE "daily_pay_adjustments" (
    "id" TEXT NOT NULL,
    "staff_name" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "auto_pay_cents_snapshot" BIGINT NOT NULL DEFAULT 0,
    "adjusted_pay_cents" BIGINT NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL DEFAULT '',
    "updated_by" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "daily_pay_adjustments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "daily_pay_adjustments_staff_name_date_key"
ON "daily_pay_adjustments"("staff_name", "date");

CREATE INDEX "daily_pay_adjustments_date_idx"
ON "daily_pay_adjustments"("date");

CREATE TABLE "daily_pay_adjustment_audit_logs" (
    "id" TEXT NOT NULL,
    "adjustment_id" TEXT NOT NULL,
    "staff_name" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "action" TEXT NOT NULL,
    "before_value" JSONB,
    "after_value" JSONB,
    "operator_name" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_pay_adjustment_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "daily_pay_adjustment_audit_logs_adjustment_id_created_at_idx"
ON "daily_pay_adjustment_audit_logs"("adjustment_id", "created_at");

CREATE INDEX "daily_pay_adjustment_audit_logs_staff_name_date_idx"
ON "daily_pay_adjustment_audit_logs"("staff_name", "date");
