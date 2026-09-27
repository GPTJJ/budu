\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE p7b_results (
  case_id TEXT PRIMARY KEY,
  outcome TEXT NOT NULL,
  detail TEXT NOT NULL
) ON COMMIT DROP;

CREATE FUNCTION pg_temp.record_pass(case_id TEXT, detail TEXT) RETURNS VOID
LANGUAGE sql AS $$
  INSERT INTO p7b_results VALUES (case_id, 'PASS', detail);
$$;

INSERT INTO "Store" ("key", "name") VALUES ('p7b-store', 'P7B isolated store');
INSERT INTO "InventoryItem" ("id", "name", "salePriceCents", "isActive")
VALUES ('p7b-product', 'P7B isolated product', 100, true);

CREATE FUNCTION pg_temp.make_order(case_id TEXT, payable BIGINT, authority "SettlementAuthority" DEFAULT 'PAYMENT')
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO orders (
    id, order_no, store_id, cashier_id, subtotal, payable_amount,
    status, payment_status, checkout_key, cart_hash,
    order_source, entry_mode, settlement_authority
  ) VALUES (
    case_id, 'NO-' || case_id, 'p7b-store', 'p7b-cashier', payable, payable,
    'pending_payment', 'unpaid', 'checkout-' || case_id, 'hash-' || case_id,
    CASE WHEN authority = 'PAYMENT' THEN 'STORE_POS'::"OrderSource" ELSE 'OTHER'::"OrderSource" END,
    CASE WHEN authority = 'PAYMENT' THEN 'POS_CHECKOUT'::"EntryMode" ELSE 'MANUAL_POS'::"EntryMode" END,
    authority
  );
  INSERT INTO order_items (
    id, order_id, product_id, product_name_snapshot, sku_snapshot,
    unit_price, cost_price_snapshot, quantity, line_amount, actual_amount
  ) VALUES (
    'oi-' || case_id, case_id, 'p7b-product', 'P7B product', 'P7B-SKU',
    payable, 0, 1, payable, payable
  );
END;
$$;

