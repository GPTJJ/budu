-- Gate 29N: explicit operational participant authority (additive only).
-- Existing historical rows are preserved byte-for-byte and classified fail-closed.
ALTER TABLE "User"
  ADD COLUMN "operational_identity_type" TEXT NOT NULL DEFAULT 'STANDARD';

ALTER TABLE "daily_store_staff"
  ADD COLUMN "participant_type" TEXT NOT NULL DEFAULT 'LEGACY_UNKNOWN',
  ADD COLUMN "participant_user_id" TEXT;

ALTER TABLE "User"
  ADD CONSTRAINT "User_operational_identity_type_check"
  CHECK ("operational_identity_type" IN ('STANDARD', 'NON_EMPLOYEE_OPERATIONAL_SUBSTITUTE'));

ALTER TABLE "daily_store_staff"
  ADD CONSTRAINT "daily_store_staff_participant_type_check"
  CHECK ("participant_type" IN ('EMPLOYEE', 'NON_EMPLOYEE_SUBSTITUTE', 'LEGACY_EMPLOYEE_COMPATIBLE', 'LEGACY_UNKNOWN')),
  ADD CONSTRAINT "daily_store_staff_participant_identity_check"
  CHECK (
    ("participant_type" = 'EMPLOYEE' AND "employee_id" IS NOT NULL AND "participant_user_id" IS NULL)
    OR ("participant_type" = 'NON_EMPLOYEE_SUBSTITUTE' AND "employee_id" IS NULL AND "participant_user_id" IS NOT NULL)
    OR ("participant_type" = 'LEGACY_EMPLOYEE_COMPATIBLE' AND "employee_id" IS NULL AND "participant_user_id" IS NULL)
    -- All pre-migration rows intentionally default to LEGACY_UNKNOWN. Some prior
    -- shadow-era rows already carry employee_id; that fact is not silently promoted
    -- into payroll authority by this migration.
    OR ("participant_type" = 'LEGACY_UNKNOWN' AND "participant_user_id" IS NULL)
  ),
  ADD CONSTRAINT "daily_store_staff_participant_user_id_fkey"
  FOREIGN KEY ("participant_user_id") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "daily_store_staff_participant_user_id_idx"
  ON "daily_store_staff"("participant_user_id");
