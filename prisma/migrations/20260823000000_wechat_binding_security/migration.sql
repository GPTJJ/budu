-- 企业微信绑定安全加固：一次性 OAuth state、绑定审计、活动身份唯一约束。
-- 迁移为增量变更；若线上已存在同一通道/身份的多条活动绑定，则安全失败并要求先人工核对。

BEGIN;

-- 必须先检查再创建任何对象；即使未来移除事务包装，重复数据也不会留下半迁移状态。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "wechat_bindings"
    WHERE "status" = 'active'
    GROUP BY "channel", "openId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate active wechat identities detected; review bindings before migration';
  END IF;
END $$;

CREATE UNIQUE INDEX "wechat_bindings_active_channel_open_id_key"
ON "wechat_bindings"("channel", "openId")
WHERE "status" = 'active';

CREATE TABLE "wechat_bind_states" (
    "id" TEXT NOT NULL,
    "state_hash" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "wechat_bind_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wechat_bind_states_state_hash_key" ON "wechat_bind_states"("state_hash");
CREATE INDEX "wechat_bind_states_expires_at_idx" ON "wechat_bind_states"("expires_at");
CREATE INDEX "wechat_bind_states_username_created_at_idx" ON "wechat_bind_states"("username", "created_at");

CREATE TABLE "wechat_binding_audit_logs" (
    "id" TEXT NOT NULL,
    "binding_id" TEXT NOT NULL DEFAULT '',
    "target_username" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor_username" TEXT NOT NULL DEFAULT '',
    "identity_hint" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "wechat_binding_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "wechat_binding_audit_logs_target_username_created_at_idx"
ON "wechat_binding_audit_logs"("target_username", "created_at");
CREATE INDEX "wechat_binding_audit_logs_actor_username_created_at_idx"
ON "wechat_binding_audit_logs"("actor_username", "created_at");

COMMIT;