CREATE FUNCTION pg_temp.add_payment(case_id TEXT, amount BIGINT, payment_status TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO payments (
    id, payment_no, order_id, channel, amount, status,
    merchant_trade_no, provider, request_key
  ) VALUES (
    'pay-' || case_id, 'PN-' || case_id, case_id, 'cash', amount, payment_status,
    'MT-' || case_id, 'cash', 'payment-request-' || case_id
  );
END;
$$;

CREATE FUNCTION pg_temp.add_external(case_id TEXT, amount BIGINT, settlement_status "ExternalSettlementStatus" DEFAULT 'CONFIRMED')
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO external_settlements (
    id, settlement_no, order_id, settlement_type, amount_cents,
    status, request_key, recorded_by, confirmed_by, confirmed_at
  ) VALUES (
    'ext-' || case_id, 'EN-' || case_id, case_id, 'CUSTOM', amount,
    settlement_status, 'external-request-' || case_id, 'p7b',
    CASE WHEN settlement_status IN ('CONFIRMED', 'PARTIALLY_REFUNDED', 'REFUNDED') THEN 'p7b' ELSE '' END,
    CASE WHEN settlement_status IN ('CONFIRMED', 'PARTIALLY_REFUNDED', 'REFUNDED') THEN clock_timestamp() ELSE NULL END
  );
END;
$$;

CREATE FUNCTION pg_temp.add_sweet_card(case_id TEXT, amount BIGINT, eligible BOOLEAN DEFAULT true)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  initial_amount BIGINT := GREATEST(amount, 100);
BEGIN
  INSERT INTO sweet_card_accounts (
    id, public_card_no, initial_amount_cents, balance_cents,
    validity_type, status, carrier_type, binding_mode
  ) VALUES (
    'sca-' || case_id, 'CARD-' || case_id, initial_amount, initial_amount - amount,
    'ONE_YEAR', 'ACTIVE', 'ELECTRONIC', 'NONE'
  );
  INSERT INTO sweet_card_credentials (
    id, account_id, public_token_id, token_hash, token_ciphertext,
    token_iv, token_tag, status, carrier_type
  ) VALUES (
    'scc-' || case_id, 'sca-' || case_id, 'TOKEN-' || case_id,
    'HASH-' || case_id, 'CIPHER-' || case_id, 'IV-' || case_id, 'TAG-' || case_id,
    'ACTIVE', 'ELECTRONIC'
  );
  INSERT INTO sweet_card_redemptions (
    id, redemption_no, order_id, account_id, credential_id,
    amount_cents, eligible_subtotal_cents, ineligible_subtotal_cents,
    request_key, store_id_snapshot, redeemed_by_id
  ) VALUES (
    'scr-' || case_id, 'RN-' || case_id, case_id, 'sca-' || case_id, 'scc-' || case_id,
    amount, (SELECT payable_amount FROM orders WHERE id = case_id), 0,
    'redemption-request-' || case_id, 'p7b-store', 'p7b-principal'
  );
  UPDATE order_items SET
    sweet_card_eligible_snapshot = eligible,
    sweet_card_redeemed_amount = amount
  WHERE id = 'oi-' || case_id;
  INSERT INTO sweet_card_redemption_items (
    id, redemption_id, order_item_id, product_id,
    eligible_snapshot, eligible_amount_cents, redeemed_amount_cents
  ) VALUES (
    'sri-' || case_id, 'scr-' || case_id, 'oi-' || case_id, 'p7b-product',
    eligible, (SELECT payable_amount FROM orders WHERE id = case_id), amount
  );
  INSERT INTO sweet_card_ledger (
    id, account_id, type, amount_cents, balance_after_cents,
    order_id, redemption_id, request_key
  ) VALUES (
    'scl-redeem-' || case_id, 'sca-' || case_id, 'REDEEM', -amount, initial_amount - amount,
    case_id, 'scr-' || case_id, 'ledger-redeem-' || case_id
  );
  UPDATE orders SET sweet_card_amount = amount WHERE id = case_id;
END;
$$;

CREATE FUNCTION pg_temp.settle_order(case_id TEXT) RETURNS VOID LANGUAGE sql AS $$
  UPDATE orders
  SET status = 'completed', payment_status = 'paid', completed_at = clock_timestamp()
  WHERE id = case_id;
$$;

-- E1: Payment-only exact coverage.
SELECT pg_temp.make_order('e01', 100);
SELECT pg_temp.add_payment('e01', 100, 'success');
SELECT pg_temp.settle_order('e01');
SELECT pg_temp.record_pass('E01', 'Payment-only exact coverage allowed');

-- E2: missing Payment proof is denied.
SELECT pg_temp.make_order('e02', 100);
DO $$ BEGIN
  BEGIN
    PERFORM pg_temp.settle_order('e02');
    RAISE EXCEPTION 'expected denial was not raised';
  EXCEPTION WHEN check_violation THEN
    PERFORM pg_temp.record_pass('E02', 'Payment missing denied');
  END;
END $$;

-- E3: pure Sweet Card exact coverage, with no Payment row.
SELECT pg_temp.make_order('e03', 100);
SELECT pg_temp.add_sweet_card('e03', 100, true);
SELECT pg_temp.settle_order('e03');
DO $$ BEGIN
  IF (SELECT COUNT(*) FROM payments WHERE order_id = 'e03') <> 0 THEN
    RAISE EXCEPTION 'pure Sweet Card created a Payment row';
  END IF;
  PERFORM pg_temp.record_pass('E03', 'Pure Sweet Card exact coverage allowed; Payment count zero');
END $$;

-- E4: a requested but rolled-back redemption leaves no proof and cannot settle.
SELECT pg_temp.make_order('e04', 100);
DO $$ BEGIN
  BEGIN
    INSERT INTO sweet_card_accounts (id, public_card_no, initial_amount_cents, balance_cents, validity_type, status, carrier_type, binding_mode)
    VALUES ('sca-e04', 'CARD-e04', 100, 100, 'ONE_YEAR', 'ACTIVE', 'ELECTRONIC', 'NONE');
    RAISE EXCEPTION USING ERRCODE = 'P7R04', MESSAGE = 'forced redemption rollback';
  EXCEPTION WHEN SQLSTATE 'P7R04' THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM sweet_card_accounts WHERE id = 'sca-e04') THEN
    RAISE EXCEPTION 'redemption rollback leaked a row';
  END IF;
  BEGIN
    PERFORM pg_temp.settle_order('e04');
    RAISE EXCEPTION 'expected denial was not raised';
  EXCEPTION WHEN check_violation THEN
    PERFORM pg_temp.record_pass('E04', 'Rolled-back Sweet Card proof denied');
  END;
