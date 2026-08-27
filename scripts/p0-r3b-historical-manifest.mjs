const employee = (employeeId, staffNameSnapshot, historicalPayrollHours) => ({
  employeeId,
  participantType: 'EMPLOYEE',
  participantUserId: null,
  staffNameSnapshot,
  historicalPayrollHours,
})

const substitute = (participantUserId, staffNameSnapshot, historicalPayrollHours) => ({
  employeeId: null,
  participantType: 'NON_EMPLOYEE_SUBSTITUTE',
  participantUserId,
  staffNameSnapshot,
  historicalPayrollHours,
})

const IDS = Object.freeze({
  shi: 'emp-58c68115-f0f2-4731-9951-2050d2e7229f',
  ye: 'emp-6ec93d71-6147-4e50-a5d0-0cf36fac95db',
  zuo: 'emp-7647053a-9232-4863-8609-72e62a35ce0b',
  li: 'emp-83535521-87b8-4def-b171-16ede79eefe6',
  wang: 'emp-40a8f7be-820b-4318-9cc5-1b3a2f40198d',
  shu: 'emp-8c4ba159-0fcb-474d-bb3c-ecd21928e2a8',
  chen: 'emp-73978c49-e12c-4f4f-9ca3-0a15f2de1977',
  sui: 'emp-53f97563-478f-423c-b269-87bdcaa39f1b',
  ma: 'emp-5b890d14-35ca-4b4b-a8a9-90eb69403687',
  capybara: '96d3615a-32b5-44f8-b362-39a48fee5f8c',
})

const entry = (dailyEntryId, date, storeKey, participants) => ({
  dailyEntryId,
  date,
  storeKey,
  expectedStatus: 'draft',
  expectedStaffNames: participants.map((row) => row.staffNameSnapshot),
  statusAuditId: `audit-p0r3b-${date.replaceAll('-', '')}-${storeKey}`,
  participants: participants.map((row, index) => ({
    ...row,
    dailyStoreStaffId: `dss-p0r3b-${date.replaceAll('-', '')}-${storeKey}-${index + 1}`,
  })),
})

