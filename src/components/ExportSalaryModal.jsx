import { useEffect, useMemo, useState } from 'react'
import { Download, X } from 'lucide-react'
import * as XLSX from 'xlsx'
import { getWeekDays } from '../utils/schedule'
import { employeeDailyPayDetail } from '../utils/selectors'
import { useI18n } from '../i18n'

const inputCls =
  'w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-budu-400 focus:ring-2 focus:ring-budu-100'

function pad(n) {
  return String(n).padStart(2, '0')
}

function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function r2(v) {
  return Math.round((Number(v) || 0) * 100) / 100
}

/** 按起止日期逐日生成明细与汇总行（口径与工资明细弹窗一致） */
function buildRows(employees, startDate, endDate) {
  const detailRows = []
  const summaryMap = new Map()
  const cursor = new Date(`${startDate}T00:00:00`)
  const end = new Date(`${endDate}T00:00:00`)
  while (cursor <= end) {
    const date = toDateStr(cursor)
    const monthKey = date.slice(0, 7)
    const day = date.slice(5)
    for (const emp of employees) {
      const detail = employeeDailyPayDetail(monthKey, day, emp.name)
      if (!detail) continue
      const typeLabel = emp.type === 'fulltime' ? '全职人员' : '兼职人员'
      let rec = summaryMap.get(emp.name)
      if (!rec) {
        rec = {
          name: emp.name,
          typeLabel,
          stores: new Set(),
          workedDays: 0,
          inc: 0,
          ord: 0,
          hours: 0,
          basePay: 0,
          commission: 0,
          bigBonus: 0,
          pay: 0,
        }
        summaryMap.set(emp.name, rec)
      }
      rec.workedDays += 1
      rec.inc += detail.totals.inc
      rec.ord += detail.totals.ord
      rec.hours += detail.totals.hours
      rec.basePay += detail.totals.basePay
      rec.commission += detail.totals.commission
      rec.bigBonus += detail.totals.bigBonus
      rec.pay += detail.totals.pay
      for (const row of detail.rows) {
        rec.stores.add(row.storeName)
        detailRows.push({
          日期: date,
          员工姓名: emp.name,
          类型: typeLabel,
          门店: row.storeName,
          '营业额(元)': r2(row.revenue),
          订单: r2(row.orders),
          '工时(h)': r2(row.hours),
          '基础时薪(元/h)': r2(row.baseRate),
          '基础工资(元)': r2(row.basePay),
          '提成时薪(元/h)': r2(row.commissionRate),
          '业绩提成(元)': r2(row.commission),
          '大单奖(元)': r2(row.bigBonus),
          '当日工资(元)': r2(row.total),
        })
      }
    }
    cursor.setDate(cursor.getDate() + 1)
  }
  const summaryRows = [...summaryMap.values()].map((rec) => ({
    员工姓名: rec.name,
    类型: rec.typeLabel,
    期间值班门店: rec.stores.size > 0 ? [...rec.stores].join('、') : '',
    出勤天数: rec.workedDays,
    '营业额(元)': r2(rec.inc),
    订单: r2(rec.ord),
    '工时(h)': r2(rec.hours),
    '基础工资(元)': r2(rec.basePay),
    '业绩提成(元)': r2(rec.commission),
    '大单奖(元)': r2(rec.bigBonus),
    '工资合计(元)': r2(rec.pay),
  }))
  return { detailRows, summaryRows }
}

export default function ExportSalaryModal({ employees, month, day, weekStart, onClose }) {
  const { t } = useI18n()
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
  const [selected, setSelected] = useState(() => new Set(employees.map((e) => e.name)))
  const [error, setError] = useState('')

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleExport = () => {
    if (!startDate || !endDate) {
      setError(t('请选择开始和结束日期'))
      return
    }
    if (startDate > endDate) {
      setError(t('开始日期不能晚于结束日期'))
      return
    }
    if (selected.size === 0) {
      setError(t('请至少选择一名员工'))
      return
    }
    const selectedEmployees = employees.filter((e) => selected.has(e.name))
    const { detailRows, summaryRows } = buildRows(selectedEmployees, startDate, endDate)
    if (detailRows.length === 0) {
      setError(t('所选日期区间暂无薪酬数据'))
      return
    }
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

  const toggleEmployee = (name) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
    setError('')
  }

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative max-h-[88vh] w-full max-w-md overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl">
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
                    setSelected(new Set(employees.map((e) => e.name)))
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
                  key={emp.name}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-budu-50/60"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(emp.name)}
                    onChange={() => toggleEmployee(emp.name)}
                    className="h-4 w-4 shrink-0 accent-budu-500"
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-700">{emp.name}</span>
                  <span
                    className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                      emp.type === 'fulltime'
                        ? 'bg-gradient-to-r from-budu-500 to-grape-500 text-white'
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
          {error && <p className="text-xs font-medium text-rose-500">{error}</p>}
          <div className="grid grid-cols-2 gap-2.5">
            <button
              onClick={onClose}
              className="rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-200"
            >
              {t('取消')}
            </button>
            <button
              onClick={handleExport}
              className="flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-emerald-200/60 transition hover:opacity-90"
            >
              <Download className="h-4 w-4" />
              {t('导出 Excel')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