END $$;

-- E5: Sweet Card + Payment undercoverage is denied.
SELECT pg_temp.make_order('e05', 100);
SELECT pg_temp.add_sweet_card('e05', 30, true);
SELECT pg_temp.add_payment('e05', 69, 'pending');
DO $$ BEGIN
  BEGIN
    PERFORM pg_temp.settle_order('e05');
    RAISE EXCEPTION 'expected denial was not raised';
  EXCEPTION WHEN check_violation THEN
    PERFORM pg_temp.record_pass('E05', 'Mixed undercoverage denied');
  END;
END $$;

-- E6: exact mixed settlement is allowed.
SELECT pg_temp.make_order('e06', 100);
SELECT pg_temp.add_sweet_card('e06', 30, true);
SELECT pg_temp.add_payment('e06', 70, 'success');
SELECT pg_temp.settle_order('e06');
SELECT pg_temp.record_pass('E06', 'Exact mixed 30 Sweet Card + 70 Payment allowed');

-- E7: mixed underpayment is denied at Payment terminal transition.
SELECT pg_temp.make_order('e07', 100);
SELECT pg_temp.add_sweet_card('e07', 30, true);
SELECT pg_temp.add_payment('e07', 69, 'pending');
DO $$ BEGIN
  BEGIN
    UPDATE payments SET status = 'success' WHERE id = 'pay-e07';
    RAISE EXCEPTION 'expected denial was not raised';
  EXCEPTION WHEN check_violation THEN
    PERFORM pg_temp.record_pass('E07', 'Payment remainder underpayment denied');
  END;
END $$;

-- E8: mixed overcoverage is denied.
SELECT pg_temp.make_order('e08', 100);
SELECT pg_temp.add_sweet_card('e08', 30, true);
SELECT pg_temp.add_payment('e08', 71, 'pending');
DO $$ BEGIN
  BEGIN
    UPDATE payments SET status = 'success' WHERE id = 'pay-e08';
    RAISE EXCEPTION 'expected denial was not raised';
  EXCEPTION WHEN check_violation THEN
    PERFORM pg_temp.record_pass('E08', 'Mixed overcoverage denied');
  END;
END $$;

-- E9: failed/pending Payment is not settlement proof.
SELECT pg_temp.make_order('e09', 100);
SELECT pg_temp.add_payment('e09', 100, 'failed');
DO $$ BEGIN
  BEGIN
    PERFORM pg_temp.settle_order('e09');
    RAISE EXCEPTION 'expected denial was not raised';
  EXCEPTION WHEN check_violation THEN
    PERFORM pg_temp.record_pass('E09', 'Failed Payment denied as settlement proof');
  END;
END $$;

-- E10: ineligible Sweet Card allocation is denied.
SELECT pg_temp.make_order('e10', 100);
SELECT pg_temp.add_sweet_card('e10', 30, false);
SELECT pg_temp.add_payment('e10', 70, 'pending');
DO $$ BEGIN
  BEGIN
    UPDATE payments SET status = 'success' WHERE id = 'pay-e10';
    RAISE EXCEPTION 'expected denial was not raised';
  EXCEPTION WHEN check_violation THEN
    PERFORM pg_temp.record_pass('E10', 'Ineligible Sweet Card allocation denied');
  END;
END $$;

-- E11: duplicate Redemption cannot double count.
SELECT pg_temp.make_order('e11', 100);
SELECT pg_temp.add_sweet_card('e11', 30, true);
DO $$ BEGIN
  BEGIN
    INSERT INTO sweet_card_redemptions (
      id, redemption_no, order_id, account_id, credential_id, amount_cents,
      eligible_subtotal_cents, ineligible_subtotal_cents, request_key,
      store_id_snapshot, redeemed_by_id
    ) VALUES (
      'scr-e11-duplicate', 'RN-e11-duplicate', 'e11', 'sca-e11', 'scc-e11', 30,
      100, 0, 'redemption-request-e11-duplicate', 'p7b-store', 'p7b-principal'
    );
    RAISE EXCEPTION 'expected denial was not raised';
  EXCEPTION WHEN unique_violation THEN
    PERFORM pg_temp.record_pass('E11', 'Duplicate Redemption rejected by stable order identity');
  END;
END $$;

