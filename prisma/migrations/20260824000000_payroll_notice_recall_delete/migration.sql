-- 工资条撤回/删除：新增留痕字段与状态扩展（pending | confirmed | recalled | deleted）
ALTER TABLE "payroll_notices" ADD COLUMN "recalled_at" TIMESTAMP(3);
ALTER TABLE "payroll_notices" ADD COLUMN "recalled_by" TEXT NOT NULL DEFAULT '';
ALTER TABLE "payroll_notices" ADD COLUMN "deleted_at" TIMESTAMP(3);
ALTER TABLE "payroll_notices" ADD COLUMN "deleted_by" TEXT NOT NULL DEFAULT '';
