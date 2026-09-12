-- Additive, candidate only. Durable commerce authorization; no financial mutation.
CREATE TABLE online_fulfillment_authorizations (
 id TEXT PRIMARY KEY,
 settlement_id TEXT NOT NULL UNIQUE REFERENCES online_settlements(id) ON DELETE RESTRICT,
 request_key TEXT NOT NULL,
 request_fingerprint TEXT NOT NULL,
 method TEXT NOT NULL,
 carrier_code TEXT,
 tracking_no TEXT,
 actor_id TEXT NOT NULL,
 settlement_version INTEGER NOT NULL CHECK (settlement_version > 0),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK (length(actor_id) BETWEEN 1 AND 160),
 CHECK (request_key ~ '^[A-Za-z0-9:_-]{8,128}$'),
 CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
 CHECK ((method='PICKUP' AND carrier_code IS NULL AND tracking_no IS NULL)
   OR (method='DELIVERY' AND carrier_code ~ '^[A-Za-z0-9_-]{1,40}$' AND tracking_no ~ '^[A-Za-z0-9_-]{1,80}$' AND carrier_code IS NOT NULL AND tracking_no IS NOT NULL))
);
CREATE FUNCTION online_fulfillment_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ONLINE_FULFILLMENT_AUTHORIZATION_IMMUTABLE'; END;
$$;
CREATE TRIGGER online_fulfillment_no_rewrite BEFORE UPDATE OR DELETE ON online_fulfillment_authorizations
FOR EACH ROW EXECUTE FUNCTION online_fulfillment_immutable();