-- E12: legacy Payment behavior remains exact, including a failed historical attempt.
SELECT pg_temp.make_order('e12', 100);
SELECT pg_temp.add_payment('e12', 100, 'failed');
INSERT INTO payments (id, payment_no, order_id, channel, amount, status, merchant_trade_no, provider, request_key)
VALUES ('pay-e12-success', 'PN-e12-success', 'e12', 'wechat', 100, 'success', 'MT-e12-success', 'wechat_pay', 'payment-request-e12-success');
SELECT pg_temp.settle_order('e12');
SELECT pg_temp.record_pass('E12', 'Legacy exact Payment order behavior unchanged');

-- Refund fixtures and C1/C9: a legacy Payment-backed pending refund remains valid.
SELECT pg_temp.make_order('c-pay', 100);
SELECT pg_temp.add_payment('c-pay', 100, 'success');
SELECT pg_temp.settle_order('c-pay');
DO $$ BEGIN
  BEGIN
    INSERT INTO refunds (id, refund_no, order_id, payment_id, refund_amount, status, request_key, requested_by, approved_by)
    VALUES ('ref-c01', 'RF-c01', 'c-pay', 'pay-c-pay', 10, 'pending', 'refund-request-c01', 'p7b', 'p7b');
    INSERT INTO refund_items (id, refund_id, order_item_id, quantity, amount_cents)
    VALUES ('ri-c01', 'ref-c01', 'oi-c-pay', 1, 10);
    RAISE EXCEPTION USING ERRCODE = 'P7C01', MESSAGE = 'rollback accepted row';
  EXCEPTION WHEN SQLSTATE 'P7C01' THEN
    PERFORM pg_temp.record_pass('C01', 'Payment-backed refund row shape allowed');
    PERFORM pg_temp.record_pass('C09', 'Legacy Payment refund row remains valid');
  END;
END $$;

-- C2: PAYMENT refund without any source or Sweet Card discriminator is denied.
DO $$ BEGIN
  BEGIN
    INSERT INTO refunds (id, refund_no, order_id, refund_amount, status, request_key, requested_by, approved_by)
    VALUES ('ref-c02', 'RF-c02', 'c-pay', 10, 'pending', 'refund-request-c02', 'p7b', 'p7b');
    RAISE EXCEPTION 'expected denial was not raised';
  EXCEPTION WHEN check_violation THEN
    PERFORM pg_temp.record_pass('C02', 'Source-free non-Sweet Card PAYMENT refund denied');
  END;
END $$;

-- External fixture.
SELECT pg_temp.make_order('c-ext', 100, 'EXTERNAL');
SELECT pg_temp.add_external('c-ext', 100, 'CONFIRMED');
SELECT pg_temp.settle_order('c-ext');

-- C3: PAYMENT mode with only ExternalSettlement source is denied.
DO $$ BEGIN
  BEGIN
    INSERT INTO refunds (id, refund_no, order_id, external_settlement_id, refund_mode, refund_amount, status, request_key, requested_by, approved_by)
    VALUES ('ref-c03', 'RF-c03', 'c-ext', 'ext-c-ext', 'PAYMENT', 10, 'pending', 'refund-request-c03', 'p7b', 'p7b');
    RAISE EXCEPTION 'expected denial was not raised';
  EXCEPTION WHEN check_violation THEN
    PERFORM pg_temp.record_pass('C03', 'PAYMENT mode with ExternalSettlement-only source denied');
  END;
END $$;

-- C4: correct Manual External row shape remains valid.
DO $$ BEGIN
  BEGIN
    INSERT INTO refunds (
      id, refund_no, order_id, external_settlement_id, refund_mode, refund_amount,
      status, request_key, requested_by, approved_by, completed_at,
      external_completed_at, external_refund_reference
    ) VALUES (
      'ref-c04', 'RF-c04', 'c-ext', 'ext-c-ext', 'MANUAL_EXTERNAL', 10,
      'completed', 'refund-request-c04', 'p7b', 'p7b', clock_timestamp(),
      clock_timestamp(), 'manual-proof-c04'
    );
    RAISE EXCEPTION USING ERRCODE = 'P7C04', MESSAGE = 'rollback accepted row';
  EXCEPTION WHEN SQLSTATE 'P7C04' THEN
    PERFORM pg_temp.record_pass('C04', 'Manual External refund row shape allowed');
  END;
