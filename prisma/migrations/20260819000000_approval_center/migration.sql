-- 审批中心（通用审批引擎）：模板/单据/节点/抄送/附件/意见/日志/站内通知

-- CreateTable
CREATE TABLE "approval_templates" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "schema" JSONB NOT NULL,
    "approver_rule" JSONB NOT NULL,
    "cc_rule" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "approval_templates_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" TEXT NOT NULL,
    "request_no" TEXT NOT NULL,
    "template_key" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "form_data" JSONB NOT NULL,
    "amount_cents" BIGINT NOT NULL DEFAULT 0,
    "submitter_username" TEXT NOT NULL,
    "submitter_name" TEXT NOT NULL DEFAULT '',
    "approved_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "approval_requests_request_no_key" UNIQUE ("request_no"),
    CONSTRAINT "approval_requests_template_key_fkey" FOREIGN KEY ("template_key") REFERENCES "approval_templates" ("key") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "approval_nodes" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "node_index" INTEGER NOT NULL,
    "approver_username" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "comment" TEXT NOT NULL DEFAULT '',
    "acted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "approval_nodes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "approval_nodes_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "approval_requests" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "approval_ccs" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "cc_username" TEXT NOT NULL,
    "cc_name" TEXT NOT NULL DEFAULT '',
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "approval_ccs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "approval_ccs_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "approval_requests" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "approval_attachments" (
    "id" TEXT NOT NULL,
    "request_id" TEXT,
    "name" TEXT NOT NULL,
    "file_type" TEXT NOT NULL DEFAULT '',
    "file_size" INTEGER NOT NULL DEFAULT 0,
    "data_url" TEXT NOT NULL,
    "storage_provider" TEXT NOT NULL DEFAULT 'local',
    "storage_key" TEXT NOT NULL DEFAULT '',
    "uploader_username" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "approval_attachments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "approval_attachments_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "approval_requests" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "approval_comments" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "node_id" TEXT,
    "username" TEXT NOT NULL DEFAULT '',
    "user_role" TEXT NOT NULL DEFAULT '',
    "content" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "approval_comments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "approval_comments_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "approval_requests" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "approval_comments_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "approval_nodes" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "approval_logs" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "username" TEXT NOT NULL DEFAULT '',
    "detail" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "approval_logs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "approval_logs_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "approval_requests" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "approval_notifications" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "content" TEXT NOT NULL DEFAULT '',
    "read_at" TIMESTAMP(3),
    "channel" TEXT NOT NULL DEFAULT 'inapp',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "approval_notifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "approval_notifications_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "approval_requests" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "approval_requests_submitter_username_status_idx" ON "approval_requests"("submitter_username", "status");

-- CreateIndex
CREATE INDEX "approval_requests_status_created_at_idx" ON "approval_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "approval_requests_template_key_status_idx" ON "approval_requests"("template_key", "status");

-- CreateIndex
CREATE INDEX "approval_nodes_request_id_idx" ON "approval_nodes"("request_id");

-- CreateIndex
CREATE INDEX "approval_nodes_approver_username_status_idx" ON "approval_nodes"("approver_username", "status");

-- CreateIndex
CREATE INDEX "approval_ccs_request_id_idx" ON "approval_ccs"("request_id");

-- CreateIndex
CREATE INDEX "approval_ccs_cc_username_read_at_idx" ON "approval_ccs"("cc_username", "read_at");

-- CreateIndex
CREATE INDEX "approval_attachments_request_id_idx" ON "approval_attachments"("request_id");

-- CreateIndex
CREATE INDEX "approval_comments_request_id_idx" ON "approval_comments"("request_id");

-- CreateIndex
CREATE INDEX "approval_logs_request_id_created_at_idx" ON "approval_logs"("request_id", "created_at");

-- CreateIndex
CREATE INDEX "approval_notifications_username_read_at_idx" ON "approval_notifications"("username", "read_at");

-- CreateIndex
CREATE INDEX "approval_notifications_request_id_idx" ON "approval_notifications"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_ccs_request_id_cc_username_key" ON "approval_ccs"("request_id", "cc_username");
