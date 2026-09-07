-- A3 authoritative claim/binding facts. This migration is additive and does
-- not touch Sweet Card balances, Ledger, Redemption, Refund, Payment, Order,
-- or any historical economic amount.
ALTER TABLE "sweet_card_bindings"
  ALTER COLUMN "member_id" DROP NOT NULL,
  ADD COLUMN "user_id" TEXT,
  ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'ADMIN';

ALTER TABLE "sweet_card_bindings"
  ADD CONSTRAINT "sweet_card_bindings_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "sweet_card_bindings_exactly_one_owner_check"
  CHECK (("member_id" IS NOT NULL)::int + ("user_id" IS NOT NULL)::int = 1);

CREATE INDEX "sweet_card_bindings_user_id_bound_at_idx"
  ON "sweet_card_bindings"("user_id", "bound_at");

CREATE TABLE "sweet_card_claims" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "token_id" TEXT NOT NULL,
  "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "channel" TEXT NOT NULL DEFAULT 'MINIPROGRAM',
  "source_carrier" "SweetCardCarrierType" NOT NULL,
  "request_key_hash" TEXT NOT NULL,
  CONSTRAINT "sweet_card_claims_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sweet_card_claims_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "sweet_card_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sweet_card_claims_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sweet_card_claims_token_id_fkey"
    FOREIGN KEY ("token_id") REFERENCES "sweet_card_claim_tokens"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "sweet_card_claims_account_id_key"
  ON "sweet_card_claims"("account_id");
CREATE UNIQUE INDEX "sweet_card_claims_token_id_key"
  ON "sweet_card_claims"("token_id");
CREATE UNIQUE INDEX "sweet_card_claims_user_id_request_key_hash_key"
  ON "sweet_card_claims"("user_id", "request_key_hash");
CREATE INDEX "sweet_card_claims_user_id_claimed_at_idx"
  ON "sweet_card_claims"("user_id", "claimed_at");
