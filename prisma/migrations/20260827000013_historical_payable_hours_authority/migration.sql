ALTER TABLE "daily_store_staff"
  ALTER COLUMN "actual_hours" DROP DEFAULT,
  ALTER COLUMN "actual_hours" DROP NOT NULL,
  ADD COLUMN "historical_payroll_hours" DOUBLE PRECISION,
  ADD COLUMN "payable_hours_source" TEXT NOT NULL DEFAULT 'ACTUAL_HOURS';

ALTER TABLE "daily_store_staff"
  ADD CONSTRAINT "daily_store_staff_payable_hours_source_check"
    CHECK ("payable_hours_source" IN ('ACTUAL_HOURS', 'LEGACY_PAYROLL_HOURS')),
  ADD CONSTRAINT "daily_store_staff_actual_hours_range_check"
    CHECK ("actual_hours" IS NULL OR ("actual_hours" >= 0 AND "actual_hours" <= 24)),
  ADD CONSTRAINT "daily_store_staff_historical_payroll_hours_range_check"
    CHECK ("historical_payroll_hours" IS NULL OR ("historical_payroll_hours" >= 0 AND "historical_payroll_hours" <= 24)),
  ADD CONSTRAINT "daily_store_staff_payable_hours_tagged_union_check"
    CHECK (
      (
        "payable_hours_source" = 'ACTUAL_HOURS'
        AND "actual_hours" IS NOT NULL
        AND "historical_payroll_hours" IS NULL
        AND "attendance_status" <> 'HISTORICAL_UNOBSERVED'
      )
      OR
      (
        "payable_hours_source" = 'LEGACY_PAYROLL_HOURS'
        AND "actual_hours" IS NULL
        AND "historical_payroll_hours" IS NOT NULL
        AND "attendance_status" = 'HISTORICAL_UNOBSERVED'
      )
    );
