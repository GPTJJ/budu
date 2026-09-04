-- budu 甜意卡 1.0 Candidate (migration 63). Additive only; feature defaults OFF in application code.
CREATE TYPE "SweetCardValidityType" AS ENUM ('ONE_YEAR', 'THREE_YEARS', 'LONG_TERM');
CREATE TYPE "SweetCardCarrierType" AS ENUM ('PHYSICAL', 'ELECTRONIC');
CREATE TYPE "SweetCardBindingMode" AS ENUM ('NONE', 'OPTIONAL', 'REQUIRED');
CREATE TYPE "SweetCardAccountStatus" AS ENUM ('CREATED', 'ACTIVE', 'FROZEN', 'LOST', 'EXHAUSTED', 'EXPIRED', 'VOID');
CREATE TYPE "SweetCardCredentialStatus" AS ENUM ('UNACTIVATED', 'ACTIVE', 'REVOKED');
CREATE TYPE "SweetCardLedgerType" AS ENUM ('ISSUE', 'REDEEM', 'REFUND', 'REVERSAL');

ALTER TABLE "orders" ADD COLUMN "sweet_card_amount" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "order_items" ADD COLUMN "sweet_card_eligible_snapshot" BOOLEAN,
  ADD COLUMN "sweet_card_category_id_snapshot" TEXT,
  ADD COLUMN "sweet_card_redeemed_amount" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "refunds" ADD COLUMN "provider_refund_amount" BIGINT,
  ADD COLUMN "sweet_card_refund_amount" BIGINT;

CREATE TABLE "sweet_card_batches" (
  "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "purpose" TEXT NOT NULL DEFAULT '',
  "face_value_cents" BIGINT NOT NULL, "card_count" INTEGER NOT NULL,
  "total_initial_amount_cents" BIGINT NOT NULL, "validity_type" "SweetCardValidityType" NOT NULL,
  "carrier_type" "SweetCardCarrierType" NOT NULL, "binding_mode" "SweetCardBindingMode" NOT NULL,
  "gifting_scenario" TEXT NOT NULL DEFAULT '', "presentation_template_key" TEXT NOT NULL DEFAULT 'minimal-v1',
  "created_by_id" TEXT NOT NULL, "created_by_name" TEXT NOT NULL DEFAULT '', "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sweet_card_batches_amount_check" CHECK ("face_value_cents" > 0 AND "card_count" > 0 AND "total_initial_amount_cents" = "face_value_cents" * "card_count")
);
CREATE INDEX "sweet_card_batches_created_at_idx" ON "sweet_card_batches"("created_at");

CREATE TABLE "sweet_card_accounts" (
  "id" TEXT PRIMARY KEY, "public_card_no" TEXT NOT NULL UNIQUE, "batch_id" TEXT,
  "initial_amount_cents" BIGINT NOT NULL, "balance_cents" BIGINT NOT NULL,
  "validity_type" "SweetCardValidityType" NOT NULL, "valid_from" TIMESTAMP(3), "expires_at" TIMESTAMP(3),
  "status" "SweetCardAccountStatus" NOT NULL DEFAULT 'CREATED', "carrier_type" "SweetCardCarrierType" NOT NULL,
  "binding_mode" "SweetCardBindingMode" NOT NULL, "recipient_type" TEXT NOT NULL DEFAULT '',
  "recipient_label" TEXT NOT NULL DEFAULT '', "recipient_company" TEXT NOT NULL DEFAULT '', "recipient_note" TEXT NOT NULL DEFAULT '',
  "gifting_scenario" TEXT NOT NULL DEFAULT '', "issued_by_id" TEXT NOT NULL DEFAULT '', "issued_by_name" TEXT NOT NULL DEFAULT '',
  "issued_at" TIMESTAMP(3), "activated_by_id" TEXT NOT NULL DEFAULT '', "activated_at" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sweet_card_accounts_batch_fkey" FOREIGN KEY ("batch_id") REFERENCES "sweet_card_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sweet_card_accounts_balance_check" CHECK ("initial_amount_cents" > 0 AND "balance_cents" >= 0 AND "balance_cents" <= "initial_amount_cents"),
  CONSTRAINT "sweet_card_accounts_expiry_check" CHECK ("expires_at" IS NULL OR "valid_from" IS NULL OR "expires_at" > "valid_from")
);
CREATE INDEX "sweet_card_accounts_batch_id_status_idx" ON "sweet_card_accounts"("batch_id", "status");
CREATE INDEX "sweet_card_accounts_status_expires_at_idx" ON "sweet_card_accounts"("status", "expires_at");

