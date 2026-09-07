-- A1 additive identity bridge. OpenID is scoped by provider + MiniProgram AppID
-- and maps only to the canonical PostgreSQL User.id. No existing row or
-- financial table is changed.
CREATE TABLE "wechat_auth_identities" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "app_id" TEXT NOT NULL,
  "open_id" TEXT NOT NULL,
  "union_id" TEXT,
  "user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wechat_auth_identities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wechat_auth_identities_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "wechat_auth_identities_provider_app_id_open_id_key"
  ON "wechat_auth_identities"("provider", "app_id", "open_id");
CREATE INDEX "wechat_auth_identities_user_id_idx"
  ON "wechat_auth_identities"("user_id");
CREATE INDEX "wechat_auth_identities_union_id_idx"
  ON "wechat_auth_identities"("union_id");

CREATE TABLE "customer_sessions" (
  "id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_sessions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "customer_sessions_token_hash_key"
  ON "customer_sessions"("token_hash");
CREATE INDEX "customer_sessions_user_id_expires_at_idx"
  ON "customer_sessions"("user_id", "expires_at");
