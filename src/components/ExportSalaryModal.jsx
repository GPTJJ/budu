import { useEffect, useMemo, useState } from 'react'
import { Download, Eye, X } from 'lucide-react'
import * as XLSX from 'xlsx'
import {
  loadDailyStoreStaffRange,
  getDailyStoreStaffRange,
  getDailyStoreStaffRangeState,
  getEntries,
  getDailyPayAdjustments,
  getBigBonuses,
  getStores,
} from '../utils/userData'
import { resolvePayrollCalculation } from '../utils/payrollResolver'
import { addBusinessDays, monthEnd, resolvePayrollPeriod } from '../utils/payrollPeriod'
import { buildPayrollExportRows } from '../utils/payrollExport'
import { t } from '../utils/text'

const inputCls = 'input'

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

export default function ExportSalaryModal({ employees, month, day, weekStart, onClose }) {
  const defaults = useMemo(() => {
    if (weekStart) {
      return { start: weekStart, end: addBusinessDays(weekStart, 6), periodType: 'week' }
    }
    if (day) {
      const dd = String(day).includes('-') ? day.slice(3) : day
      const date = `${month}-${dd}`
      return { start: date, end: date, periodType: 'custom' }
    }
    return { start: `${month}-01`, end: monthEnd(month), periodType: 'month' }
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
      const unchangedDefault = startDate === defaults.start && endDate === defaults.end
      const requestedType = unchangedDefault ? defaults.periodType : 'custom'
      const period = resolvePayrollPeriod(
        requestedType === 'month'
          ? { periodType: 'month', periodKey: startDate.slice(0, 7), periodStart: startDate, periodEnd: endDate }
          : requestedType === 'week'
            ? { periodType: 'week', periodKey: startDate, periodStart: startDate, periodEnd: endDate }
            : { periodType: 'custom', periodStart: startDate, periodEnd: endDate },
      )
      if (!period.valid) {
        setError(t(period.detail || '日期范围不正确'))
        setLoading(false)
        return null
      }
      await loadDailyStoreStaffRange(period.periodStart, period.periodEnd)
      const rangeState = getDailyStoreStaffRangeState(period.periodStart, period.periodEnd)
      if (!rangeState.complete) {
        setError(t('工资数据尚未加载，请重新加载'))
        setLoading(false)
        return null
      }
      const storeNames = Object.fromEntries(getStores().map((store) => [store.key, store.name]))
      const resolverResult = resolvePayrollCalculation({
        ...period,
        dailyEntries: getEntries(),
        dailyStoreStaffRows: getDailyStoreStaffRange(period.periodStart, period.periodEnd),
        dailyPayAdjustments: getDailyPayAdjustments(),
        bigOrderBonuses: getBigBonuses(),
        employees: selectedEmployees,
        users: [],
        storeNames,
      })
      if (resolverResult.mode !== 'EMPLOYEE_ID' || !resolverResult.calculationReady) {
        setError(t('工资权威数据不完整，无法导出'))
        setLoading(false)
        return null
      }
      setExportMode('EMPLOYEE_ID')
      const { detailRows, summaryRows } = buildPayrollExportRows(resolverResult, selectedEmployees, selected)
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
    <div data-budu-overlay-root className="fixed inset-0 z-[95] flex items-center justify-center p-4">
      <div className="budu-overlay-backdrop absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label={t('导出工资表')} className="budu-overlay-scroll relative max-h-[88dvh] w-full max-w-md rounded-2xl bg-white p-6 shadow-lg">
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
            <label htmlFor="payroll-export-start" className="mb-1.5 block text-xs font-semibold text-slate-500">{t('开始日期')}</label>
            <input id="payroll-export-start" type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); setError('') }} className={inputCls} />
          </div>
          <div>
            <label htmlFor="payroll-export-end" className="mb-1.5 block text-xs font-semibold text-slate-500">{t('结束日期')}</label>
            <input id="payroll-export-end" type="date" value={endDate} onChange={(e) => { setEndDate(e.target.value); setError('') }} className={inputCls} />
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