END $$;

-- C5: Manual External mode with Payment-only source is denied.
DO $$ BEGIN
  BEGIN
    INSERT INTO refunds (
      id, refund_no, order_id, payment_id, refund_mode, refund_amount,
      status, request_key, requested_by, approved_by, completed_at, external_completed_at
    ) VALUES (
      'ref-c05', 'RF-c05', 'c-pay', 'pay-c-pay', 'MANUAL_EXTERNAL', 10,
      'completed', 'refund-request-c05', 'p7b', 'p7b', clock_timestamp(), clock_timestamp()
    );
    RAISE EXCEPTION 'expected denial was not raised';
  EXCEPTION WHEN check_violation THEN
    PERFORM pg_temp.record_pass('C05', 'Manual External mode with Payment-only source denied');
  END;
END $$;

-- Pure Sweet Card fixture.
SELECT pg_temp.make_order('c-sc', 100);
SELECT pg_temp.add_sweet_card('c-sc', 100, true);
SELECT pg_temp.settle_order('c-sc');

-- C6: explicit existing rail split is the row-local pure Sweet Card discriminator.
DO $$ BEGIN
  BEGIN
    INSERT INTO refunds (
      id, refund_no, order_id, refund_mode, refund_amount,
      provider_refund_amount, sweet_card_refund_amount,
      status, request_key, requested_by, approved_by
    ) VALUES (
      'ref-c06', 'RF-c06', 'c-sc', 'PAYMENT', 10, 0, 10,
      'pending', 'refund-request-c06', 'p7b', 'p7b'
    );
    RAISE EXCEPTION USING ERRCODE = 'P7C06', MESSAGE = 'rollback accepted row';
  EXCEPTION WHEN SQLSTATE 'P7C06' THEN
    PERFORM pg_temp.record_pass('C06', 'Pure Sweet Card explicit row-local rail discriminator allowed');
  END;
END $$;

-- C7: a source-free row without that discriminator remains denied.
DO $$ BEGIN
  BEGIN
    INSERT INTO refunds (id, refund_no, order_id, refund_mode, refund_amount, status, request_key, requested_by, approved_by)
    VALUES ('ref-c07', 'RF-c07', 'c-sc', 'PAYMENT', 10, 'pending', 'refund-request-c07', 'p7b', 'p7b');
    RAISE EXCEPTION 'expected denial was not raised';
  EXCEPTION WHEN check_violation THEN
    PERFORM pg_temp.record_pass('C07', 'Malformed source-free row denied');
  END;
END $$;

-- C8: Payment + Sweet Card is allowed only for the frozen mixed-settlement contract.
SELECT pg_temp.make_order('c-mixed', 100);
SELECT pg_temp.add_sweet_card('c-mixed', 30, true);
SELECT pg_temp.add_payment('c-mixed', 70, 'success');
SELECT pg_temp.settle_order('c-mixed');
DO $$ BEGIN
  BEGIN
    INSERT INTO refunds (
      id, refund_no, order_id, payment_id, refund_mode, refund_amount,
      provider_refund_amount, sweet_card_refund_amount,
      status, request_key, requested_by, approved_by
    ) VALUES (
      'ref-c08', 'RF-c08', 'c-mixed', 'pay-c-mixed', 'PAYMENT', 20, 14, 6,
      'pending', 'refund-request-c08', 'p7b', 'p7b'
    );
    RAISE EXCEPTION USING ERRCODE = 'P7C08', MESSAGE = 'rollback accepted row';
  EXCEPTION WHEN SQLSTATE 'P7C08' THEN
    PERFORM pg_temp.record_pass('C08', 'Payment source plus Sweet Card split allowed only as valid mixed refund');
  END;
END $$;

-- C10: enum authority rejects unknown/malformed modes.
DO $$ BEGIN
  BEGIN
    EXECUTE $q$INSERT INTO refunds (id, refund_no, order_id, refund_mode, refund_amount, status, request_key)
      VALUES ('ref-c10', 'RF-c10', 'c-pay', 'UNKNOWN', 10, 'pending', 'refund-request-c10')$q$;
    RAISE EXCEPTION 'expected denial was not raised';
  EXCEPTION WHEN invalid_text_representation THEN
    PERFORM pg_temp.record_pass('C10', 'Unknown refund mode denied');
  END;
END $$;

