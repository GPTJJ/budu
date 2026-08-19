-- 通知中心（Notification Center）：模板/消息/投递记录/微信绑定
-- 业务模块只调用通知中心；通道（站内/微信/APP/短信/邮件）由中心统一派发

-- CreateTable: notification_templates
CREATE TABLE "notification_templates" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "titleTpl" TEXT NOT NULL,
    "contentTpl" TEXT NOT NULL,
    "target" TEXT NOT NULL DEFAULT '',
    "defaultPriority" TEXT NOT NULL DEFAULT 'normal',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("key")
);

-- CreateTable: notifications
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "template_key" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "status" TEXT NOT NULL DEFAULT 'unread',
    "ack_status" TEXT NOT NULL DEFAULT 'none',
    "ack_at" TIMESTAMP(3),
    "ack_by" TEXT NOT NULL DEFAULT '',
    "target" TEXT NOT NULL DEFAULT '',
    "ref_type" TEXT NOT NULL DEFAULT '',
    "ref_id" TEXT NOT NULL DEFAULT '',
    "read_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_username_status_idx" ON "notifications"("username", "status");
CREATE INDEX "notifications_username_created_at_idx" ON "notifications"("username", "created_at");

-- CreateTable: notification_deliveries
CREATE TABLE "notification_deliveries" (
    "id" TEXT NOT NULL,
    "notification_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'inapp',
    "status" TEXT NOT NULL DEFAULT 'sent',
    "error" TEXT NOT NULL DEFAULT '',
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_deliveries_notification_id_idx" ON "notification_deliveries"("notification_id");

-- CreateTable: wechat_bindings
CREATE TABLE "wechat_bindings" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'wecom',
    "openId" TEXT NOT NULL,
    "nickname" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'active',
    "bound_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    CONSTRAINT "wechat_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wechat_bindings_username_channel_key" ON "wechat_bindings"("username", "channel");
CREATE INDEX "wechat_bindings_username_status_idx" ON "wechat_bindings"("username", "status");
