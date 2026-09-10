-- CreateTable
CREATE TABLE "sweet_card_online_policies" (
    "account_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_id" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sweet_card_online_policies_pkey" PRIMARY KEY ("account_id")
);

-- CreateTable
CREATE TABLE "online_product_policies" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "external_product_id" TEXT NOT NULL,
    "external_sku_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_id" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "online_product_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "online_checkout_quotes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "request_fingerprint" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "online_checkout_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "online_settlements" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "external_order_id" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "request_fingerprint" TEXT NOT NULL,
    "account_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "merchandise_cents" BIGINT NOT NULL,
    "eligible_merchandise_cents" BIGINT NOT NULL,
    "shipping_cents" BIGINT NOT NULL,
    "total_cents" BIGINT NOT NULL,
    "sweet_card_cents" BIGINT NOT NULL,
    "wechat_cents" BIGINT NOT NULL,
    "captured_ledger_id" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "paid_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "reconciliation_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "online_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sweet_card_reservations" (
    "id" TEXT NOT NULL,
    "settlement_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "captured_at" TIMESTAMP(3),
    "released_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sweet_card_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "online_tenders" (
    "id" TEXT NOT NULL,
    "settlement_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "merchant_trade_no" TEXT,
    "provider_transaction_id" TEXT,
    "prepay_id" TEXT,
    "verified_at" TIMESTAMP(3),
    "provider_success_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "online_tenders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "online_refunds" (
    "id" TEXT NOT NULL,
    "settlement_id" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "request_fingerprint" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "eligible_cents" BIGINT NOT NULL,
    "ineligible_cents" BIGINT NOT NULL,
    "shipping_cents" BIGINT NOT NULL,
    "total_cents" BIGINT NOT NULL,
    "sweet_card_cents" BIGINT NOT NULL,
    "wechat_cents" BIGINT NOT NULL,
    "cumulative_eligible_cents" BIGINT NOT NULL,
    "cumulative_card_cents" BIGINT NOT NULL,
    "items" JSONB NOT NULL,
    "merchant_refund_no" TEXT,
    "provider_refund_id" TEXT,
    "provider_status" TEXT,
    "credited_ledger_id" TEXT,
    "verified_at" TIMESTAMP(3),
    "settled_at" TIMESTAMP(3),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "online_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "online_payment_compensations" (
    "id" TEXT NOT NULL,
    "settlement_id" TEXT NOT NULL,
    "provider_transaction_id" TEXT NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "merchant_refund_no" TEXT NOT NULL,
    "provider_refund_id" TEXT,
    "provider_status" TEXT,
    "verified_at" TIMESTAMP(3),
    "settled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "online_payment_compensations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "online_outbox" (
    "id" TEXT NOT NULL,
    "event_key" TEXT NOT NULL,
    "settlement_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_until" TIMESTAMP(3),
    "lease_owner" TEXT,
    "delivered_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "online_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "online_product_policies_namespace_external_product_id_exter_key" ON "online_product_policies"("namespace", "external_product_id", "external_sku_id");

-- CreateIndex
CREATE INDEX "online_checkout_quotes_expires_at_idx" ON "online_checkout_quotes"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "online_checkout_quotes_user_id_request_key_key" ON "online_checkout_quotes"("user_id", "request_key");

-- CreateIndex
CREATE UNIQUE INDEX "online_settlements_quote_id_key" ON "online_settlements"("quote_id");

-- CreateIndex
CREATE UNIQUE INDEX "online_settlements_captured_ledger_id_key" ON "online_settlements"("captured_ledger_id");

-- CreateIndex
CREATE INDEX "online_settlements_status_expires_at_idx" ON "online_settlements"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "online_settlements_namespace_external_order_id_key" ON "online_settlements"("namespace", "external_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "online_settlements_user_id_request_key_key" ON "online_settlements"("user_id", "request_key");

-- CreateIndex
CREATE UNIQUE INDEX "sweet_card_reservations_settlement_id_key" ON "sweet_card_reservations"("settlement_id");

-- CreateIndex
CREATE UNIQUE INDEX "sweet_card_reservations_request_key_key" ON "sweet_card_reservations"("request_key");

-- CreateIndex
CREATE INDEX "sweet_card_reservations_account_id_status_idx" ON "sweet_card_reservations"("account_id", "status");

-- CreateIndex
CREATE INDEX "sweet_card_reservations_status_expires_at_idx" ON "sweet_card_reservations"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "online_tenders_merchant_trade_no_key" ON "online_tenders"("merchant_trade_no");

-- CreateIndex
CREATE UNIQUE INDEX "online_tenders_provider_transaction_id_key" ON "online_tenders"("provider_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "online_tenders_settlement_id_type_key" ON "online_tenders"("settlement_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "online_refunds_merchant_refund_no_key" ON "online_refunds"("merchant_refund_no");

-- CreateIndex
CREATE UNIQUE INDEX "online_refunds_provider_refund_id_key" ON "online_refunds"("provider_refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "online_refunds_credited_ledger_id_key" ON "online_refunds"("credited_ledger_id");

-- CreateIndex
CREATE INDEX "online_refunds_status_updated_at_idx" ON "online_refunds"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "online_refunds_settlement_id_request_key_key" ON "online_refunds"("settlement_id", "request_key");

-- CreateIndex
CREATE UNIQUE INDEX "online_refunds_settlement_id_sequence_key" ON "online_refunds"("settlement_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "online_payment_compensations_provider_transaction_id_key" ON "online_payment_compensations"("provider_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "online_payment_compensations_merchant_refund_no_key" ON "online_payment_compensations"("merchant_refund_no");

-- CreateIndex
CREATE UNIQUE INDEX "online_payment_compensations_provider_refund_id_key" ON "online_payment_compensations"("provider_refund_id");

-- CreateIndex
CREATE INDEX "online_payment_compensations_status_updated_at_idx" ON "online_payment_compensations"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "online_outbox_event_key_key" ON "online_outbox"("event_key");

-- CreateIndex
CREATE INDEX "online_outbox_delivered_at_available_at_idx" ON "online_outbox"("delivered_at", "available_at");

-- CreateIndex
CREATE UNIQUE INDEX "online_outbox_settlement_id_version_type_key" ON "online_outbox"("settlement_id", "version", "type");

-- AddForeignKey
ALTER TABLE "sweet_card_online_policies" ADD CONSTRAINT "sweet_card_online_policies_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "sweet_card_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_product_policies" ADD CONSTRAINT "online_product_policies_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_checkout_quotes" ADD CONSTRAINT "online_checkout_quotes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_settlements" ADD CONSTRAINT "online_settlements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_settlements" ADD CONSTRAINT "online_settlements_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "online_checkout_quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_settlements" ADD CONSTRAINT "online_settlements_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "sweet_card_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_settlements" ADD CONSTRAINT "online_settlements_captured_ledger_id_fkey" FOREIGN KEY ("captured_ledger_id") REFERENCES "sweet_card_ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sweet_card_reservations" ADD CONSTRAINT "sweet_card_reservations_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "online_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sweet_card_reservations" ADD CONSTRAINT "sweet_card_reservations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "sweet_card_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sweet_card_reservations" ADD CONSTRAINT "sweet_card_reservations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_tenders" ADD CONSTRAINT "online_tenders_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "online_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_refunds" ADD CONSTRAINT "online_refunds_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "online_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_refunds" ADD CONSTRAINT "online_refunds_credited_ledger_id_fkey" FOREIGN KEY ("credited_ledger_id") REFERENCES "sweet_card_ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_payment_compensations" ADD CONSTRAINT "online_payment_compensations_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "online_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_outbox" ADD CONSTRAINT "online_outbox_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "online_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Financial checks are additive. No historical row is rewritten.
ALTER TABLE online_settlements ADD CONSTRAINT online_settlement_amounts CHECK (
  currency = 'CNY' AND total_cents > 0 AND total_cents <= 2000000000
  AND merchandise_cents >= 0 AND shipping_cents >= 0
  AND eligible_merchandise_cents BETWEEN 0 AND merchandise_cents
  AND sweet_card_cents BETWEEN 0 AND eligible_merchandise_cents
  AND wechat_cents >= shipping_cents
  AND total_cents = merchandise_cents + shipping_cents
  AND total_cents = sweet_card_cents + wechat_cents
  AND ((sweet_card_cents > 0) = (account_id IS NOT NULL))
  AND version > 0
);
ALTER TABLE online_settlements ADD CONSTRAINT online_settlement_status CHECK (
  status IN ('PENDING','CLOSING','PAID','CANCELLED','EXPIRED','RECONCILIATION_REQUIRED','PARTIALLY_REFUNDED','REFUNDED')
);
ALTER TABLE sweet_card_reservations ADD CONSTRAINT online_reservation_amount CHECK (amount_cents > 0 AND amount_cents <= 2000000000);
ALTER TABLE sweet_card_reservations ADD CONSTRAINT online_reservation_lifecycle CHECK (
  (status = 'RESERVED' AND captured_at IS NULL AND released_at IS NULL)
  OR (status = 'CAPTURED' AND captured_at IS NOT NULL AND released_at IS NULL)
  OR (status IN ('RELEASED','EXPIRED') AND released_at IS NOT NULL AND captured_at IS NULL)
);
ALTER TABLE online_tenders ADD CONSTRAINT online_tender_amount CHECK (amount_cents > 0 AND amount_cents <= 2000000000);
ALTER TABLE online_tenders ADD CONSTRAINT online_tender_contract CHECK (
  type IN ('SWEET_CARD','WECHAT') AND status IN ('PENDING','SUCCEEDED','CLOSED')
  AND ((type = 'WECHAT' AND merchant_trade_no IS NOT NULL) OR
       (type = 'SWEET_CARD' AND merchant_trade_no IS NULL AND provider_transaction_id IS NULL AND prepay_id IS NULL))
  AND (status <> 'SUCCEEDED' OR (verified_at IS NOT NULL AND (type <> 'WECHAT' OR (provider_transaction_id IS NOT NULL AND provider_success_at IS NOT NULL))))
);
ALTER TABLE online_refunds ADD CONSTRAINT online_refund_amounts CHECK (
  total_cents > 0 AND total_cents <= 2000000000
  AND eligible_cents >= 0 AND ineligible_cents >= 0 AND shipping_cents >= 0
  AND sweet_card_cents >= 0 AND wechat_cents >= shipping_cents
  AND total_cents = eligible_cents + ineligible_cents + shipping_cents
  AND total_cents = sweet_card_cents + wechat_cents
  AND cumulative_eligible_cents >= eligible_cents AND cumulative_card_cents >= sweet_card_cents
  AND sequence > 0 AND status IN ('PENDING','SETTLED')
  AND ((wechat_cents > 0) = (merchant_refund_no IS NOT NULL))
  AND (status <> 'SETTLED' OR (settled_at IS NOT NULL AND
       (wechat_cents = 0 OR (provider_status IS NOT DISTINCT FROM 'SUCCESS' AND verified_at IS NOT NULL AND provider_refund_id IS NOT NULL))))
);
ALTER TABLE online_payment_compensations ADD CONSTRAINT online_compensation_contract CHECK (
  amount_cents > 0 AND amount_cents <= 2000000000 AND status IN ('PENDING','SETTLED')
  AND (status <> 'SETTLED' OR (provider_status IS NOT DISTINCT FROM 'SUCCESS' AND verified_at IS NOT NULL AND settled_at IS NOT NULL AND provider_refund_id IS NOT NULL))
);
ALTER TABLE online_outbox ADD CONSTRAINT online_outbox_contract CHECK (version > 0 AND attempts >= 0);

-- Financial snapshots and references cannot be changed during retry/recovery.
CREATE FUNCTION budu_online_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE field text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ONLINE_FINANCIAL_DELETE_DENIED' USING ERRCODE = '23514'; END IF;
  FOREACH field IN ARRAY TG_ARGV LOOP
    IF to_jsonb(OLD)->field IS DISTINCT FROM to_jsonb(NEW)->field THEN
      RAISE EXCEPTION 'ONLINE_IMMUTABLE_FACT' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER online_quote_immutable BEFORE UPDATE OR DELETE ON online_checkout_quotes
FOR EACH ROW EXECUTE FUNCTION budu_online_immutable('id','user_id','request_key','request_fingerprint','snapshot','expires_at','created_at');
CREATE TRIGGER online_settlement_immutable BEFORE UPDATE OR DELETE ON online_settlements
FOR EACH ROW EXECUTE FUNCTION budu_online_immutable('id','user_id','quote_id','namespace','external_order_id','request_key','request_fingerprint','account_id','currency','merchandise_cents','eligible_merchandise_cents','shipping_cents','total_cents','sweet_card_cents','wechat_cents','expires_at','created_at');
CREATE TRIGGER online_reservation_immutable BEFORE UPDATE OR DELETE ON sweet_card_reservations
FOR EACH ROW EXECUTE FUNCTION budu_online_immutable('id','settlement_id','account_id','user_id','request_key','amount_cents','expires_at','created_at');
CREATE TRIGGER online_tender_immutable BEFORE UPDATE OR DELETE ON online_tenders
FOR EACH ROW EXECUTE FUNCTION budu_online_immutable('id','settlement_id','type','amount_cents','merchant_trade_no','created_at');
CREATE TRIGGER online_refund_immutable BEFORE UPDATE OR DELETE ON online_refunds
FOR EACH ROW EXECUTE FUNCTION budu_online_immutable('id','settlement_id','request_key','request_fingerprint','sequence','eligible_cents','ineligible_cents','shipping_cents','total_cents','sweet_card_cents','wechat_cents','cumulative_eligible_cents','cumulative_card_cents','items','merchant_refund_no','created_by_id','created_at');
CREATE TRIGGER online_compensation_immutable BEFORE UPDATE OR DELETE ON online_payment_compensations
FOR EACH ROW EXECUTE FUNCTION budu_online_immutable('id','settlement_id','provider_transaction_id','amount_cents','reason','merchant_refund_no','created_at');
CREATE TRIGGER online_outbox_immutable BEFORE UPDATE OR DELETE ON online_outbox
FOR EACH ROW EXECUTE FUNCTION budu_online_immutable('id','event_key','settlement_id','version','type','payload','created_at');

-- Scope reconciliation to accounts participating in the new online domain.
CREATE FUNCTION budu_online_account_reconcile(target_account text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual_balance bigint; ledger_balance numeric;
BEGIN
  IF target_account IS NULL OR NOT EXISTS (SELECT 1 FROM online_settlements WHERE account_id = target_account) THEN RETURN; END IF;
  SELECT balance_cents INTO actual_balance FROM sweet_card_accounts WHERE id = target_account;
  SELECT COALESCE(sum(amount_cents),0) INTO ledger_balance FROM sweet_card_ledger WHERE account_id = target_account;
  IF actual_balance IS DISTINCT FROM ledger_balance THEN
    RAISE EXCEPTION 'ONLINE_LEDGER_BALANCE_MISMATCH' USING ERRCODE = '23514';
  END IF;
END $$;

-- Deferred proof joins each online monetary fact to the existing ledger.
CREATE FUNCTION budu_validate_online_settlement(target_id text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s online_settlements%ROWTYPE; r sweet_card_reservations%ROWTYPE;
  l sweet_card_ledger%ROWTYPE; f online_refunds%ROWTYPE; q online_checkout_quotes%ROWTYPE;
  compensation online_payment_compensations%ROWTYPE; wx online_tenders%ROWTYPE;
  settled_refund_sum bigint; card_sum bigint; wx_sum bigint;
  previous_eligible bigint := 0; previous_other bigint := 0; previous_shipping bigint := 0;
  previous_card bigint := 0; previous_wx bigint := 0; expected_card bigint; expected_sequence integer := 1;
BEGIN
  SELECT * INTO s FROM online_settlements WHERE id = target_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO q FROM online_checkout_quotes WHERE id = s.quote_id AND user_id = s.user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ONLINE_QUOTE_OWNER_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF q.snapshot->>'currency' IS DISTINCT FROM s.currency
    OR q.snapshot->>'merchandiseCents' IS DISTINCT FROM s.merchandise_cents::text
    OR q.snapshot->>'eligibleMerchandiseCents' IS DISTINCT FROM s.eligible_merchandise_cents::text
    OR q.snapshot->>'shippingCents' IS DISTINCT FROM s.shipping_cents::text
    OR q.snapshot->>'totalCents' IS DISTINCT FROM s.total_cents::text
    OR q.snapshot->>'sweetCardCents' IS DISTINCT FROM s.sweet_card_cents::text
    OR q.snapshot->>'wechatCents' IS DISTINCT FROM s.wechat_cents::text THEN
    RAISE EXCEPTION 'ONLINE_QUOTE_AMOUNT_MISMATCH' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(amount_cents) FILTER (WHERE type = 'SWEET_CARD'),0),
         COALESCE(sum(amount_cents) FILTER (WHERE type = 'WECHAT'),0)
  INTO card_sum, wx_sum FROM online_tenders WHERE settlement_id = s.id;
  IF card_sum <> s.sweet_card_cents OR wx_sum <> s.wechat_cents THEN
    RAISE EXCEPTION 'ONLINE_TENDER_RECONCILIATION' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO r FROM sweet_card_reservations WHERE settlement_id = s.id;
  IF s.sweet_card_cents > 0 THEN
    IF r.id IS NULL OR r.account_id <> s.account_id OR r.user_id <> s.user_id OR r.amount_cents <> s.sweet_card_cents THEN
      RAISE EXCEPTION 'ONLINE_RESERVATION_MISMATCH' USING ERRCODE = '23514';
    END IF;
    IF (s.status IN ('PENDING','CLOSING') AND r.status <> 'RESERVED')
      OR (s.status IN ('PAID','PARTIALLY_REFUNDED','REFUNDED') AND r.status <> 'CAPTURED')
      OR (s.status IN ('CANCELLED','EXPIRED') AND r.status NOT IN ('RELEASED','EXPIRED'))
      OR (s.status = 'RECONCILIATION_REQUIRED' AND r.status = 'CAPTURED') THEN
      RAISE EXCEPTION 'ONLINE_RESERVATION_STATE_MISMATCH' USING ERRCODE = '23514';
    END IF;
    IF r.status = 'CAPTURED' THEN
      SELECT * INTO l FROM sweet_card_ledger WHERE id = s.captured_ledger_id;
      IF l.id IS NULL OR l.account_id <> s.account_id OR l.type <> 'REDEEM' OR l.amount_cents <> -s.sweet_card_cents
         OR l.order_id IS NOT NULL OR l.redemption_id IS NOT NULL OR l.refund_id IS NOT NULL THEN
        RAISE EXCEPTION 'ONLINE_CAPTURE_LEDGER_MISMATCH' USING ERRCODE = '23514';
      END IF;
    ELSIF s.captured_ledger_id IS NOT NULL THEN
      RAISE EXCEPTION 'ONLINE_UNCAPTURED_LEDGER' USING ERRCODE = '23514';
    END IF;
  ELSIF r.id IS NOT NULL OR s.captured_ledger_id IS NOT NULL THEN
    RAISE EXCEPTION 'ONLINE_WX_ONLY_HAS_RESERVATION' USING ERRCODE = '23514';
  END IF;
  IF s.status IN ('PAID','PARTIALLY_REFUNDED','REFUNDED') THEN
    IF s.paid_at IS NULL OR EXISTS (SELECT 1 FROM online_tenders WHERE settlement_id = s.id AND status <> 'SUCCEEDED') THEN
      RAISE EXCEPTION 'ONLINE_UNVERIFIED_PAID_STATE' USING ERRCODE = '23514';
    END IF;
  END IF;
  FOR f IN SELECT * FROM online_refunds WHERE settlement_id = s.id ORDER BY sequence LOOP
    IF s.status NOT IN ('PAID','PARTIALLY_REFUNDED','REFUNDED') THEN
      RAISE EXCEPTION 'ONLINE_REFUND_BEFORE_PAID' USING ERRCODE = '23514';
    END IF;
    previous_eligible := previous_eligible + f.eligible_cents;
    previous_other := previous_other + f.ineligible_cents;
    previous_shipping := previous_shipping + f.shipping_cents;
    previous_card := previous_card + f.sweet_card_cents;
    previous_wx := previous_wx + f.wechat_cents;
    expected_card := CASE WHEN s.eligible_merchandise_cents = 0 THEN 0
      ELSE floor(previous_eligible::numeric * s.sweet_card_cents / s.eligible_merchandise_cents)::bigint END;
    IF f.sequence <> expected_sequence OR previous_eligible > s.eligible_merchandise_cents
      OR previous_other > s.merchandise_cents - s.eligible_merchandise_cents OR previous_shipping > s.shipping_cents
      OR previous_card <> expected_card OR previous_wx > s.wechat_cents
      OR f.cumulative_eligible_cents <> previous_eligible OR f.cumulative_card_cents <> previous_card THEN
      RAISE EXCEPTION 'ONLINE_REFUND_ALLOCATION_MISMATCH' USING ERRCODE = '23514';
    END IF;
    expected_sequence := expected_sequence + 1;
    IF f.status = 'SETTLED' AND f.sweet_card_cents > 0 THEN
      SELECT * INTO l FROM sweet_card_ledger WHERE id = f.credited_ledger_id;
      IF l.id IS NULL OR l.account_id <> s.account_id OR l.type <> 'REFUND' OR l.amount_cents <> f.sweet_card_cents
        OR l.order_id IS NOT NULL OR l.redemption_id IS NOT NULL OR l.refund_id IS NOT NULL THEN
        RAISE EXCEPTION 'ONLINE_REFUND_LEDGER_MISMATCH' USING ERRCODE = '23514';
      END IF;
    ELSIF f.credited_ledger_id IS NOT NULL THEN
      RAISE EXCEPTION 'ONLINE_PREMATURE_REFUND_CREDIT' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  PERFORM budu_online_account_reconcile(s.account_id);
  SELECT * INTO wx FROM online_tenders WHERE settlement_id = s.id AND type = 'WECHAT';
  FOR compensation IN SELECT * FROM online_payment_compensations WHERE settlement_id = s.id LOOP
    IF wx.id IS NULL OR wx.status <> 'SUCCEEDED' OR wx.verified_at IS NULL
      OR compensation.provider_transaction_id IS DISTINCT FROM wx.provider_transaction_id
      OR compensation.amount_cents <> wx.amount_cents
      OR s.status NOT IN ('RECONCILIATION_REQUIRED','CANCELLED','EXPIRED')
      OR s.captured_ledger_id IS NOT NULL
      OR (r.id IS NOT NULL AND r.status NOT IN ('RELEASED','EXPIRED'))
      OR (s.status IN ('CANCELLED','EXPIRED') AND compensation.status <> 'SETTLED') THEN
      RAISE EXCEPTION 'ONLINE_COMPENSATION_MISMATCH' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF wx.status = 'SUCCEEDED' AND s.status IN ('RECONCILIATION_REQUIRED','CANCELLED','EXPIRED')
    AND NOT EXISTS (SELECT 1 FROM online_payment_compensations WHERE settlement_id = s.id) THEN
    RAISE EXCEPTION 'ONLINE_RECEIVED_PAYMENT_WITHOUT_COMPENSATION' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(total_cents),0) INTO settled_refund_sum
    FROM online_refunds WHERE settlement_id = s.id AND status = 'SETTLED';
  IF (s.status = 'REFUNDED' AND settled_refund_sum <> s.total_cents)
    OR (s.status = 'PARTIALLY_REFUNDED' AND (settled_refund_sum <= 0 OR settled_refund_sum >= s.total_cents))
    OR (s.status = 'PAID' AND settled_refund_sum <> 0) THEN
    RAISE EXCEPTION 'ONLINE_REFUND_STATE_MISMATCH' USING ERRCODE = '23514';
  END IF;
END $$;
CREATE FUNCTION budu_online_contract_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'online_settlements' THEN
    PERFORM budu_validate_online_settlement(NEW.id);
  ELSE
    PERFORM budu_validate_online_settlement(NEW.settlement_id);
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER online_settlement_contract AFTER INSERT OR UPDATE ON online_settlements
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION budu_online_contract_trigger();
CREATE CONSTRAINT TRIGGER online_reservation_contract AFTER INSERT OR UPDATE ON sweet_card_reservations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION budu_online_contract_trigger();
CREATE CONSTRAINT TRIGGER online_tender_contract_deferred AFTER INSERT OR UPDATE ON online_tenders
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION budu_online_contract_trigger();
CREATE CONSTRAINT TRIGGER online_refund_contract AFTER INSERT OR UPDATE ON online_refunds
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION budu_online_contract_trigger();

CREATE CONSTRAINT TRIGGER online_compensation_contract_deferred AFTER INSERT OR UPDATE ON online_payment_compensations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION budu_online_contract_trigger();

CREATE FUNCTION budu_online_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE permitted boolean := false; field text;
BEGIN
  FOREACH field IN ARRAY TG_ARGV LOOP
    IF to_jsonb(OLD)->field <> 'null'::jsonb AND to_jsonb(OLD)->field IS DISTINCT FROM to_jsonb(NEW)->field THEN
      RAISE EXCEPTION 'ONLINE_VERIFIED_FACT_REWRITE_DENIED' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF TG_TABLE_NAME = 'online_settlements' THEN
    IF NEW.version < OLD.version OR NEW.version > OLD.version + 1
      OR (NEW.status <> OLD.status AND NEW.version <> OLD.version + 1) THEN
      RAISE EXCEPTION 'ONLINE_VERSION_TRANSITION_DENIED' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'online_settlements' THEN
    permitted := (OLD.status = 'PENDING' AND NEW.status IN ('CLOSING','PAID','RECONCILIATION_REQUIRED'))
      OR (OLD.status = 'CLOSING' AND NEW.status IN ('PAID','CANCELLED','EXPIRED','RECONCILIATION_REQUIRED'))
      OR (OLD.status IN ('CANCELLED','EXPIRED') AND NEW.status = 'RECONCILIATION_REQUIRED')
      OR (OLD.status = 'RECONCILIATION_REQUIRED' AND NEW.status IN ('CANCELLED','EXPIRED'))
      OR (OLD.status = 'PAID' AND NEW.status IN ('PARTIALLY_REFUNDED','REFUNDED'))
      OR (OLD.status = 'PARTIALLY_REFUNDED' AND NEW.status = 'REFUNDED');
  ELSIF TG_TABLE_NAME = 'sweet_card_reservations' THEN
    permitted := OLD.status = 'RESERVED' AND NEW.status IN ('CAPTURED','RELEASED','EXPIRED');
  ELSIF TG_TABLE_NAME = 'online_tenders' THEN
    permitted := (OLD.status = 'PENDING' AND NEW.status IN ('SUCCEEDED','CLOSED'))
      OR (OLD.status = 'CLOSED' AND NEW.status = 'SUCCEEDED');
  ELSE
    permitted := OLD.status = 'PENDING' AND NEW.status = 'SETTLED';
  END IF;
  IF NOT permitted THEN RAISE EXCEPTION 'ONLINE_STATE_TRANSITION_DENIED' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER online_settlement_transition BEFORE UPDATE ON online_settlements
FOR EACH ROW EXECUTE FUNCTION budu_online_transition_guard('captured_ledger_id','paid_at','cancelled_at');
CREATE TRIGGER online_reservation_transition BEFORE UPDATE ON sweet_card_reservations
FOR EACH ROW EXECUTE FUNCTION budu_online_transition_guard('captured_at','released_at');
CREATE TRIGGER online_tender_transition BEFORE UPDATE ON online_tenders
FOR EACH ROW EXECUTE FUNCTION budu_online_transition_guard('provider_transaction_id','verified_at','provider_success_at');
CREATE TRIGGER online_refund_transition BEFORE UPDATE ON online_refunds
FOR EACH ROW EXECUTE FUNCTION budu_online_transition_guard('provider_refund_id','credited_ledger_id','verified_at','settled_at');
CREATE TRIGGER online_compensation_transition BEFORE UPDATE ON online_payment_compensations
FOR EACH ROW EXECUTE FUNCTION budu_online_transition_guard('provider_refund_id','verified_at','settled_at');

-- Locks share the existing POS account lock namespace. No expiry-based discount.
CREATE FUNCTION budu_online_reservation_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.account_id, 0));
  RETURN NEW;
END $$;
CREATE TRIGGER online_reservation_account_lock BEFORE INSERT OR UPDATE ON sweet_card_reservations
FOR EACH ROW EXECUTE FUNCTION budu_online_reservation_lock();

CREATE FUNCTION budu_online_available_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_account text; balance bigint; held bigint;
BEGIN
  IF TG_TABLE_NAME = 'sweet_card_accounts' THEN target_account := NEW.id;
  ELSE target_account := NEW.account_id; END IF;
  SELECT balance_cents INTO balance FROM sweet_card_accounts WHERE id = target_account;
  SELECT COALESCE(sum(amount_cents),0) INTO held FROM sweet_card_reservations WHERE account_id = target_account AND status = 'RESERVED';
  PERFORM budu_online_account_reconcile(target_account);
  IF held > balance THEN RAISE EXCEPTION 'ONLINE_RESERVED_BALANCE_EXCEEDED' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER online_hold_capacity AFTER INSERT OR UPDATE ON sweet_card_reservations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION budu_online_available_check();
CREATE CONSTRAINT TRIGGER online_balance_capacity AFTER UPDATE ON sweet_card_accounts
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION budu_online_available_check();

-- Protect only ledger entries referenced by new online facts; existing POS
-- runtime never updates these rows and its historical ledger is not rewritten.
CREATE FUNCTION budu_online_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM online_settlements WHERE captured_ledger_id = OLD.id)
     OR EXISTS (SELECT 1 FROM online_refunds WHERE credited_ledger_id = OLD.id) THEN
    RAISE EXCEPTION 'ONLINE_LEDGER_REWRITE_DENIED' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER online_ledger_immutable BEFORE UPDATE OR DELETE ON sweet_card_ledger
FOR EACH ROW EXECUTE FUNCTION budu_online_ledger_immutable();

CREATE FUNCTION budu_online_ledger_reconcile_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN PERFORM budu_online_account_reconcile(OLD.account_id); END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN PERFORM budu_online_account_reconcile(NEW.account_id); END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER online_ledger_balance_contract AFTER INSERT OR UPDATE OR DELETE ON sweet_card_ledger
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION budu_online_ledger_reconcile_trigger();
