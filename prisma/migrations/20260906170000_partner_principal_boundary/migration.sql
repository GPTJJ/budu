-- Partner Replenishment Gate 1: additive principal/session and tenant-binding
-- foundation. Existing customer session rows are deterministically CUSTOMER
-- because this table previously accepted customer sessions only.
ALTER TABLE "customer_sessions"
  ADD COLUMN "principal_type" TEXT NOT NULL DEFAULT 'CUSTOMER';

ALTER TABLE "customer_sessions"
  ADD CONSTRAINT "customer_sessions_principal_type_check"
  CHECK ("principal_type" IN ('CUSTOMER', 'PARTNER'));

CREATE INDEX "customer_sessions_principal_type_user_id_expires_at_idx"
  ON "customer_sessions"("principal_type", "user_id", "expires_at");

CREATE TABLE "partner_users" (
  "id" TEXT NOT NULL,
  "partner_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "created_by_id" TEXT NOT NULL DEFAULT '',
  "disabled_at" TIMESTAMP(3),
  "disabled_by_id" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "partner_users_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "partner_users_status_check" CHECK ("status" IN ('active', 'disabled')),
  CONSTRAINT "partner_users_partner_id_fkey"
    FOREIGN KEY ("partner_id") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "partner_users_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "partner_users_user_id_key"
  ON "partner_users"("user_id");
CREATE UNIQUE INDEX "partner_users_partner_id_user_id_key"
  ON "partner_users"("partner_id", "user_id");
CREATE INDEX "partner_users_partner_id_status_idx"
  ON "partner_users"("partner_id", "status");
