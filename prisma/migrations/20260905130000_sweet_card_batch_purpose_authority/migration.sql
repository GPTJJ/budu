-- Batch classification authority only. Existing free-text purpose remains notes.
-- Every pre-authority batch is acceptance/test because no commercial launch was
-- approved before this migration. No account, Ledger, redemption, refund,
-- settlement, Payment, credential, order, or monetary column is changed.
CREATE TYPE "SweetCardBatchPurpose" AS ENUM ('ACCEPTANCE_TEST', 'COMMERCIAL');

ALTER TABLE "sweet_card_batches"
  ADD COLUMN "business_purpose" "SweetCardBatchPurpose";

UPDATE "sweet_card_batches"
SET "business_purpose" = 'ACCEPTANCE_TEST';

ALTER TABLE "sweet_card_batches"
  ALTER COLUMN "business_purpose" SET NOT NULL;

CREATE INDEX "sweet_card_batches_business_purpose_created_at_idx"
  ON "sweet_card_batches"("business_purpose", "created_at");
