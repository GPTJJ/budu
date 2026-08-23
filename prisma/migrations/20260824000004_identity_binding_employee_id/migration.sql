-- Data Authority DA-2.4：账号-员工绑定引入稳定 employeeId（staffKey 保留兼容快照）
ALTER TABLE "User" ADD COLUMN "employee_id" TEXT NOT NULL DEFAULT '';
