-- 员工档案（Employee Master Profile）：全部增量新增，不修改任何现有表。
-- 敏感字段（身份证号/银行卡号）以密文（AES-256-GCM）存储，仅保留 last4 用于掩码展示。

CREATE TABLE "employees" (
  "id" TEXT NOT NULL,
  "employee_no" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "employment_type" TEXT NOT NULL DEFAULT 'fulltime',
  "hire_date" TIMESTAMP(3),
  "current_store_key" TEXT NOT NULL DEFAULT '',
  "user_id" TEXT,
  "position" TEXT NOT NULL DEFAULT '',
  "level" TEXT NOT NULL DEFAULT '',
  "avatar" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "employees_employee_no_key" ON "employees"("employee_no");
CREATE INDEX "employees_status_idx" ON "employees"("status");
CREATE INDEX "employees_current_store_key_idx" ON "employees"("current_store_key");

CREATE TABLE "employee_profiles" (
  "id" TEXT NOT NULL,
  "employee_id" TEXT NOT NULL,
  "gender" TEXT NOT NULL DEFAULT '',
  "birth_date" TIMESTAMP(3),
  "phone" TEXT NOT NULL DEFAULT '',
  "backup_phone" TEXT NOT NULL DEFAULT '',
  "email" TEXT NOT NULL DEFAULT '',
  "wechat" TEXT NOT NULL DEFAULT '',
  "nationality" TEXT NOT NULL DEFAULT '',
  "city" TEXT NOT NULL DEFAULT '',
  "address" TEXT NOT NULL DEFAULT '',
  "id_type" TEXT NOT NULL DEFAULT 'identity',
  "id_number_enc" TEXT NOT NULL DEFAULT '',
  "id_number_last4" TEXT NOT NULL DEFAULT '',
  "id_expiry_date" TIMESTAMP(3),
  "id_permanent" BOOLEAN NOT NULL DEFAULT false,
  "emergency_name" TEXT NOT NULL DEFAULT '',
  "emergency_relation" TEXT NOT NULL DEFAULT '',
  "emergency_phone" TEXT NOT NULL DEFAULT '',
  "emergency_backup" TEXT NOT NULL DEFAULT '',
  "emergency_note" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "employee_profiles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "employee_profiles_employee_id_key" ON "employee_profiles"("employee_id");
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "employee_bank_accounts" (
  "id" TEXT NOT NULL,
  "employee_id" TEXT NOT NULL,
  "account_name" TEXT NOT NULL DEFAULT '',
  "card_number_enc" TEXT NOT NULL,
  "card_last4" TEXT NOT NULL,
  "bank_name" TEXT NOT NULL DEFAULT '',
  "bank_branch" TEXT NOT NULL DEFAULT '',
  "bank_code" TEXT NOT NULL DEFAULT '',
  "is_payroll" BOOLEAN NOT NULL DEFAULT true,
  "status" TEXT NOT NULL DEFAULT 'active',
  "effective_date" TIMESTAMP(3),
  "note" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "employee_bank_accounts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "employee_bank_accounts_employee_id_status_idx" ON "employee_bank_accounts"("employee_id", "status");
ALTER TABLE "employee_bank_accounts" ADD CONSTRAINT "employee_bank_accounts_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "employee_contracts" (
  "id" TEXT NOT NULL,
  "employee_id" TEXT NOT NULL,
  "contract_type" TEXT NOT NULL DEFAULT '',
  "contract_no" TEXT NOT NULL DEFAULT '',
  "sign_date" TIMESTAMP(3),
  "start_date" TIMESTAMP(3),
  "end_date" TIMESTAMP(3),
  "is_indefinite" BOOLEAN NOT NULL DEFAULT false,
  "probation_months" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'active',
  "note" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "employee_contracts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "employee_contracts_employee_id_status_idx" ON "employee_contracts"("employee_id", "status");
ALTER TABLE "employee_contracts" ADD CONSTRAINT "employee_contracts_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "employee_salary_history" (
  "id" TEXT NOT NULL,
  "employee_id" TEXT NOT NULL,
  "effective_date" TIMESTAMP(3) NOT NULL,
  "old_value" TEXT NOT NULL DEFAULT '',
  "new_value" TEXT NOT NULL DEFAULT '',
  "salary_type" TEXT NOT NULL DEFAULT '',
  "reason" TEXT NOT NULL DEFAULT '',
  "operator_name" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "employee_salary_history_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "employee_salary_history_employee_id_effective_date_idx" ON "employee_salary_history"("employee_id", "effective_date");
ALTER TABLE "employee_salary_history" ADD CONSTRAINT "employee_salary_history_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "employee_store_history" (
  "id" TEXT NOT NULL,
  "employee_id" TEXT NOT NULL,
  "effective_date" TIMESTAMP(3) NOT NULL,
  "from_store_key" TEXT NOT NULL DEFAULT '',
  "to_store_key" TEXT NOT NULL DEFAULT '',
  "reason" TEXT NOT NULL DEFAULT '',
  "operator_name" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "employee_store_history_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "employee_store_history_employee_id_effective_date_idx" ON "employee_store_history"("employee_id", "effective_date");
ALTER TABLE "employee_store_history" ADD CONSTRAINT "employee_store_history_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "employee_position_history" (
  "id" TEXT NOT NULL,
  "employee_id" TEXT NOT NULL,
  "effective_date" TIMESTAMP(3) NOT NULL,
  "from_position" TEXT NOT NULL DEFAULT '',
  "to_position" TEXT NOT NULL DEFAULT '',
  "from_level" TEXT NOT NULL DEFAULT '',
  "to_level" TEXT NOT NULL DEFAULT '',
  "reason" TEXT NOT NULL DEFAULT '',
  "operator_name" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "employee_position_history_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "employee_position_history_employee_id_effective_date_idx" ON "employee_position_history"("employee_id", "effective_date");
ALTER TABLE "employee_position_history" ADD CONSTRAINT "employee_position_history_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "employee_status_history" (
  "id" TEXT NOT NULL,
  "employee_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "effective_date" TIMESTAMP(3) NOT NULL,
  "from_status" TEXT NOT NULL DEFAULT '',
  "to_status" TEXT NOT NULL DEFAULT '',
  "last_work_date" TIMESTAMP(3),
  "resign_type" TEXT NOT NULL DEFAULT '',
  "resign_reason" TEXT NOT NULL DEFAULT '',
  "handover_status" TEXT NOT NULL DEFAULT '',
  "salary_settled" BOOLEAN NOT NULL DEFAULT false,
  "property_returned" BOOLEAN NOT NULL DEFAULT false,
  "account_disabled" BOOLEAN NOT NULL DEFAULT false,
  "rehire_allowed" BOOLEAN NOT NULL DEFAULT true,
  "note" TEXT NOT NULL DEFAULT '',
  "operator_name" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "employee_status_history_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "employee_status_history_employee_id_effective_date_idx" ON "employee_status_history"("employee_id", "effective_date");
ALTER TABLE "employee_status_history" ADD CONSTRAINT "employee_status_history_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "employee_documents" (
  "id" TEXT NOT NULL,
  "employee_id" TEXT NOT NULL,
  "document_type" TEXT NOT NULL DEFAULT '',
  "file_name" TEXT NOT NULL DEFAULT '',
  "mime_type" TEXT NOT NULL DEFAULT '',
  "file_size" INTEGER NOT NULL DEFAULT 0,
  "data" TEXT NOT NULL DEFAULT '',
  "is_sensitive" BOOLEAN NOT NULL DEFAULT false,
  "note" TEXT NOT NULL DEFAULT '',
  "uploaded_by" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "employee_documents_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "employee_documents_employee_id_document_type_idx" ON "employee_documents"("employee_id", "document_type");
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "employee_audit_logs" (
  "id" TEXT NOT NULL,
  "employee_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "target_type" TEXT NOT NULL DEFAULT '',
  "target_id" TEXT NOT NULL DEFAULT '',
  "before_value" JSONB,
  "after_value" JSONB,
  "operator_name" TEXT NOT NULL DEFAULT '',
  "operator_role" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "employee_audit_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "employee_audit_logs_employee_id_created_at_idx" ON "employee_audit_logs"("employee_id", "created_at");
CREATE INDEX "employee_audit_logs_action_created_at_idx" ON "employee_audit_logs"("action", "created_at");
ALTER TABLE "employee_audit_logs" ADD CONSTRAINT "employee_audit_logs_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "employee_profiles" ADD COLUMN "id_number_masked" TEXT NOT NULL DEFAULT '';
