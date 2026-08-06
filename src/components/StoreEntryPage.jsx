import { useEffect, useState } from 'react'
import { ArrowLeft, Building2, CalendarDays, ChevronDown, Save, Trash2, Users } from 'lucide-react'
import { allStores, dailyRows, monthLabel, saveLocalEntry, deleteLocalEntry, localEntries, employeeList } from '../utils/selectors'
import { formatMoney } from '../utils/format'
import { useI18n } from '../i18n'

function pad(n) {
  return String(n).padStart(2, '0')
}

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const inputCls =
  'w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-budu-400 focus:ring-2 focus:ring-budu-100'

function Field({ label, icon: Icon, children }) {
  return (
    <div className="block">
      <span className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-slate-500">
        {Icon && <Icon className="h-3.5 w-3.5 text-budu-400" />}
        {label}
      </span>
      {children}
    </div>
  )
}

/** 值班人员多选（按门店优先排序） */
function StaffPicker({ value, onChange }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const all = employeeList('all')
  const sorted = [...all].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))

  const toggle = (name) => {
    onChange(value.includes(name) ? value.filter((n) => n !== name) : [...value, name])
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`${inputCls} flex min-h-[38px] flex-wrap items-center gap-1 text-left`}
      >
        {value.length === 0 ? (
          <span className="text-slate-400">{t('选择值班人员')}</span>
        ) : (
          value.map((n) => (
            <span key={n} className="rounded-md bg-budu-50 px-1.5 py-0.5 text-xs font-semibold text-budu-600">
              {n}
            </span>
          ))
        )}
        <ChevronDown className={`ml-auto h-3.5 w-3.5 shrink-0 text-slate-300 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-40 mt-1 w-64 rounded-2xl border border-slate-100 bg-white p-2 shadow-2xl">
            <p className="px-2 py-1.5 text-[11px] font-semibold text-slate-300">{t('点击姓名多选值班人员')}</p>
            {sorted.map((emp) => {
              const checked = value.includes(emp.name)
              return (
                <button
                  key={emp.name}
                  type="button"
                  onClick={() => toggle(emp.name)}
                  className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs transition ${
                    checked ? 'bg-budu-50' : 'hover:bg-slate-50'
                  }`}
                >
                  <span
                    className={`grid h-4 w-4 shrink-0 place-items-center rounded border text-[10px] font-bold ${
                      checked ? 'border-budu-500 bg-budu-500 text-white' : 'border-slate-200 text-transparent'
                    }`}
                  >
                    ✓
                  </span>
                  <span className="font-semibold text-slate-700">{emp.name}</span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

