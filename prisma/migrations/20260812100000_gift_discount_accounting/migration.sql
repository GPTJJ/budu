-- Count complimentary items as discount instead of removing them from gross sales.
-- Also backfill line-level actual/discount amounts for product reporting.

UPDATE "order_items" AS item
SET
  "actual_amount" = CASE
    WHEN item."is_gift" THEN 0
    ELSE (item."line_amount" * orders."discount_percent" + 50) / 100
  END,
  "discount_amount" = CASE
    WHEN item."is_gift" THEN item."unit_price" * item."quantity"
    ELSE item."line_amount" - ((item."line_amount" * orders."discount_percent" + 50) / 100)
  END
FROM "orders" AS orders
WHERE orders."id" = item."order_id";

WITH gift_orders AS (
  SELECT
    item."order_id",
    SUM(item."unit_price" * item."quantity") AS gross_amount
  FROM "order_items" AS item
  GROUP BY item."order_id"
  HAVING BOOL_OR(item."is_gift")
)
UPDATE "orders" AS orders
SET
  "subtotal" = gift_orders.gross_amount,
  "discount_amount" = gift_orders.gross_amount - orders."payable_amount",
  "updated_at" = NOW(),
  "version" = orders."version" + 1
FROM gift_orders
WHERE orders."id" = gift_orders."order_id";