-- E13: pure Sweet Card full refund produces one fact, allocation and credit.
SELECT pg_temp.make_order('e13', 100);
SELECT pg_temp.add_sweet_card('e13', 100, true);
SELECT pg_temp.settle_order('e13');
INSERT INTO refunds (
  id, refund_no, order_id, refund_mode, refund_amount,
  provider_refund_amount, sweet_card_refund_amount,
  status, request_key, requested_by, approved_by
) VALUES (
  'ref-e13', 'RF-e13', 'e13', 'PAYMENT', 100, 0, 100,
  'pending', 'refund-request-e13', 'p7b', 'p7b'
);
INSERT INTO refund_items (id, refund_id, order_item_id, quantity, amount_cents)
VALUES ('ri-e13', 'ref-e13', 'oi-e13', 1, 100);
INSERT INTO sweet_card_refunds (id, refund_id, redemption_id, account_id, amount_cents, request_key)
VALUES ('scf-e13', 'ref-e13', 'scr-e13', 'sca-e13', 100, 'sweet-refund-e13');
INSERT INTO sweet_card_refund_items (id, sweet_card_refund_id, refund_item_id, redemption_item_id, amount_cents)
VALUES ('scfi-e13', 'scf-e13', 'ri-e13', 'sri-e13', 100);
UPDATE refunds SET status = 'completed', completed_at = clock_timestamp() WHERE id = 'ref-e13';
INSERT INTO sweet_card_ledger (
  id, account_id, type, amount_cents, balance_after_cents,
  order_id, refund_id, request_key
) VALUES (
  'scl-refund-e13', 'sca-e13', 'REFUND', 100, 100,
  'e13', 'ref-e13', 'ledger-refund-e13'
);
UPDATE sweet_card_accounts SET balance_cents = 100 WHERE id = 'sca-e13';
UPDATE orders SET status = 'refunded', payment_status = 'refunded' WHERE id = 'e13';
SELECT budu_validate_refund_contract('ref-e13');
SELECT pg_temp.record_pass('E13', 'Pure Sweet Card full refund allowed with exact rail facts');

-- E14: Sweet Card over-refund is denied before reservation.
SELECT pg_temp.make_order('e14', 100);
SELECT pg_temp.add_sweet_card('e14', 100, true);
SELECT pg_temp.settle_order('e14');
DO $$ BEGIN
  BEGIN
    INSERT INTO refunds (
      id, refund_no, order_id, refund_mode, refund_amount,
      provider_refund_amount, sweet_card_refund_amount,
      status, request_key, requested_by, approved_by
    ) VALUES (
      'ref-e14', 'RF-e14', 'e14', 'PAYMENT', 101, 0, 101,
      'pending', 'refund-request-e14', 'p7b', 'p7b'
    );
    RAISE EXCEPTION 'expected denial was not raised';
  EXCEPTION WHEN check_violation THEN
    PERFORM pg_temp.record_pass('E14', 'Sweet Card over-refund denied');
  END;
END $$;

-- E15: mixed rails cannot refund beyond either original settlement.
SELECT pg_temp.make_order('e15', 100);
SELECT pg_temp.add_sweet_card('e15', 30, true);
SELECT pg_temp.add_payment('e15', 70, 'success');
SELECT pg_temp.settle_order('e15');
DO $$ DECLARE provider_denied BOOLEAN := false; sweet_denied BOOLEAN := false; BEGIN
  BEGIN
    INSERT INTO refunds (
      id, refund_no, order_id, payment_id, refund_amount,
      provider_refund_amount, sweet_card_refund_amount,
      status, request_key, requested_by, approved_by
    ) VALUES (
      'ref-e15-provider', 'RF-e15-provider', 'e15', 'pay-e15', 71, 71, 0,
      'pending', 'refund-request-e15-provider', 'p7b', 'p7b'
    );
  EXCEPTION WHEN check_violation THEN provider_denied := true;
  END;
  BEGIN
    INSERT INTO refunds (
      id, refund_no, order_id, payment_id, refund_amount,
      provider_refund_amount, sweet_card_refund_amount,
      status, request_key, requested_by, approved_by
    ) VALUES (
      'ref-e15-sweet', 'RF-e15-sweet', 'e15', 'pay-e15', 31, 0, 31,
      'pending', 'refund-request-e15-sweet', 'p7b', 'p7b'
    );
  EXCEPTION WHEN check_violation THEN sweet_denied := true;
  END;
  IF NOT provider_denied OR NOT sweet_denied THEN
    RAISE EXCEPTION 'mixed rail over-refund was not denied on both rails';
  END IF;
  PERFORM pg_temp.record_pass('E15', 'Mixed refund rail isolation enforced independently');