export const P0_R3B_MANIFEST = Object.freeze([
  entry('de-2026-08-store-msh87b7f-08-01', '2026-08-01', 'chaowai', [substitute(IDS.capybara, '卡皮巴拉', 11.5)]),
  entry('de-2026-08-guanshe-08-01', '2026-08-01', 'guanshe', [employee(IDS.sui, '隋晓', 11)]),
  entry('de-2026-08-tongying-08-01', '2026-08-01', 'tongying', [employee(IDS.ye, '叶芷辰', 8), employee(IDS.li, '李飞燕', 8)]),
  entry('de-2026-08-xidan-08-01', '2026-08-01', 'xidan', [employee(IDS.wang, '王红云', 8), employee(IDS.chen, '陈文慧', 8)]),

  entry('de-2026-08-store-msh87b7f-08-02', '2026-08-02', 'chaowai', [substitute(IDS.capybara, '卡皮巴拉', 11.5)]),
  entry('de-2026-08-guanshe-08-02', '2026-08-02', 'guanshe', [employee(IDS.sui, '隋晓', 11)]),
  entry('de-2026-08-tongying-08-02', '2026-08-02', 'tongying', [employee(IDS.ye, '叶芷辰', 8), employee(IDS.li, '李飞燕', 8)]),
  entry('de-2026-08-xidan-08-02', '2026-08-02', 'xidan', [employee(IDS.chen, '陈文慧', 12)]),

  entry('de-2026-08-store-msh87b7f-08-03', '2026-08-03', 'chaowai', [employee(IDS.shu, '舒敏', 11.5)]),
  entry('de-2026-08-guanshe-08-03', '2026-08-03', 'guanshe', [employee(IDS.sui, '隋晓', 11)]),
  entry('de-2026-08-tongying-08-03', '2026-08-03', 'tongying', [employee(IDS.li, '李飞燕', 12)]),
  entry('de-2026-08-xidan-08-03', '2026-08-03', 'xidan', [employee(IDS.wang, '王红云', 12)]),

  entry('de-2026-08-store-msh87b7f-08-04', '2026-08-04', 'chaowai', [employee(IDS.ma, '马婧欣', 11.5)]),
  entry('de-2026-08-guanshe-08-04', '2026-08-04', 'guanshe', [employee(IDS.shi, '史璐璐', 11)]),
  entry('de-2026-08-tongying-08-04', '2026-08-04', 'tongying', [employee(IDS.li, '李飞燕', 12)]),
  entry('de-2026-08-xidan-08-04', '2026-08-04', 'xidan', [employee(IDS.chen, '陈文慧', 12)]),

  entry('de-2026-08-store-msh87b7f-08-05', '2026-08-05', 'chaowai', [employee(IDS.ma, '马婧欣', 11.5)]),
  entry('de-2026-08-guanshe-08-05', '2026-08-05', 'guanshe', [employee(IDS.shu, '舒敏', 11)]),
  entry('de-2026-08-tongying-08-05', '2026-08-05', 'tongying', [employee(IDS.ye, '叶芷辰', 12)]),
  entry('de-2026-08-xidan-08-05', '2026-08-05', 'xidan', [employee(IDS.wang, '王红云', 12)]),

  entry('de-2026-08-store-msh87b7f-08-06', '2026-08-06', 'chaowai', [employee(IDS.shi, '史璐璐', 11.5)]),
  entry('de-2026-08-guanshe-08-06', '2026-08-06', 'guanshe', [employee(IDS.sui, '隋晓', 11)]),
  entry('de-2026-08-tongying-08-06', '2026-08-06', 'tongying', [employee(IDS.ye, '叶芷辰', 12)]),
  entry('de-2026-08-xidan-08-06', '2026-08-06', 'xidan', [employee(IDS.chen, '陈文慧', 12)]),

  entry('de-2026-08-store-msh87b7f-08-07', '2026-08-07', 'chaowai', [employee(IDS.shu, '舒敏', 11.5)]),
  entry('de-2026-08-guanshe-08-07', '2026-08-07', 'guanshe', [employee(IDS.sui, '隋晓', 11)]),
  entry('de-2026-08-tongying-08-07', '2026-08-07', 'tongying', [employee(IDS.li, '李飞燕', 8), employee(IDS.ye, '叶芷辰', 8)]),
  entry('de-2026-08-xidan-08-07', '2026-08-07', 'xidan', [employee(IDS.chen, '陈文慧', 12)]),

  entry('de-mskfxz1d-olmrqo', '2026-08-08', 'chaowai', [employee(IDS.zuo, '左可翠', 11.5)]),
  entry('de-mskdufov-05jksx', '2026-08-08', 'guanshe', [employee(IDS.sui, '隋晓', 11)]),
  entry('de-mskgeyk1-6n8c9x', '2026-08-08', 'tongying', [employee(IDS.li, '李飞燕', 8), employee(IDS.ye, '叶芷辰', 8)]),
  entry('de-mskfs1su-exmpg0', '2026-08-08', 'xidan', [employee(IDS.chen, '陈文慧', 12)]),

  entry('de-msmh9p7u-5310ue', '2026-08-09', 'chaowai', [employee(IDS.ma, '马婧欣', 11.5)]),
  entry('de-mslt8kfc-q76i9a', '2026-08-09', 'guanshe', [employee(IDS.sui, '隋晓', 11)]),
  entry('de-mslvmz4v-4yh1fj', '2026-08-09', 'tongying', [employee(IDS.li, '李飞燕', 8), employee(IDS.ye, '叶芷辰', 8)]),
  entry('de-msmh8r9v-zbrg6n', '2026-08-09', 'xidan', [employee(IDS.chen, '陈文慧', 8), employee(IDS.zuo, '左可翠', 8)]),

  entry('de-msnav95p-lhyqp0', '2026-08-10', 'chaowai', [employee(IDS.zuo, '左可翠', 11.5)]),
  entry('de-msn8w0s0-5ejg4w', '2026-08-10', 'guanshe', [employee(IDS.sui, '隋晓', 11)]),
  entry('de-msnb54as-5298xm', '2026-08-10', 'tongying', [employee(IDS.ye, '叶芷辰', 12)]),
  entry('de-msnbh8rs-dsjypf', '2026-08-10', 'xidan', [employee(IDS.chen, '陈文慧', 12)]),
])

export const P0_R3B_ACTOR = 'system:P0-R3A-R1'
export const P0_R3B_REASON = 'PRE_CUTOVER_LEGACY_FINALIZED_AUTHORITY_REMEDIATION'
