import { useEffect, useMemo, useState } from 'react'
import { Download, Eye, X } from 'lucide-react'
import * as XLSX from 'xlsx'
import { getWeekDays } from '../utils/schedule'
import { employeeDailyPayDetail } from '../utils/selectors'
import {
  loadDailyStoreStaffMonth,
  getDailyStoreStaff,
  getDailyStoreStaffMonthState,
  getEntries,
  getDailyPayAdjustments,
  getBigBonuses,
} from '../utils/userData'
import { resolvePayrollCalculation } from '../utils/payrollResolver'
import { t } from '../utils/text'

const inputCls = 'input'

function pad(n) {
  return String(n).padStart(2, '0')
}

function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function r2(v) {
  return Math.round((Number(v) || 0) * 100) / 100
}

function PreviewTable({ rows }) {
  const cols = rows[0] ? Object.keys(rows[0]) : []
  return (
    <div className="max-h-64 overflow-auto rounded-xl border border-slate-100">
      <table className="w-full whitespace-nowrap text-left text-xs">
        <thead className="sticky top-0 bg-slate-50">
          <tr>
            {cols.map((c) => (
              <th key={c} className="px-3 py-2 font-semibold text-slate-500">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {rows.map((row, i) => (
            <tr key={i} className="text-slate-600">
              {cols.map((c) => (
                <td key={c} className="px-3 py-1.5 tabular-nums">
                  {row[c]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * 按起止日期逐日生成明细行。
 * Gate 25 澄清：EMPLOYEE_ID 模式下，考勤存在性由 DailyStoreStaff.employeeId 判定
 * （stableAttendance 按月传入）——只有该员工当日有稳定考勤行才生成明细，杜绝
 * "emp-A 值班而 emp-B 未值班却因同名生成 emp-B 明细"的错误归属；
 * 调整由 employeeDailyPayDetail 按 employeeId 精确（Gate 25 修复），大单奖 Gate 10 已按 id；
 * 计薪工时由 employeeDailyPayDetail 按 employeeId+date+store 通过 tagged union 权威归一化。
 * Gate 26：明细日期 = 考勤 employeeId/date ∪ 稳定调整 employeeId/date（EMPLOYEE_ID 模式）——
 * 仅调整日输出调整独占行（工时 0、不虚构考勤），与 resolver summary 的调整仅日贡献一致。
 */
function buildDetailRows(employees, startDate, endDate, stableAttendance = null) {
  const detailRows = []
  const cursor = new Date(`${startDate}T00:00:00`)
  const end = new Date(`${endDate}T00:00:00`)
  const attendanceByEmpDate = new Map()
  if (Array.isArray(stableAttendance)) {
    for (const row of stableAttendance) {
      if (!row.employeeId) continue
      attendanceByEmpDate.set(`${row.employeeId}|${String(row.date || '').slice(0, 10)}`, true)
    }
  }
  // Gate 26：稳定调整 employeeId/date 门（仅 EMPLOYEE_ID 模式；legacy NULL 调整不进入）
  const adjustmentByEmpDate = new Map()
  if (Array.isArray(stableAttendance)) {
    for (const row of getDailyPayAdjustments()) {
      if (!row.employeeId) continue
      adjustmentByEmpDate.set(`${row.employeeId}|${String(row.date || '').slice(0, 10)}`, true)
    }
  }
  while (cursor <= end) {
    const date = toDateStr(cursor)
    const monthKey = date.slice(0, 7)
    const day = date.slice(5)
    for (const emp of employees) {
      // EMPLOYEE_ID 稳定模式：考勤 ∪ 稳定调整均无 → 不生成明细（不按 name 猜测考勤）
      if (stableAttendance && emp.id) {
        const hasAttendance = attendanceByEmpDate.has(`${emp.id}|${date}`)
        const hasAdjustment = adjustmentByEmpDate.has(`${emp.id}|${date}`)
        if (!hasAttendance && !hasAdjustment) continue
      }
      const detail = employeeDailyPayDetail(monthKey, day, emp.name, emp.id, stableAttendance)
      if (!detail) continue
      const typeLabel = emp.type === 'fulltime' ? '全职人员' : '兼职人员'
      if (detail.rows.length === 0 && detail.totals.payAdjustment) {
        // Gate 26：仅调整日——不虚构考勤/门店，输出调整独占行（自动工资 0、工时 0、原因与最终工资来自调整）
        detailRows.push({
          日期: date,
          员工编号: emp.employeeNo || '',
          员工姓名: emp.name,
          类型: typeLabel,
          门店: '',
          '营业额(元)': 0,
          订单: 0,
          '计薪工时(h)': 0,
          工时来源: 'ADJUSTMENT_ONLY',
          '基础时薪(元/h)': 0,
          '基础工资(元)': 0,
          '提成时薪(元/h)': 0,
          '业绩提成(元)': 0,
          '调货补贴(元)': 0,
          '大单奖(元)': 0,
          '自动工资(元)': 0,
          '薪资调整(元)': r2(detail.totals.salaryAdjustment),
          调整原因: detail.totals.payAdjustment.reason || '',
          '最终工资(元)': r2(detail.totals.pay),
        })
        continue
      }
      for (const [rowIndex, row] of detail.rows.entries()) {
        detailRows.push({
          日期: date,
          员工编号: emp.employeeNo || '',
          员工姓名: emp.name,
          类型: typeLabel,
          门店: row.storeName,
          '营业额(元)': r2(row.revenue),
          订单: r2(row.orders),
          '计薪工时(h)': r2(row.payableHours),
          工时来源: row.payableHoursSource,
          '基础时薪(元/h)': r2(row.baseRate),
          '基础工资(元)': r2(row.basePay),
          '提成时薪(元/h)': r2(row.commissionRate),
          '业绩提成(元)': r2(row.commission),
          '调货补贴(元)': r2(row.transferSubsidy),
          '大单奖(元)': r2(row.bigBonus),
          '自动工资(元)': r2(row.total),
          '薪资调整(元)': rowIndex === 0 ? r2(detail.totals.salaryAdjustment) : 0,
          调整原因: rowIndex === 0 && detail.totals.payAdjustment ? detail.totals.payAdjustment.reason || '' : '',
          '最终工资(元)': rowIndex === 0 ? r2(detail.totals.pay) : '',
        })
      }
    }
    cursor.setDate(cursor.getDate() + 1)
  }
  return detailRows
}

/**
 * Gate 25：汇总行构建——EMPLOYEE_ID 模式由 resolver payroll（employeeId 精确）生成，
 * 每员工一行；LEGACY 唯一名由 legacy 行兼容；重名已在 runBuild 阻断。
 */
function buildSummaryRows(resolverResult, employees, mode) {
  const empById = new Map(employees.map((e) => [e.id, e]))
  if (mode === 'EMPLOYEE_ID') {
    return (resolverResult.payroll.employees || [])
      .map((rec) => {
        const emp = empById.get(rec.employeeId)
        return {
          员工编号: (emp && emp.employeeNo) || '',
          员工姓名: (emp && emp.name) || rec.displayName || '',
          类型: emp ? (emp.type === 'fulltime' ? '全职人员' : '兼职人员') : '',
          期间值班门店: Array.isArray(rec.storesWorked) ? rec.storesWorked.map((s) => (emp && emp.storeName) || s).filter((v, i, a) => a.indexOf(v) === i).join('、') : '',
          出勤天数: rec.days || 0,
          '营业额(元)': r2(rec.workedRevenue),
          订单: r2(rec.orders),
          '计薪工时(h)': r2(rec.payableHours),
          '基础工资(元)': r2(rec.basePay),
          '业绩提成(元)': r2(rec.commission),
          '调货补贴(元)': r2(rec.transferSubsidy),
          '大单奖(元)': r2(rec.bigBonus),
          '自动工资(元)': r2(rec.salary - rec.salaryAdjustment),
          '薪资调整(元)': r2(rec.salaryAdjustment),
          '工资合计(元)': r2(rec.salary),
        }
      })
      .filter((row) => row.员工姓名)
  }
  // LEGACY：resolver 的 legacy 行（name 键，唯一名兼容；重名已阻断）
  return (resolverResult.payroll.employees || []).map((rec) => ({
    员工编号: '',
    员工姓名: rec.name || '',
    类型: '',
    期间值班门店: Array.isArray(rec.stores) ? rec.stores.join('、') : '',
    出勤天数: rec.workedDays || 0,
    '营业额(元)': r2(rec.workedRevenue),
    订单: r2(rec.orders || 0),
    '计薪工时(h)': r2(rec.hours),
    '基础工资(元)': r2(rec.basePay),
    '业绩提成(元)': r2(rec.commission),
    '调货补贴(元)': r2(rec.transferSubsidy),
    '大单奖(元)': r2(rec.bigBonus),
    '自动工资(元)': r2((rec.salary || 0) - (rec.salaryAdjustment || 0)),
    '薪资调整(元)': r2(rec.salaryAdjustment),
    '工资合计(元)': r2(rec.salary),
  }))
}

export default function ExportSalaryModal({ employees, month, day, weekStart, onClose }) {
  const defaults = useMemo(() => {
    if (weekStart) {
      const days = getWeekDays(weekStart)
      return { start: weekStart, end: days[6].date }
    }
    if (day) {
      const dd = String(day).includes('-') ? day.slice(3) : day
      const date = `${month}-${dd}`
      return { start: date, end: date }
    }
    const daysInMonth = new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate()
    return { start: `${month}-01`, end: `${month}-${pad(daysInMonth)}` }
  }, [month, day, weekStart])

  const [startDate, setStartDate] = useState(defaults.start)
  const [endDate, setEndDate] = useState(defaults.end)
  // Gate 25：选择身份 = Employee.id（同名员工独立可选/独立导出）
  const [selected, setSelected] = useState(() => new Set(employees.map((e) => e.id)))
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(null)
  const [previewTab, setPreviewTab] = useState('detail')
  const [exportMode, setExportMode] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const runBuild = async () => {
    if (!startDate || !endDate) {
      setError(t('请选择开始和结束日期'))
      return null
    }
    if (startDate > endDate) {
      setError(t('开始日期不能晚于结束日期'))
      return null
    }
    if (selected.size === 0) {
      setError(t('请至少选择一名员工'))
      return null
    }
    const selectedEmployees = employees.filter((e) => selected.has(e.id))
    if (selectedEmployees.length === 0) {
      setError(t('请至少选择一名员工'))
      return null
    }
    setLoading(true)
    setError('')
    try {
      // Gate 25：显式加载所选月份考勤 → 统一 resolver（唯一计算决策点）
      const monthKey = startDate.slice(0, 7)
      await loadDailyStoreStaffMonth(monthKey)
      const monthState = getDailyStoreStaffMonthState(monthKey)
      if (monthState.status !== 'loaded' || !monthState.hasPayload) {
        setError(t('工资数据尚未加载，请重新加载'))
        setLoading(false)
        return null
      }
      const resolverResult = resolvePayrollCalculation({
        month: monthKey,
        dailyEntries: getEntries(),
        dailyStoreStaffRows: getDailyStoreStaff(monthKey),
        dailyPayAdjustments: getDailyPayAdjustments(),
        bigOrderBonuses: getBigBonuses(),
        employees: selectedEmployees,
        users: [],
      })
      if (resolverResult.mode === 'EMPLOYEE_ID' && !resolverResult.calculationReady) {
        setError(t('工资数据尚未加载完整，请重新加载'))
        setLoading(false)
        return null
      }
      setExportMode(resolverResult.mode === 'EMPLOYEE_ID' ? 'EMPLOYEE_ID' : 'LEGACY')
      // LEGACY 重名阻断：目录中同名员工 >1 且被选中 → 受控失败（绝不猜测归属）
      if (resolverResult.mode === 'LEGACY') {
        const nameCounts = new Map()
        for (const e of selectedEmployees) nameCounts.set(e.name, (nameCounts.get(e.name) || 0) + 1)
        const ambiguousSelected = selectedEmployees.some((e) => (nameCounts.get(e.name) || 0) > 1)
        if (ambiguousSelected) {
          setError(t('存在同名员工的历史兼容工资，无法确定具体员工归属，请先处理身份数据后再导出'))
          setLoading(false)
          return null
        }
      }
      // Gate 25 澄清：EMPLOYEE_ID 模式明细行的考勤归属由该月 DailyStoreStaff.employeeId 判定
      const stableAttendance = resolverResult.mode === 'EMPLOYEE_ID' ? getDailyStoreStaff(monthKey) : null
      const detailRows = buildDetailRows(selectedEmployees, startDate, endDate, stableAttendance)
      const summaryRows = buildSummaryRows(resolverResult, selectedEmployees, resolverResult.mode)
      if (detailRows.length === 0 && summaryRows.length === 0) {
        setError(t('所选日期区间暂无薪酬数据'))
        setLoading(false)
        return null
      }
      setLoading(false)
      return { detailRows, summaryRows }
    } catch (e) {
      setError(t(e.message || '导出失败'))
      setLoading(false)
      return null
    }
  }

  const downloadRows = (rows) => {
    const { detailRows, summaryRows } = rows
    const wb = XLSX.utils.book_new()
    const wsDetail = XLSX.utils.json_to_sheet(detailRows)
    const wsSummary = XLSX.utils.json_to_sheet(summaryRows)
    wsDetail['!cols'] = [
      { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 14 }, { wch: 10 }, { wch: 8 },
      { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 },
    ]
    wsSummary['!cols'] = [
      { wch: 12 }, { wch: 10 }, { wch: 24 }, { wch: 10 }, { wch: 10 }, { wch: 8 },
      { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 },
    ]
    XLSX.utils.book_append_sheet(wb, wsDetail, '薪酬明细')
    XLSX.utils.book_append_sheet(wb, wsSummary, '薪酬汇总')
    const fileStart = startDate.replaceAll('-', '')
    const fileEnd = endDate.replaceAll('-', '')
    XLSX.writeFile(wb, `budu薪酬导出_${fileStart}-${fileEnd}.xlsx`)
    onClose()
  }

  const handlePreview = async () => {
    const rows = await runBuild()
    if (rows) {
      setPreview(rows)
      setPreviewTab('detail')
      setError('')
    }
  }

  const handleExport = async () => {
    const rows = await runBuild()
    if (rows) downloadRows(rows)
  }

  const toggleEmployee = (id) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setError('')
  }

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative max-h-[88vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 shadow-lg">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-bold text-slate-800">{t('导出表格')}</h3>
            <p className="mt-1 text-xs text-slate-400">{t('选择日期区间，导出员工薪酬信息')}</p>
          </div>
          <button
            onClick={onClose}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-50 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            aria-label={t('关闭')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {preview ? (
          <div className="mt-5 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-xl bg-slate-100 p-1 text-xs font-semibold">
                <button
                  onClick={() => setPreviewTab('detail')}
                  className={`rounded-lg px-3 py-1.5 transition ${
                    previewTab === 'detail' ? 'bg-white text-budu-600 shadow-sm' : 'text-slate-500'
                  }`}
                >
                  {t('薪酬明细')}（{preview.detailRows.length}）
                </button>
                <button
                  onClick={() => setPreviewTab('summary')}
                  className={`rounded-lg px-3 py-1.5 transition ${
                    previewTab === 'summary' ? 'bg-white text-budu-600 shadow-sm' : 'text-slate-500'
                  }`}
                >
                  {t('薪酬汇总')}（{preview.summaryRows.length}）
                </button>
              </div>
              <span className="text-xs text-slate-400">
                {t('预览导出内容，确认后下载')}
              </span>
              {exportMode === 'EMPLOYEE_ID' && (
                <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-600">{t('稳定计算')}</span>
              )}
              {exportMode === 'LEGACY' && (
                <span className="rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-600">{t('兼容计算')}</span>
              )}
            </div>
            {previewTab === 'detail' ? (
              <PreviewTable rows={preview.detailRows} />
            ) : (
              <PreviewTable rows={preview.summaryRows} />
            )}
            <div className="grid grid-cols-2 gap-2.5">
              <button
                onClick={() => setPreview(null)}
                className="rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-200"
              >
                {t('返回修改')}
              </button>
              <button
                onClick={() => downloadRows(preview)}
                className="flex items-center justify-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
              >
                <Download className="h-4 w-4" />
                {t('导出 Excel')}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-5 space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-slate-500">{t('开始日期')}</label>
            <input type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); setError('') }} className={inputCls} />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-slate-500">{t('结束日期')}</label>
            <input type="date" value={endDate} onChange={(e) => { setEndDate(e.target.value); setError('') }} className={inputCls} />
          </div>
          <p className="rounded-xl bg-budu-50/60 px-3 py-2 text-xs text-budu-600">
            {t('默认区间：{start} ~ {end}', { start: defaults.start, end: defaults.end })}
          </p>
          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <label className="text-xs font-semibold text-slate-500">
                {t('选择人员')}
                <span className="ml-1.5 font-normal text-slate-400">
                  {t('已选 {n}/{total}', { n: selected.size, total: employees.length })}
                </span>
              </label>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => {
                    setSelected(new Set(employees.map((e) => e.id)))
                    setError('')
                  }}
                  className="rounded-lg bg-budu-50 px-2 py-1 text-[11px] font-semibold text-budu-600 transition hover:bg-budu-100"
                >
                  {t('全选')}
                </button>
                <button
                  onClick={() => {
                    setSelected(new Set())
                    setError('')
                  }}
                  className="rounded-lg bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-500 transition hover:bg-slate-200"
                >
                  {t('清空')}
                </button>
              </div>
            </div>
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-xl border border-slate-100 bg-white p-2">
              {employees.map((emp) => (
                <label
                  key={emp.id}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-budu-50/60"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(emp.id)}
                    onChange={() => toggleEmployee(emp.id)}
                    className="h-4 w-4 shrink-0 accent-budu-500"
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-700">
                    {emp.name}
                    {emp.employeeNo ? <span className="ml-1 text-[11px] font-normal text-slate-400">{emp.employeeNo}</span> : null}
                  </span>
                  <span
                    className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                      emp.type === 'fulltime'
                        ? 'bg-budu-500 text-white'
                        : 'bg-slate-100 text-slate-500'
                    }`}
                  >
                    {emp.type === 'fulltime' ? t('全职') : t('兼职')}
                  </span>
                  <span className="shrink-0 max-w-24 truncate text-[11px] text-slate-400">{emp.storeName}</span>
                </label>
              ))}
            </div>
          </div>
          {/* Gate 25：模式可见性 + loading */}
          {exportMode === 'EMPLOYEE_ID' && (
            <p className="rounded-xl bg-emerald-50/70 px-3 py-2 text-xs font-semibold text-emerald-600">
              {t('稳定计算 · 按员工身份精确导出')}
            </p>
          )}
          {exportMode === 'LEGACY' && (
            <p className="rounded-xl bg-amber-50/70 px-3 py-2 text-xs font-semibold text-amber-600">
              {t('兼容计算 · 按历史姓名快照导出')}
            </p>
          )}
          {loading && <p className="text-xs font-medium text-slate-400">{t('加载中…')}</p>}
          {error && <p className="text-xs font-medium text-rose-500">{error}</p>}
          <div className="grid grid-cols-3 gap-2.5">
            <button
              onClick={onClose}
              className="rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-200"
            >
              {t('取消')}
            </button>
            <button
              onClick={handlePreview}
              className="flex items-center justify-center gap-1.5 rounded-xl bg-sky-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
            >
              <Eye className="h-4 w-4" />
              {t('预览')}
            </button>
            <button
              onClick={handleExport}
              className="flex items-center justify-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
            >
              <Download className="h-4 w-4" />
              {t('导出 Excel')}
            </button>
          </div>
          </div>
        )}
      </div>
    </div>
  )
}
