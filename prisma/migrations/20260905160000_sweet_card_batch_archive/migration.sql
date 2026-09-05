-- Operational visibility only. NULL keeps every historical batch in its
-- existing active view until an authorized operator explicitly archives it.
-- No card, credential, Ledger, redemption, refund, order, settlement, payment,
-- balance, amount, binding, or lifecycle field is changed.
ALTER TABLE "sweet_card_batches"
  ADD COLUMN "archived_at" TIMESTAMP(3);

CREATE INDEX "sweet_card_batches_archived_at_created_at_idx"
  ON "sweet_card_batches"("archived_at", "created_at");
