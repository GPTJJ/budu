-- Customer Self-Service Request 1.0
-- Unified one-time public workflow for MAILING / INVOICE.

CREATE TABLE "customer_service_requests" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "store_key" TEXT NOT NULL,
    "created_by_user_id" TEXT,
    "created_by_username" TEXT NOT NULL,
    "handler_username" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING_CUSTOMER',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "submitted_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "linked_business_record_id" TEXT,
    "request_metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customer_service_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customer_service_requests_type_check" CHECK ("type" IN ('MAILING', 'INVOICE')),
    CONSTRAINT "customer_service_requests_status_check" CHECK ("status" IN ('WAITING_CUSTOMER', 'SUBMITTED', 'EXPIRED', 'CANCELLED'))
);

CREATE TABLE "customer_service_request_tokens" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "invalidated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customer_service_request_tokens_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customer_service_request_tokens_status_check" CHECK ("status" IN ('ACTIVE', 'CONSUMED', 'INVALIDATED'))
);

CREATE UNIQUE INDEX "customer_service_requests_linked_business_record_id_key"
ON "customer_service_requests"("linked_business_record_id");
CREATE INDEX "customer_service_requests_type_status_created_at_idx"
ON "customer_service_requests"("type", "status", "created_at");
CREATE INDEX "customer_service_requests_store_key_status_created_at_idx"
ON "customer_service_requests"("store_key", "status", "created_at");
CREATE INDEX "customer_service_requests_created_by_username_type_status_idx"
ON "customer_service_requests"("created_by_username", "type", "status");

CREATE UNIQUE INDEX "customer_service_request_tokens_token_hash_key"
ON "customer_service_request_tokens"("token_hash");
CREATE INDEX "customer_service_request_tokens_request_id_status_idx"
ON "customer_service_request_tokens"("request_id", "status");
CREATE INDEX "customer_service_request_tokens_expires_at_status_idx"
ON "customer_service_request_tokens"("expires_at", "status");

ALTER TABLE "customer_service_requests"
ADD CONSTRAINT "customer_service_requests_store_key_fkey"
FOREIGN KEY ("store_key") REFERENCES "Store"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "customer_service_requests"
ADD CONSTRAINT "customer_service_requests_created_by_user_id_fkey"
FOREIGN KEY ("created_by_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "customer_service_request_tokens"
ADD CONSTRAINT "customer_service_request_tokens_request_id_fkey"
FOREIGN KEY ("request_id") REFERENCES "customer_service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