export default function StoreEntryPage({ onBack }) {
  const { t } = useI18n()
  const [store, setStore] = useState(() => (allStores()[0] ? allStores()[0].key : ''))
  const [staff, setStaff] = useState([])
  const [date, setDate] = useState(todayStr)
  const [inc, setInc] = useState('')
  const [ord, setOrd] = useState('')
  const [version, setVersion] = useState(0)
  const [savedTip, setSavedTip] = useState('')

  // 日期自动归属对应月份（本地数据按 月份|门店|MM-DD 存储）
  const month = date && date.length >= 7 ? date.slice(0, 7) : '2026-07'

  const storeInfo = allStores().find((s) => s.key === store)

  // 与首页共用同一数据源：报表 + 本地录入自动合并，保存后实时联动
  const rows = dailyRows(month, store)

  // 选中已有数据的日期时，自动填入表单（便于修改）
  useEffect(() => {
    const row = dailyRows(month, store).find((r) => r.d === date.slice(5))
    if (row) {
      setInc(String(row.inc))
      setOrd(String(row.ord))
      const entry = localEntries()[`${month}|${store}|${date.slice(5)}`]
      setStaff(entry && Array.isArray(entry.staff) ? entry.staff : [])
    }
  }, [date, month, store, version])

  const summary = {
    inc: rows.reduce((s, r) => s + r.inc, 0),
    ord: rows.reduce((s, r) => s + r.ord, 0),
    localCount: rows.filter((r) => r.local).length,
  }
  summary.avgOrder = summary.ord > 0 ? summary.inc / summary.ord : 0

  const handleSave = () => {
    if (!date || (!inc && !ord)) {
      setSavedTip(t('请至少填写营业收入或订单数'))
      setTimeout(() => setSavedTip(''), 2000)
      return
    }
    saveLocalEntry(month, store, date.slice(5), {
      inc: Number(inc) || 0,
      ord: Number(ord) || 0,
      staff,
    })
    setVersion((v) => v + 1)
    setSavedTip(
      t('已保存到本地 ✓ 值班人员：{staff}', {
        staff: staff.length > 0 ? staff.join('、') : t('未选择'),
      }),
    )
    setTimeout(() => setSavedTip(''), 2500)
  }

  const handleDelete = (d) => {
    deleteLocalEntry(month, store, d)
    setVersion((v) => v + 1)
  }

  return (
    <div className="space-y-6">
      {/* 页面头部 */}
      <div className="flex flex-wrap items-center gap-4">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-2xl bg-white px-3.5 py-2.5 text-sm font-medium text-slate-500 shadow-card transition hover:text-budu-600"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('返回首页')}
        </button>
        <div>
          <h2 className="text-xl font-bold text-slate-800">{t('门店业绩录入')}</h2>
          <p className="mt-0.5 text-[13px] text-slate-400">
            {t('选择门店、值班人员与日期，录入营业收入/订单数；保存后首页与人员管理实时联动')}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="rounded-lg bg-budu-50 px-2.5 py-1 text-xs font-semibold text-budu-600">
            {t('本地录入 {count} 天', { count: summary.localCount })}
          </span>
          <span className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-500">
            {t('合计 {count} 天', { count: rows.length })}
          </span>
        </div>
      </div>

      {/* 录入表单 */}
      <div className="card p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
          <Field label={t('门店')} icon={Building2}>
            <select value={store} onChange={(e) => setStore(e.target.value)} className={inputCls}>
              {allStores().map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label={t('值班人员')} icon={Users}>
            <StaffPicker value={staff} onChange={setStaff} />
          </Field>

          <Field label={t('日期')} icon={CalendarDays}>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
          </Field>

          <Field label={t('营业收入（元）')}>
            <input type="number" step="0.01" min="0" value={inc} onChange={(e) => setInc(e.target.value)} placeholder="0.00" className={inputCls} />
          </Field>

          <Field label={t('订单数（单）')}>
            <input type="number" step="1" min="0" value={ord} onChange={(e) => setOrd(e.target.value)} placeholder="0" className={inputCls} />
          </Field>

          <div className="flex items-end sm:col-span-2">
            <button
              onClick={handleSave}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-budu-500 to-grape-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-budu-200/60 transition hover:opacity-90"
            >
              <Save className="h-4 w-4" />
              {t('保存')}
            </button>
          </div>
        </div>
        <p
          className={`mt-3 text-xs font-medium transition ${
            savedTip === t('请至少填写营业收入或订单数') ? 'text-amber-500' : 'text-emerald-500'
          }`}
        >
          {savedTip ||
            t('当前录入：{month} · {store} · 选择日期自动归属对应月份', {
              month: monthLabel(month),
              store: storeInfo ? storeInfo.name : '',
            })}
        </p>
      </div>

      {/* 业绩明细表 */}
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-4">
          <h3 className="text-[15px] font-bold text-slate-800">{t('业绩明细')}</h3>
          <span className="rounded-lg bg-budu-50 px-2 py-0.5 text-xs font-semibold text-budu-600">
            {monthLabel(month)} · {storeInfo ? storeInfo.name : ''}
          </span>
          <div className="ml-auto flex gap-4 text-xs text-slate-400">
            <span>
              {t('合计收入')} <b className="text-slate-600">¥{formatMoney(summary.inc)}</b>
            </span>
            <span>
              {t('合计订单')} <b className="text-slate-600">{summary.ord.toLocaleString('zh-CN')}</b>
            </span>
            <span>
              {t('客单价')} <b className="text-slate-600">¥{summary.avgOrder.toFixed(2)}</b>
            </span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead>
              <tr className="bg-slate-50/80 text-xs text-slate-400">
                <th className="px-5 py-3 font-semibold">{t('日期')}</th>
                <th className="px-4 py-3 font-semibold">{t('值班人员')}</th>
                <th className="px-4 py-3 font-semibold">{t('营业收入')}</th>
                <th className="px-4 py-3 font-semibold">{t('订单数')}</th>
                <th className="px-4 py-3 font-semibold">{t('客单价')}</th>
                <th className="px-4 py-3 font-semibold">{t('来源')}</th>
                <th className="px-4 py-3 font-semibold text-right">{t('操作')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const entry = localEntries()[`${month}|${store}|${r.d}`]
                const staffNames = entry && Array.isArray(entry.staff) ? entry.staff : []
                return (
                  <tr key={r.d} className="border-t border-slate-50 transition hover:bg-budu-50/40">
                    <td className="px-5 py-3 font-medium text-slate-700">{r.d}</td>
                    <td className="px-4 py-3">
                      {staffNames.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {staffNames.map((n) => (
                            <span key={n} className="rounded-md bg-budu-50 px-1.5 py-0.5 text-[11px] font-semibold text-budu-600">
                              {n}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-slate-600">¥{formatMoney(r.inc)}</td>
                    <td className="px-4 py-3 tabular-nums text-slate-600">{r.ord.toLocaleString('zh-CN')}</td>
                    <td className="px-4 py-3 tabular-nums text-slate-600">¥{r.ord > 0 ? (r.inc / r.ord).toFixed(2) : '0.00'}</td>
                    <td className="px-4 py-3">
                      {r.local ? (
                        <span className="rounded-md bg-grape-50 px-1.5 py-0.5 text-[10px] font-bold text-grape-600">
                          {t('本地录入')}
                        </span>
                      ) : (
                        <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-400">
                          {t('报表')}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {r.local && (
                        <button
                          onClick={() => handleDelete(r.d)}
                          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-rose-400 transition hover:bg-rose-50 hover:text-rose-500"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          {t('删除')}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan="7" className="grid place-items-center py-12 text-sm text-slate-300">
                    {t('暂无数据，请在左侧表单录入')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-center text-[11px] text-slate-300">
        {t('录入数据保存在浏览器 localStorage 中，刷新不丢失；首页 KPI、排行、趋势与人员管理板块实时联动')}
      </p>
    </div>
  )
}