CREATE TABLE "sweet_card_credentials" (
  "id" TEXT PRIMARY KEY, "account_id" TEXT NOT NULL, "public_token_id" TEXT NOT NULL UNIQUE,
  "token_hash" TEXT NOT NULL UNIQUE, "token_ciphertext" TEXT NOT NULL, "token_iv" TEXT NOT NULL, "token_tag" TEXT NOT NULL,
  "status" "SweetCardCredentialStatus" NOT NULL DEFAULT 'UNACTIVATED', "carrier_type" "SweetCardCarrierType" NOT NULL,
  "activated_at" TIMESTAMP(3), "revoked_at" TIMESTAMP(3), "revoke_reason" TEXT NOT NULL DEFAULT '',
  "replaced_by_credential_id" TEXT UNIQUE, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sweet_card_credentials_account_fkey" FOREIGN KEY ("account_id") REFERENCES "sweet_card_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sweet_card_credentials_replacement_fkey" FOREIGN KEY ("replaced_by_credential_id") REFERENCES "sweet_card_credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "sweet_card_credentials_account_id_status_idx" ON "sweet_card_credentials"("account_id", "status");

CREATE TABLE "sweet_card_bindings" (
  "id" TEXT PRIMARY KEY, "account_id" TEXT NOT NULL UNIQUE, "member_id" TEXT NOT NULL,
  "verification_method" TEXT NOT NULL DEFAULT 'ADMIN_VERIFIED', "bound_by_id" TEXT NOT NULL,
  "bound_by_name" TEXT NOT NULL DEFAULT '', "bound_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sweet_card_bindings_account_fkey" FOREIGN KEY ("account_id") REFERENCES "sweet_card_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sweet_card_bindings_member_fkey" FOREIGN KEY ("member_id") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "sweet_card_bindings_member_id_bound_at_idx" ON "sweet_card_bindings"("member_id", "bound_at");

CREATE TABLE "sweet_card_store_policies" (
  "store_id" TEXT PRIMARY KEY, "eligible" BOOLEAN NOT NULL DEFAULT false, "updated_by_id" TEXT NOT NULL DEFAULT '',
  "updated_by_name" TEXT NOT NULL DEFAULT '', "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sweet_card_store_policies_store_fkey" FOREIGN KEY ("store_id") REFERENCES "Store"("key") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "sweet_card_category_policies" (
  "category_id" TEXT PRIMARY KEY, "blocked" BOOLEAN NOT NULL DEFAULT true, "updated_by_id" TEXT NOT NULL DEFAULT '',
  "updated_by_name" TEXT NOT NULL DEFAULT '', "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sweet_card_category_policies_category_fkey" FOREIGN KEY ("category_id") REFERENCES "ProductCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "sweet_card_redemptions" (
  "id" TEXT PRIMARY KEY, "redemption_no" TEXT NOT NULL UNIQUE, "order_id" TEXT NOT NULL UNIQUE,
  "account_id" TEXT NOT NULL, "credential_id" TEXT NOT NULL, "amount_cents" BIGINT NOT NULL,
  "eligible_subtotal_cents" BIGINT NOT NULL, "ineligible_subtotal_cents" BIGINT NOT NULL,
  "request_key" TEXT NOT NULL UNIQUE, "store_id_snapshot" TEXT NOT NULL, "redeemed_by_id" TEXT NOT NULL,
  "redeemed_by_name" TEXT NOT NULL DEFAULT '', "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sweet_card_redemptions_order_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sweet_card_redemptions_account_fkey" FOREIGN KEY ("account_id") REFERENCES "sweet_card_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sweet_card_redemptions_credential_fkey" FOREIGN KEY ("credential_id") REFERENCES "sweet_card_credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sweet_card_redemptions_amount_check" CHECK ("amount_cents" > 0 AND "amount_cents" <= "eligible_subtotal_cents")
);
CREATE INDEX "sweet_card_redemptions_account_id_created_at_idx" ON "sweet_card_redemptions"("account_id", "created_at");

CREATE TABLE "sweet_card_redemption_items" (
  "id" TEXT PRIMARY KEY, "redemption_id" TEXT NOT NULL, "order_item_id" TEXT NOT NULL, "product_id" TEXT NOT NULL,
  "category_id_snapshot" TEXT, "eligible_snapshot" BOOLEAN NOT NULL, "eligible_amount_cents" BIGINT NOT NULL,
  "redeemed_amount_cents" BIGINT NOT NULL,
  CONSTRAINT "sweet_card_redemption_items_redemption_fkey" FOREIGN KEY ("redemption_id") REFERENCES "sweet_card_redemptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sweet_card_redemption_items_order_item_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sweet_card_redemption_items_product_fkey" FOREIGN KEY ("product_id") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sweet_card_redemption_items_amount_check" CHECK ("eligible_amount_cents" >= 0 AND "redeemed_amount_cents" >= 0 AND "redeemed_amount_cents" <= "eligible_amount_cents")
);
CREATE UNIQUE INDEX "sweet_card_redemption_items_redemption_order_item_key" ON "sweet_card_redemption_items"("redemption_id", "order_item_id");
CREATE INDEX "sweet_card_redemption_items_order_item_id_idx" ON "sweet_card_redemption_items"("order_item_id");

CREATE TABLE "sweet_card_ledger" (
  "id" TEXT PRIMARY KEY, "account_id" TEXT NOT NULL, "type" "SweetCardLedgerType" NOT NULL,
  "amount_cents" BIGINT NOT NULL, "balance_after_cents" BIGINT NOT NULL, "order_id" TEXT, "redemption_id" TEXT,
  "refund_id" TEXT, "request_key" TEXT NOT NULL UNIQUE, "actor_id" TEXT NOT NULL DEFAULT '', "actor_name" TEXT NOT NULL DEFAULT '',
  "metadata" JSONB NOT NULL DEFAULT '{}', "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sweet_card_ledger_account_fkey" FOREIGN KEY ("account_id") REFERENCES "sweet_card_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sweet_card_ledger_redemption_fkey" FOREIGN KEY ("redemption_id") REFERENCES "sweet_card_redemptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sweet_card_ledger_order_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sweet_card_ledger_refund_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sweet_card_ledger_balance_check" CHECK ("balance_after_cents" >= 0),
  CONSTRAINT "sweet_card_ledger_delta_check" CHECK (("type" IN ('ISSUE','REFUND','REVERSAL') AND "amount_cents" > 0) OR ("type" = 'REDEEM' AND "amount_cents" < 0))
);
CREATE INDEX "sweet_card_ledger_account_id_created_at_idx" ON "sweet_card_ledger"("account_id", "created_at");
CREATE INDEX "sweet_card_ledger_order_id_idx" ON "sweet_card_ledger"("order_id");
CREATE INDEX "sweet_card_ledger_refund_id_idx" ON "sweet_card_ledger"("refund_id");

CREATE TABLE "sweet_card_refunds" (
  "id" TEXT PRIMARY KEY, "refund_id" TEXT NOT NULL UNIQUE, "redemption_id" TEXT NOT NULL, "account_id" TEXT NOT NULL,
  "amount_cents" BIGINT NOT NULL, "request_key" TEXT NOT NULL UNIQUE, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sweet_card_refunds_refund_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sweet_card_refunds_redemption_fkey" FOREIGN KEY ("redemption_id") REFERENCES "sweet_card_redemptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sweet_card_refunds_account_fkey" FOREIGN KEY ("account_id") REFERENCES "sweet_card_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sweet_card_refunds_amount_check" CHECK ("amount_cents" > 0)
);
CREATE INDEX "sweet_card_refunds_account_id_created_at_idx" ON "sweet_card_refunds"("account_id", "created_at");

CREATE TABLE "sweet_card_refund_items" (
  "id" TEXT PRIMARY KEY, "sweet_card_refund_id" TEXT NOT NULL, "refund_item_id" TEXT NOT NULL UNIQUE,
  "redemption_item_id" TEXT NOT NULL, "amount_cents" BIGINT NOT NULL,
  CONSTRAINT "sweet_card_refund_items_refund_fkey" FOREIGN KEY ("sweet_card_refund_id") REFERENCES "sweet_card_refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sweet_card_refund_items_refund_item_fkey" FOREIGN KEY ("refund_item_id") REFERENCES "refund_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sweet_card_refund_items_redemption_item_fkey" FOREIGN KEY ("redemption_item_id") REFERENCES "sweet_card_redemption_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sweet_card_refund_items_amount_check" CHECK ("amount_cents" >= 0)
);
CREATE INDEX "sweet_card_refund_items_sweet_card_refund_id_idx" ON "sweet_card_refund_items"("sweet_card_refund_id");

CREATE TABLE "sweet_card_audit_logs" (
  "id" TEXT PRIMARY KEY, "batch_id" TEXT, "account_id" TEXT, "credential_id" TEXT, "action" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL DEFAULT '', "actor_name" TEXT NOT NULL DEFAULT '', "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sweet_card_audit_logs_batch_fkey" FOREIGN KEY ("batch_id") REFERENCES "sweet_card_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sweet_card_audit_logs_account_fkey" FOREIGN KEY ("account_id") REFERENCES "sweet_card_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sweet_card_audit_logs_credential_fkey" FOREIGN KEY ("credential_id") REFERENCES "sweet_card_credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "sweet_card_audit_logs_account_id_created_at_idx" ON "sweet_card_audit_logs"("account_id", "created_at");
CREATE INDEX "sweet_card_audit_logs_batch_id_created_at_idx" ON "sweet_card_audit_logs"("batch_id", "created_at");
CREATE INDEX "sweet_card_audit_logs_action_created_at_idx" ON "sweet_card_audit_logs"("action", "created_at");
