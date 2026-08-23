# 员工档案模块（Employee Master Profile）实施报告

> 提交：`95b5e6c`（分支 `feat/wecom-push`）· 2026-08-23
> 状态：后端 + 前端已完成并通过全部测试；**未部署**（按约定随下次部署一并上线）
> 范围：一期 P0（directive §65）；P1（培训/提醒/多期合同/再入职周期/批量导入导出）不在本期

---

## 1. 交付清单

| 类别 | 文件 |
|---|---|
| 后端路由 | `server/employee-profile.js`（新增，~740 行） |
| 后端挂载 | `server/app.js`（`/api/v2` 业务组，cashier 一律 403） |
| 数据模型 | `prisma/schema.prisma`（新增 10 张表） |
| 迁移 | `prisma/migrations/20260823000001_employee_profile/migration.sql`（含追加掩码列） |
| 权限 | `shared/accountPermissions.js`（`MODULE_KEYS.EMPLOYEE_PROFILE`） |
| 前端页面 | `src/components/EmployeeProfilePage.jsx`（新增，~1650 行） |
| 前端入口 | `Dashboard.jsx`（视图注册+跳转）、`Sidebar.jsx`（菜单）、`PersonnelPage.jsx`（员工卡片）、`PayrollPage.jsx` / `PayrollSlipModal.jsx` / `PayrollSlipCard.jsx`（工资条弹窗） |
| 测试 | `scripts/test-employee-profile.mjs`（后端单元 9 项）、`tests/employee-profile.spec.mjs` + harness（Playwright 10 项） |
| 文档 | `docs/REQUIREMENTS_SPEC.md`（§2.5.1 + 验收 + 安全）、`docs/TECH_HIGHLIGHTS.md`（亮点五） |

---

## 2. 数据模型（10 张新表，全部 FK → `employees`，onDelete: Restrict）

| 表 | 用途 | 关键字段 |
|---|---|---|
| `employees` | 员工主档 | employeeNo（BUDU-XXXX 唯一）、status、employmentType、hireDate、currentStoreKey、position、level、userId |
| `employee_profiles` | 基本资料+身份 | gender/birthDate/phone/…、idType、`id_number_enc`（AES 密文）、`id_number_last4`、`id_number_masked`、紧急联系人 |
| `employee_bank_accounts` | 工资银行卡 | `card_number_enc`（AES 密文）、card_last4、bankName、isPayroll、status |
| `employee_contracts` | 劳动合同 | contractType/No、signDate/startDate/endDate、isIndefinite、probationMonths、status（终止=软删） |
| `employee_salary_history` | 调薪履历 | oldValue、newValue、salaryType、reason、operatorName |
| `employee_store_history` | 调店履历 | fromStoreKey → toStoreKey |
| `employee_position_history` | 调岗/调职级履历 | fromPosition/Level → toPosition/Level |
| `employee_status_history` | 在职状态履历 | action（HIRE/PROBATION_PASS/LEAVE/SUSPEND/RESIGN/REHIRE）、lastWorkDate、resignType/Reason、交接/薪资结清/物品归还标记 |
| `employee_documents` | 附件 | data（base64）、documentType、isSensitive、上传人；删除=内容清空保留记录 |
| `employee_audit_logs` | 审计日志 | action、operatorName/Role、before/afterValue（**只记尾号**） |

所有历史表**只追加、不覆盖、不提供硬删除**；离职（RESIGN）不删除档案。

---

## 3. API 一览（`/api/v2/employees...`，全部要求登录 + 模块权限）

| 方法 | 路径 | 说明 | 编辑权限 |
|---|---|---|---|
| GET | `/employees?q=` | 列表（姓名/编号/手机号搜索，最多 200） | 模块 |
| GET/PUT | `/employees/:id/profile` | 基本资料 | 模块 / dev+admin+finance |
| GET/PUT | `/employees/:id/employment` | 任职信息（门店/岗位/职级/用工/入职日期）；变更自动写历史 | 模块 / 同上 |
| GET/PUT | `/employees/:id/identity` | 身份证（掩码）；号码加密存储，审计只记 last4 | 模块 / 同上 |
| POST | `/employees/:id/identity/reveal` | 完整身份证号（**仅 developer/admin**）+ 审计 | — |
| GET/PUT | `/employees/:id/bank-account` | 银行卡（掩码） | 模块 / 同上 |
| POST | `/employees/:id/bank-account/reveal` | 完整卡号（**dev/admin/finance**）+ 审计 | — |
| GET/POST | `/employees/:id/contracts` | 合同列表/新增 | 模块 / dev+admin+finance |
| DELETE | `/employees/:id/contracts/:cid` | 终止合同（软删） | dev+admin+finance |
| POST | `/employees/:id/salary-change` | 调薪记录（追加） | dev+admin+finance |
| POST | `/employees/:id/status-change` | 入职/转正/停薪/停职/离职/返聘 | dev+admin+finance |
| GET | `/employees/:id/timeline` | 履历时间线（合并各历史倒序） | 模块 |
| GET | `/employees/:id/summary` | 工资/考勤摘要（**只读**现有 PayrollNotice / DailyStoreStaff，不建第二份真值） | 模块 |
| GET/POST | `/employees/:id/documents` | 附件列表/上传（≤4MB） | 模块 / dev+admin+finance |
| GET | `/employees/:id/documents/:docId/content` | 附件读取（敏感附件仅 dev+admin+finance）+ 审计 | 模块 |
| DELETE | `/employees/:id/documents/:docId` | 逻辑删除（内容清空、记录保留） | dev+admin+finance |
| POST | `/employees/backfill` | 存量回填（幂等，不修改现有数据） | dev+admin+finance |