END $$;

-- E16: duplicate request identity cannot create a second economic reservation.
SELECT pg_temp.make_order('e16', 100);
SELECT pg_temp.add_payment('e16', 100, 'success');
SELECT pg_temp.settle_order('e16');
INSERT INTO refunds (id, refund_no, order_id, payment_id, refund_amount, status, request_key, requested_by, approved_by)
VALUES ('ref-e16', 'RF-e16', 'e16', 'pay-e16', 10, 'pending', 'refund-request-e16', 'p7b', 'p7b');
INSERT INTO refund_items (id, refund_id, order_item_id, quantity, amount_cents)
VALUES ('ri-e16', 'ref-e16', 'oi-e16', 1, 10);
DO $$ BEGIN
  BEGIN
    INSERT INTO refunds (id, refund_no, order_id, payment_id, refund_amount, status, request_key, requested_by, approved_by)
    VALUES ('ref-e16-duplicate', 'RF-e16-duplicate', 'e16', 'pay-e16', 10, 'pending', 'refund-request-e16', 'p7b', 'p7b');
    RAISE EXCEPTION 'expected denial was not raised';
  EXCEPTION WHEN unique_violation THEN
    IF (SELECT COUNT(*) FROM refunds WHERE request_key = 'refund-request-e16') <> 1 THEN
      RAISE EXCEPTION 'duplicate request created more than one refund';
    END IF;
    PERFORM pg_temp.record_pass('E16', 'Duplicate refund request has one economic effect');
  END;
END $$;

-- A1: force a late redemption failure; every financial write rolls back.
SELECT pg_temp.make_order('a01', 100);
INSERT INTO sweet_card_accounts (
  id, public_card_no, initial_amount_cents, balance_cents,
  validity_type, status, carrier_type, binding_mode
) VALUES ('sca-a01', 'CARD-a01', 100, 100, 'ONE_YEAR', 'ACTIVE', 'ELECTRONIC', 'NONE');
INSERT INTO sweet_card_credentials (
  id, account_id, public_token_id, token_hash, token_ciphertext,
  token_iv, token_tag, status, carrier_type
) VALUES ('scc-a01', 'sca-a01', 'TOKEN-a01', 'HASH-a01', 'CIPHER-a01', 'IV-a01', 'TAG-a01', 'ACTIVE', 'ELECTRONIC');
DO $$ BEGIN
  BEGIN
    INSERT INTO sweet_card_redemptions (
      id, redemption_no, order_id, account_id, credential_id, amount_cents,
      eligible_subtotal_cents, ineligible_subtotal_cents, request_key,
      store_id_snapshot, redeemed_by_id
    ) VALUES ('scr-a01', 'RN-a01', 'a01', 'sca-a01', 'scc-a01', 100, 100, 0, 'redemption-request-a01', 'p7b-store', 'p7b');
    UPDATE order_items SET sweet_card_eligible_snapshot = true, sweet_card_redeemed_amount = 100 WHERE id = 'oi-a01';
    INSERT INTO sweet_card_redemption_items (
      id, redemption_id, order_item_id, product_id, eligible_snapshot,
      eligible_amount_cents, redeemed_amount_cents
    ) VALUES ('sri-a01', 'scr-a01', 'oi-a01', 'p7b-product', true, 100, 100);
    INSERT INTO sweet_card_ledger (
      id, account_id, type, amount_cents, balance_after_cents,
      order_id, redemption_id, request_key
    ) VALUES ('scl-a01', 'sca-a01', 'REDEEM', -100, 0, 'a01', 'scr-a01', 'ledger-a01');
    UPDATE sweet_card_accounts SET balance_cents = 0 WHERE id = 'sca-a01';
    UPDATE orders SET sweet_card_amount = 100 WHERE id = 'a01';
    INSERT INTO sweet_card_ledger (
      id, account_id, type, amount_cents, balance_after_cents,
      order_id, redemption_id, request_key
    ) VALUES ('scl-a01-duplicate', 'sca-a01', 'REDEEM', -100, 0, 'a01', 'scr-a01', 'ledger-a01');
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  IF (SELECT balance_cents FROM sweet_card_accounts WHERE id = 'sca-a01') <> 100
     OR EXISTS (SELECT 1 FROM sweet_card_redemptions WHERE order_id = 'a01')
     OR EXISTS (SELECT 1 FROM sweet_card_ledger WHERE order_id = 'a01')
     OR EXISTS (SELECT 1 FROM sweet_card_redemption_items WHERE order_item_id = 'oi-a01')
     OR (SELECT sweet_card_amount FROM orders WHERE id = 'a01') <> 0
     OR (SELECT payment_status FROM orders WHERE id = 'a01') <> 'unpaid' THEN
    RAISE EXCEPTION 'late redemption failure leaked a financial write';
  END IF;
  PERFORM pg_temp.record_pass('A01', 'Late redemption failure rolled back balance, Redemption, Ledger, Allocation and Order');
