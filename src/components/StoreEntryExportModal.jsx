import { useMemo, useState, useEffect } from 'react'
import * as XLSX from 'xlsx'
import { Check, Download, FileSpreadsheet, X } from 'lucide-react'
import { dailyRows, localEntries } from '../utils/selectors'
import { formatMoney } from '../utils/format'
import { t } from '../utils/text'

function pad(n) {
  return String(n).padStart(2, '0')
}

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function monthStart() {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`
}

function eachDate(start, end) {
  const out = []
  const cur = new Date(`${start}T00:00:00`)
  const last = new Date(`${end}T00:00:00`)
  while (cur <= last) {
    out.push(`${cur.getFullYear()}-${pad(cur.getMonth() + 1)}-${pad(cur.getDate())}`)
    cur.setDate(cur.getDate() + 1)
  }
  return out
}

export default function StoreEntryExportModal({ storeKey, storeName, onClose }) {
  const [startDate, setStartDate] = useState(monthStart)
  const [endDate, setEndDate] = useState(todayStr)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  // Esc 关闭；背景滚动由全局 OverlayStackManager 统一锁定。
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const rows = useMemo(() => {
    if (!startDate || !endDate || startDate > endDate) return []
    const dates = eachDate(startDate, endDate)
    const monthCache = new Map()
    const out = []
    const entries = localEntries()
    for (const full of dates) {
      const month = full.slice(0, 7)
      const d = full.slice(5)
      if (!monthCache.has(month)) monthCache.set(month, dailyRows(month, storeKey))
      const row = monthCache.get(month).find((r) => r.d === d)
      if (!row) continue
      const entry = entries[`${month}|${storeKey}|${d}`]
      const staff = entry && Array.isArray(entry.staff) ? entry.staff : []
      out.push({
        date: full,
        store: storeName || storeKey,
        staff: staff.join('、') || '—',
        inc: row.inc,
        ord: row.ord,
        avg: row.ord > 0 ? row.inc / row.ord : 0,
        source: row.local ? t('本地录入') : t('报表'),
      })
    }
    return out
  }, [startDate, endDate, storeKey, storeName, t])

  const summary = rows.reduce(
    (s, r) => {
      s.inc += r.inc
      s.ord += r.ord
      return s
    },
    { inc: 0, ord: 0 },
  )
  summary.avg = summary.ord > 0 ? summary.inc / summary.ord : 0

  const handleDownload = () => {
    if (!startDate || !endDate) {
      setError(t('请选择起止日期'))
      return
    }
    if (startDate > endDate) {
      setError(t('开始日期不能晚于结束日期'))
      return
    }
    if (rows.length === 0) {
      setError(t('所选日期范围内暂无业绩数据'))
      return
    }
    const header = [t('日期'), t('门店'), t('值班人员'), t('营业收入（元）'), t('订单数（单）'), t('客单价（元）'), t('来源')]
    const body = rows.map((r) => [r.date, r.store, r.staff, r.inc, r.ord, Number(r.avg.toFixed(2)), r.source])
    body.push([t('合计'), '', '', summary.inc, summary.ord, Number(summary.avg.toFixed(2)), ''])
    const ws = XLSX.utils.aoa_to_sheet([header, ...body])
    ws['!cols'] = [{ wch: 12 }, { wch: 14 }, { wch: 22 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 10 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, t('业绩明细'))
    XLSX.writeFile(wb, `budu业绩导出_${startDate.replace(/-/g, '')}-${endDate.replace(/-/g, '')}.xlsx`)
    setDone(true)
    setTimeout(() => setDone(false), 2000)
  }

  return (
    <div data-budu-overlay-root className="budu-overlay-viewport fixed inset-0 z-[95] flex items-center justify-center p-4">
      <div className="budu-overlay-backdrop absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label={t('导出业绩表格')} className="budu-overlay-panel relative flex max-h-[88dvh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200/70 bg-white shadow-lg">
        <div className="budu-overlay-header flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div>
            <h3 className="text-base font-semibold text-slate-900">{t('导出业绩表格')}</h3>
            <p className="mt-1 text-xs text-slate-400">
              {t('门店：{store} · 按所选日期范围导出', { store: storeName || storeKey })}
            </p>
          </div>
          <button
            onClick={onClose}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-50 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            aria-label={t('关闭')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-b border-slate-50 px-5 py-3">
          <label className="flex items-center gap-2 text-[13px] font-medium text-slate-500">
            {t('开始日期')}
            <input type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); setError('') }} className="input w-auto" />
          </label>
          <label className="flex items-center gap-2 text-[13px] font-medium text-slate-500">
            {t('结束日期')}
            <input type="date" value={endDate} onChange={(e) => { setEndDate(e.target.value); setError('') }} className="input w-auto" />
          </label>
          <span className="rounded-lg bg-budu-50 px-2 py-1 text-xs font-semibold text-budu-600">
            {t('{count} 条记录', { count: rows.length })}
          </span>
          {error && <span className="text-xs font-medium text-rose-500">{error}</span>}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {rows.length === 0 ? (
            <div className="empty-state h-48">{t('所选日期范围内暂无业绩数据')}</div>
          ) : (
            <>
              <div className="overflow-x-auto rounded-xl border border-slate-100">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead>
                    <tr className="bg-slate-50/80 text-xs text-slate-400">
                      <th className="px-3 py-2.5 font-semibold">{t('日期')}</th>
                      <th className="px-3 py-2.5 font-semibold">{t('门店')}</th>
                      <th className="px-3 py-2.5 font-semibold">{t('值班人员')}</th>
                      <th className="px-3 py-2.5 font-semibold text-right">{t('营业收入')}</th>
                      <th className="px-3 py-2.5 font-semibold text-right">{t('订单数')}</th>
                      <th className="px-3 py-2.5 font-semibold text-right">{t('客单价')}</th>
                      <th className="px-3 py-2.5 font-semibold">{t('来源')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {rows.map((r) => (
                      <tr key={r.date} className="hover:bg-slate-50">
                        <td className="px-3 py-2.5 font-medium text-slate-700">{r.date}</td>
                        <td className="px-3 py-2.5 text-slate-500">{r.store}</td>
                        <td className="px-3 py-2.5 text-slate-500">{r.staff}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">¥{formatMoney(r.inc)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{r.ord.toLocaleString('zh-CN')}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">¥{r.avg.toFixed(2)}</td>
                        <td className="px-3 py-2.5">
                          <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${r.source === t('本地录入') ? 'bg-budu-50 text-budu-600' : 'bg-slate-100 text-slate-400'}`}>
                            {r.source}
                          </span>
                        </td>
                      </tr>
                    ))}
                    <tr className="bg-slate-50/60 font-semibold text-slate-700">
                      <td className="px-3 py-2.5">{t('合计')}</td>
                      <td className="px-3 py-2.5" />
                      <td className="px-3 py-2.5" />
                      <td className="px-3 py-2.5 text-right tabular-nums">¥{formatMoney(summary.inc)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{summary.ord.toLocaleString('zh-CN')}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">¥{summary.avg.toFixed(2)}</td>
                      <td className="px-3 py-2.5" />
                    </tr>
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <button onClick={onClose} className="btn-secondary px-4 py-2">
            {t('取消')}
          </button>
          <button
            onClick={handleDownload}
            disabled={rows.length === 0}
            className="btn-primary px-4 py-2"
          >
            {done ? <Check className="h-4 w-4" /> : <Download className="h-4 w-4" />}
            {done ? t('已导出') : t('导出 Excel')}
          </button>
        </div>
      </div>
    </div>
  )
}
