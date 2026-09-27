-- A2 claim-delivery credential only. It is independent from the existing POS
-- redemption credential and has no balance, Ledger, Redemption, Refund,
-- Payment, Order, Binding, or Claim mutation.
CREATE TABLE "sweet_card_claim_tokens" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "proof_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "revoked_at" TIMESTAMP(3),
  "consumed_at" TIMESTAMP(3),
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sweet_card_claim_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sweet_card_claim_tokens_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "sweet_card_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sweet_card_claim_tokens_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "sweet_card_claim_tokens_token_hash_key"
  ON "sweet_card_claim_tokens"("token_hash");
CREATE UNIQUE INDEX "sweet_card_claim_tokens_proof_hash_key"
  ON "sweet_card_claim_tokens"("proof_hash");
CREATE INDEX "sweet_card_claim_tokens_account_id_created_at_idx"
  ON "sweet_card_claim_tokens"("account_id", "created_at");

-- At most one currently usable delivery credential per card account. Reissue
-- first revokes the previous active row in the same transaction.
CREATE UNIQUE INDEX "sweet_card_claim_tokens_one_active_per_account_key"
  ON "sweet_card_claim_tokens"("account_id")
  WHERE "revoked_at" IS NULL AND "consumed_at" IS NULL;
