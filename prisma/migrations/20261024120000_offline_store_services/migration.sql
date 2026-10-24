-- Additive only. No historical identity backfill, status rewrite or data deletion.
ALTER TABLE customer_service_requests
 ADD COLUMN customer_user_id TEXT, ADD COLUMN customer_app_id TEXT, ADD COLUMN customer_env_id TEXT,
 ADD COLUMN customer_open_id TEXT, ADD COLUMN subscription_choice TEXT, ADD COLUMN subscription_template_id TEXT,
 ADD COLUMN receipt_confirmed_at TIMESTAMP(3), ADD COLUMN receipt_confirmed_by TEXT,
 ADD COLUMN shipment_confirmed_at TIMESTAMP(3), ADD COLUMN shipment_confirmed_by TEXT,
 ADD COLUMN carrier TEXT, ADD COLUMN tracking_no TEXT, ADD COLUMN delivery_proof TEXT,
 ADD COLUMN shipment_version INTEGER NOT NULL DEFAULT 0;
CREATE INDEX customer_service_requests_customer_scope_idx ON customer_service_requests(customer_user_id,customer_app_id,customer_env_id,submitted_at,id);
ALTER TABLE customer_service_request_tokens ADD COLUMN mini_scene_hash TEXT;
CREATE UNIQUE INDEX customer_service_request_tokens_mini_scene_hash_key ON customer_service_request_tokens(mini_scene_hash);
CREATE TABLE store_service_audits (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL,
 reason TEXT NOT NULL DEFAULT '', detail JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX store_service_audits_request_id_created_at_idx ON store_service_audits(request_id,created_at);
CREATE TABLE store_service_deliveries (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL, event TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
 user_id TEXT NOT NULL, app_id TEXT NOT NULL, env_id TEXT NOT NULL, open_id TEXT NOT NULL,
 channel TEXT NOT NULL DEFAULT 'WECHAT_SUBSCRIBE', template_id TEXT, status TEXT NOT NULL DEFAULT 'PENDING',
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 claimed_at TIMESTAMP(3), claim_id TEXT, platform_code TEXT, accepted_at TIMESTAMP(3),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT store_service_deliveries_status_check CHECK (status IN ('PENDING','SENDING','ACCEPTED','NO_PERMISSION','BLOCKED_CONFIG','FAILED','UNKNOWN'))
);
CREATE UNIQUE INDEX store_service_delivery_event_key ON store_service_deliveries(request_id,event,version,user_id,channel);
CREATE INDEX store_service_deliveries_status_next_attempt_at_idx ON store_service_deliveries(status,next_attempt_at);
CREATE TABLE store_service_visits (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL, user_id TEXT NOT NULL, event TEXT NOT NULL,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT store_service_visit_event_check CHECK (event IN ('SCAN','MALL'))
);
CREATE UNIQUE INDEX store_service_visits_request_id_user_id_event_key ON store_service_visits(request_id,user_id,event);
CREATE INDEX store_service_visits_event_created_at_idx ON store_service_visits(event,created_at);