---

## 4. 权限矩阵

| 能力 | developer | admin | finance | manager | staff | cashier |
|---|---|---|---|---|---|---|
| 查看员工档案 | ✅ | ✅ | ✅ | ✅（全量） | ❌（一期未开放自助） | ❌ |
| 编辑资料/任职/身份/银行卡/合同/附件/状态 | ✅ | ✅ | ✅ | ❌（只读） | ❌ | ❌ |
| reveal 完整身份证号 | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| reveal 完整银行卡号 | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| 读取敏感附件 | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |

- 模块键：`MODULE_KEYS.EMPLOYEE_PROFILE='employee-profile'`；dev/admin/finance 自动全量，manager 默认拥有，staff 默认显式排除
- 前端按 `hasModuleAccess` 控制入口与按钮，后端每个接口二次校验（fail-closed）
- 页面/接口双重拦截：`requireBusiness`（cashier 全拒）+ 模块级 `requireProfileAccess` + 操作级 `canEdit/canReveal*` + 行级 `canViewEmployee`（staff 未来自助仅限本人，已预留）

---

## 5. 敏感数据保护（核心设计）

1. **加密存储**：身份证号/银行卡号 AES-256-GCM（随机 12B IV + 16B 认证标签），密文格式 `iv:tag:cipher`（hex）；密钥独立环境变量 `EMPLOYEE_SENSITIVE_KEY`（64 hex / 32 字节），缺失时读写 **fail-closed 503**，绝不降级明文
2. **默认掩码**：普通接口只返回 `110101********1234`（身份证前6后4）/ `**** **** **** 6288`（卡尾4）；掩码由服务端生成并落库（`id_number_masked`），前端仅展示
3. **reveal 流程**：独立接口 + 角色白名单 + 前端二次确认弹窗；完整号码只在内存 state 中短暂展示，可一键复制；**不写入** localStorage / URL / console / 错误消息 / 审计
4. **审计最小化**：before/after 只记录 last4 与变更动作，完整号码永不进入 `employee_audit_logs`
5. **日志消毒**：错误处理只打印 `error.message + stack`，不打印 Prisma meta/args；所有错误文案为静态文本
6. **附件分级**：敏感附件（身份证/银行卡复印件等）内容仅 dev/admin/finance 可读，普通角色只见元数据

---

## 6. 关键业务规则

- **离职 ≠ 删除**：RESIGN 保留全部档案与履历，仅标记状态；支持 REHIRE 返聘恢复；前端离职表单含离职日期/类型/原因/薪资结清/物品归还
- **履历只追加**：调薪/调店/调岗/状态变更全部生成历史记录并可追溯操作人
- **回填幂等**：从现有 `Staff` 名单生成主档与 BUDU-XXXX 编号；重复执行自动跳过；不修改任何现有表/数据
- **单一真值**：工资/考勤摘要只读引用 PayrollNotice/DailyStoreStaff
- **合同/附件删除均为逻辑删除**（保留记录）

---

## 7. 测试与验证

| 套件 | 结果 |
|---|---|
| 后端单元 `scripts/test-employee-profile.mjs`（9 项：加解密往返/密钥缺失 fail-closed/密文不含明文/掩码格式/权限矩阵） | ✅ PASS |
| 统一矩阵 `node scripts/run-tests.mjs` | ✅ **28/28** |
| Playwright `tests/employee-profile.spec.mjs`（10 项：列表/掩码默认/reveal 确认+审计请求/空态/时间线/工资考勤/附件/角色矩阵/离职保留） | ✅ **10/10** |
| Playwright 全量 | ✅ **44/44** |
| 手工 E2E（真实 PG + vite dev）：登录→菜单→列表→详情→身份 reveal→审计落库；调薪→离职（档案保留）→返聘；附件敏感权限矩阵（manager 403）；合同增/终止；回填幂等（4 员工全部跳过） | ✅ 全通过 |

---

## 8. 部署注意事项（下次部署时）

1. **必须新增环境变量**：`EMPLOYEE_SENSITIVE_KEY=<64 位 hex>`（生产密钥需新生成并妥善保管；缺失时员工档案敏感字段读写返回 503，其余功能不受影响）
2. 迁移：`prisma migrate deploy`（或 db push）执行 `20260823000001_employee_profile`
3. 部署后建议以 dev 账号执行一次「回填档案」（幂等）生成存量员工主档
4. 本模块按约定**未部署**，与 09d25d9（门店业绩录入过滤）等随下次部署一并上线

---

## 9. 未完成 / 一期外（P1）

- 培训记录、到期提醒（证件/合同）、多期合同并存管理、再入职周期管理、批量导入导出
- 员工自助查看本人档案（模块默认不开放 staff，后端 `canViewEmployee` 已预留本人分支）
- 敏感字段二次编辑校验（如身份证号重复登记提示）与 reveal 短信/邮箱验证码强认证（当前为角色+审计）
