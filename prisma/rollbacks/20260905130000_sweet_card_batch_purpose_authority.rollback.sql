DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "sweet_card_batches"
    WHERE "business_purpose" = 'COMMERCIAL'
  ) THEN
    RAISE EXCEPTION 'rollback blocked: commercial Sweet Card batches exist';
  END IF;
END $$;

DROP INDEX "sweet_card_batches_business_purpose_created_at_idx";
ALTER TABLE "sweet_card_batches" DROP COLUMN "business_purpose";
DROP TYPE "SweetCardBatchPurpose";