END $$;

-- A2: force a late completion failure; pending refund remains, no credit leaks.
SELECT pg_temp.make_order('a02', 100);
SELECT pg_temp.add_sweet_card('a02', 100, true);
SELECT pg_temp.settle_order('a02');
INSERT INTO refunds (
  id, refund_no, order_id, refund_mode, refund_amount,
  provider_refund_amount, sweet_card_refund_amount,
  status, request_key, requested_by, approved_by
) VALUES ('ref-a02', 'RF-a02', 'a02', 'PAYMENT', 100, 0, 100, 'pending', 'refund-request-a02', 'p7b', 'p7b');
INSERT INTO refund_items (id, refund_id, order_item_id, quantity, amount_cents)
VALUES ('ri-a02', 'ref-a02', 'oi-a02', 1, 100);
INSERT INTO sweet_card_refunds (id, refund_id, redemption_id, account_id, amount_cents, request_key)
VALUES ('scf-a02', 'ref-a02', 'scr-a02', 'sca-a02', 100, 'sweet-refund-a02');
INSERT INTO sweet_card_refund_items (id, sweet_card_refund_id, refund_item_id, redemption_item_id, amount_cents)
VALUES ('scfi-a02', 'scf-a02', 'ri-a02', 'sri-a02', 100);
DO $$ BEGIN
  BEGIN
    UPDATE refunds SET status = 'completed', completed_at = clock_timestamp() WHERE id = 'ref-a02';
    INSERT INTO sweet_card_ledger (
      id, account_id, type, amount_cents, balance_after_cents,
      order_id, refund_id, request_key
    ) VALUES ('scl-refund-a02', 'sca-a02', 'REFUND', 100, 100, 'a02', 'ref-a02', 'ledger-refund-a02');
    UPDATE sweet_card_accounts SET balance_cents = 100 WHERE id = 'sca-a02';
    UPDATE orders SET status = 'refunded', payment_status = 'refunded' WHERE id = 'a02';
    INSERT INTO sweet_card_ledger (
      id, account_id, type, amount_cents, balance_after_cents,
      order_id, refund_id, request_key
    ) VALUES ('scl-refund-a02-duplicate', 'sca-a02', 'REFUND', 100, 100, 'a02', 'ref-a02', 'ledger-refund-a02');
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  IF (SELECT balance_cents FROM sweet_card_accounts WHERE id = 'sca-a02') <> 0
     OR (SELECT status FROM refunds WHERE id = 'ref-a02') <> 'pending'
     OR EXISTS (SELECT 1 FROM sweet_card_ledger WHERE refund_id = 'ref-a02')
     OR (SELECT status FROM orders WHERE id = 'a02') <> 'completed'
     OR (SELECT payment_status FROM orders WHERE id = 'a02') <> 'paid' THEN
    RAISE EXCEPTION 'late refund completion failure leaked a financial write';
  END IF;
  PERFORM pg_temp.record_pass('A02', 'Late refund failure left balance unchanged, Refund pending, no credit Ledger, Order paid');
END $$;

DO $$ BEGIN
  IF (SELECT COUNT(*) FROM p7b_results) <> 28 THEN
    RAISE EXCEPTION 'expected 28 matrix results, got %', (SELECT COUNT(*) FROM p7b_results);
  END IF;
END $$;

SELECT case_id, outcome, detail FROM p7b_results ORDER BY case_id;

ROLLBACK;
