-- Financial safety guard: an order may have at most one unresolved refund.
-- The partial unique index releases automatically when a refund completes or fails.
CREATE UNIQUE INDEX "refunds_one_pending_per_order"
  ON "refunds"("order_id")
  WHERE "status" = 'pending';
