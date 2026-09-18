-- Additive, candidate only. WeChat logistics reporting state.
-- This is NOT a second fulfilment authority: shipping remains authorized by
-- online_fulfillment_authorizations, and a WeChat logistics failure must never
-- block or reverse a shipment the merchant already made.
CREATE TABLE online_logistics_traces (
 id TEXT PRIMARY KEY,
 settlement_id TEXT NOT NULL UNIQUE REFERENCES online_settlements(id) ON DELETE RESTRICT,
 authorization_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'PENDING',
 waybill_token TEXT,
 receiver_phone TEXT NOT NULL,
 goods_name TEXT NOT NULL,
 goods_img_url TEXT NOT NULL,
 order_detail_path TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 available_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 lease_until TIMESTAMP(3),
 lease_owner TEXT,
 last_error TEXT,
 synced_at TIMESTAMP(3),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK (status IN ('PENDING','SYNCED','UNSUPPORTED','FAILED')),
 CHECK (attempts >= 0),
 -- A waybill_token exists exactly when WeChat accepted the waybill. No token is
 -- ever invented locally, so the two facts can never drift apart.
 CHECK ((status = 'SYNCED') = (waybill_token IS NOT NULL)),
 CHECK (length(receiver_phone) BETWEEN 5 AND 40),
 CHECK (length(goods_name) BETWEEN 1 AND 120),
 CHECK (length(goods_img_url) BETWEEN 1 AND 512),
 CHECK (length(order_detail_path) BETWEEN 1 AND 256)
);
CREATE INDEX online_logistics_traces_status_available_at_idx ON online_logistics_traces(status, available_at);
-- A reported waybill_token is evidence of what WeChat already accepted. A later
-- attempt (or a different operator) must never rewrite it.
CREATE FUNCTION online_logistics_token_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.waybill_token IS NOT NULL AND NEW.waybill_token IS DISTINCT FROM OLD.waybill_token THEN
  RAISE EXCEPTION 'ONLINE_LOGISTICS_WAYBILL_TOKEN_IMMUTABLE';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER online_logistics_no_token_rewrite BEFORE UPDATE ON online_logistics_traces
FOR EACH ROW EXECUTE FUNCTION online_logistics_token_immutable();
