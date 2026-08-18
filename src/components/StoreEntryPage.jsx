import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, Building2, CalendarDays, CheckCircle2, ChevronDown, FileSpreadsheet, Pencil, Save, ShieldAlert, Trash2, Users, WalletCards,
} from 'lucide-react'
import { allStores, dailyRows, monthLabel, localEntries, deleteLocalEntry, employeeList } from '../utils/selectors'
import { formatMoney } from '../utils/format'
import { centsToYuan, formatCents, yuanToCents } from '../utils/pos'
import { api } from '../utils/api'
import { loadUserData } from '../utils/userData'
import { dutyHours } from '../utils/payroll'
import { useI18n } from '../i18n'
import StoreEntryExportModal from './StoreEntryExportModal'

function pad(n) {
  return String(n).padStart(2, '0')
}

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const inputCls = 'input'

function staffIdFor(storeKey, name) {
  const encoded = [...String(name)].map((ch) => ch.codePointAt(0).toString(36)).join('')
  return `st-${storeKey}-${encoded.slice(0, 64)}`
}

function Field({ label, icon: Icon, children }) {
  return (
    <div className="block">
      <span className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-slate-500">
        {Icon && <Icon className="h-3.5 w-3.5 text-budu-600" />}
        {label}
      </span>
      {children}
    </div>
  )
}

function StaffMultiSelect({ employees, selectedIds, storeKey, onToggle, disabled }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative max-w-md">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className={`${inputCls} flex min-h-[38px] w-full items-center gap-1 text-left`}
      >
        <Users className="h-4 w-4 shrink-0 text-budu-600" />
        <span className="flex-1 truncate text-sm">{selectedIds.length === 0 ? '选择值班人员（可多选）' : `已选 ${selectedIds.length} 人`}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-300 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-40 mt-1 max-h-72 w-full overflow-y-auto rounded-2xl border border-slate-100 bg-white p-2 shadow-lg">
            <p className="px-2 py-1.5 text-[11px] font-semibold text-slate-300">点击姓名多选值班人员</p>
            {employees.map((emp) => {
              const id = staffIdFor(emp.storeKey || storeKey, emp.name)
              const checked = selectedIds.includes(id)
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onToggle(emp, id)}
                  className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs transition ${checked ? 'bg-budu-50' : 'hover:bg-slate-50'}`}
                >
                  <span className={`grid h-4 w-4 shrink-0 place-items-center rounded border text-[10px] font-bold ${checked ? 'border-budu-500 bg-budu-500 text-white' : 'border-slate-200 text-transparent'}`}>✓</span>
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

export default function StoreEntryPage({ user, onBack }) {
  const { t } = useI18n()
  const isManager = ['developer', 'manager'].includes(user?.role)
  const [store, setStore] = useState(() => (allStores()[0] ? allStores()[0].key : ''))
  const [date, setDate] = useState(todayStr)
  const [overview, setOverview] = useState(null)
  const [loadingOverview, setLoadingOverview] = useState(true)
  const overviewRef = useRef(null)
  const [error, setError] = useState('')
  const [savedTip, setSavedTip] = useState('')
  const [inc, setInc] = useState('')
  const [ord, setOrd] = useState('')
  const [staffRows, setStaffRows] = useState([])
  const [saving, setSaving] = useState('')
  const [exportOpen, setExportOpen] = useState(false)
  const [version, setVersion] = useState(0)
  const [adjustCents, setAdjustCents] = useState('')
  const [adjustNote, setAdjustNote] = useState('')

  const month = date && date.length >= 7 ? date.slice(0, 7) : '2026-07'
  const storeInfo = allStores().find((s) => s.key === store)
  const rows = dailyRows(month, store)
  const source = overview?.salesDataSource || 'manual'
  const confirmed = overview?.entry?.status === 'confirmed'
  const salesDataStatus = overview?.salesDataStatus || 'waiting_input'
  const pos = overview?.pos || null
  const adjustmentCents = overview?.entry ? BigInt(overview.entry.hybridAdjustmentCents) : 0n
  const canEditSales = source === 'manual' || (source === 'hybrid' && isManager)
  const canEditStaff = !confirmed || isManager

  const allEmployees = useMemo(() => [...employeeList('all')].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')), [])

  const loadOverview = async () => {
    setLoadingOverview((current) => current || !overviewRef.current)
    setError('')
    try {
      const data = await api(`/v2/daily-entry/overview?store=${encodeURIComponent(store)}&date=${date}`)
      setOverview(data)
      overviewRef.current = data
      setInc(data.entry ? centsToYuan(data.entry.incCents) : '')
      setOrd(data.entry ? String(data.entry.ord || '') : '')
      setStaffRows((data.staff || []).map((s) => ({
        staffId: s.staffId,
        staffName: s.staffName,
        scheduledStartTime: s.scheduledStartTime,
        scheduledEndTime: s.scheduledEndTime,
        actualStartTime: s.actualStartTime,
        actualEndTime: s.actualEndTime,
        breakMinutes: s.breakMinutes,
        actualHours: s.actualHours,
        attendanceStatus: s.attendanceStatus,
      })))
    } catch (e) {
      setError(e.message)
    } finally {
      setLoadingOverview(false)
    }
  }

  useEffect(() => { loadOverview() }, [store, date]) // eslint-disable-line react-hooks/exhaustive-deps

  const refreshAll = async () => {
    await loadUserData().catch(() => {})
  }

  const tip = (message, ok = true) => {
    setSavedTip(message)
    setTimeout(() => setSavedTip(''), 2500)
  }

  const saveManual = async () => {
    if (!date || (!inc && !ord)) {
      tip(t('请至少填写营业收入或订单数'), false)
      return
    }
    setSaving('manual')
    setError('')
    try {
      await api('/v2/daily-entries', {
        method: 'PUT',
        body: JSON.stringify({
          storeKey: store,
          date,
          incCents: Number(yuanToCents(inc)),
          ord: Number(ord) || 0,
          staffNames: staffRows.map((row) => row.staffName),
          version: overview?.entry?.version,
        }),
      })
      await refreshAll()
      await loadOverview()
      tip(t('营业数据已保存 ✓'))
    } catch (e) {
      setError(e.message)
      if (e.data?.latest) {
        setOverview((current) => ({ ...current, entry: { ...(current?.entry || {}), ...e.data.latest, hybridAdjustmentCents: '0', hybridAdjustmentNote: '' } }))
      }
    } finally {
      setSaving('')
    }
  }

  const persistStaff = async (nextRows) => {
    setSaving('staff')
    setError('')
    try {
      await api('/v2/daily-staff', {
        method: 'PUT',
        body: JSON.stringify({
          storeKey: store,
          date,
          items: nextRows.map((row) => ({
            staffId: row.staffId,
            staffName: row.staffName,
            scheduledStartTime: row.scheduledStartTime,
            scheduledEndTime: row.scheduledEndTime,
            actualStartTime: '',
            actualEndTime: '',
            breakMinutes: 0,
            actualHours: row.actualHours,
            attendanceStatus: 'normal',
          })),
          reason: '值班人员选择',
        }),
      })
      // 值班人员本地已乐观更新，不再全量刷新（避免连续点选卡顿、界面闪断与请求竞态）
      tip(t('值班人员已保存 ✓'))
    } catch (e) {
      setError(e.message)
      tip(t('值班人员保存失败，已恢复'), false)
      await loadOverview()
    } finally {
      setSaving('')
    }
  }

  const toggleStaff = (emp, id) => {
    const exists = staffRows.some((row) => row.staffId === id)
    const nextRows = exists
      ? staffRows.filter((row) => row.staffId !== id)
      : [...staffRows, {
        staffId: id,
        staffName: emp.name,
        scheduledStartTime: '',
        scheduledEndTime: '',
        actualStartTime: '',
        actualEndTime: '',
        breakMinutes: 0,
        actualHours: 0,
        attendanceStatus: 'normal',
      }]
    const hours = dutyHours(store, nextRows.length, storeInfo?.name)
    const withHours = nextRows.map((row) => ({ ...row, actualHours: hours }))
    setStaffRows(withHours)
    persistStaff(withHours)
  }

  const confirmEntry = async () => {
    setSaving('confirm')
    setError('')
    try {
      await api('/v2/daily-entry/confirm', { method: 'POST', body: JSON.stringify({ storeKey: store, date, reason: '闭店确认' }) })
      await refreshAll()
      await loadOverview()
      tip(t('今日营业数据已确认 ✓'))
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving('')
    }
  }

  const unconfirmEntry = async () => {
    setSaving('confirm')
    setError('')
    try {
      await api('/v2/daily-entry/unconfirm', { method: 'POST', body: JSON.stringify({ storeKey: store, date, reason: '管理员取消确认' }) })
      await refreshAll()
      await loadOverview()
      tip(t('已取消确认，可继续修改'))
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving('')
    }
  }

  const saveAdjust = async () => {
    setSaving('adjust')
    setError('')
    try {
      await api('/v2/daily-entry/adjust', {
        method: 'POST',
        body: JSON.stringify({
          storeKey: store,
          date,
          adjustmentCents: Number(yuanToCents(adjustCents || '0')),
          note: adjustNote,
          reason: '营业数据调整',
        }),
      })
      setAdjustCents('')
      setAdjustNote('')
      await refreshAll()
      await loadOverview()
      tip(t('营业数据调整已保存 ✓'))
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving('')
    }
  }

  const handleEdit = (r) => {
    setDate(`${month}-${r.d}`)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const handleDelete = async (d) => {
    if (!window.confirm(t('确定删除该日业绩吗？删除后不可恢复'))) return
    deleteLocalEntry(month, store, d)
    setError('')
    try {
      await api('/v2/daily-entries', {
        method: 'DELETE',
        body: JSON.stringify({ storeKey: store, date: `${month}-${d.slice(3)}` }),
      })
      await refreshAll()
      await loadOverview()
      tip(t('当日业绩已删除 ✓'))
    } catch (e) {
      setError(e.message)
      await refreshAll()
    }
  }

  const statusBadge = () => {
    if (source === 'pos' || source === 'hybrid') {
      if (salesDataStatus === 'sync_failed') {
        return <span className="inline-flex items-center gap-1 rounded-lg bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-600"><ShieldAlert className="h-3.5 w-3.5" />POS 数据同步异常</span>
      }
      return <span className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-600"><CheckCircle2 className="h-3.5 w-3.5" />POS 自动同步</span>
    }
    return <span className="inline-flex items-center gap-1 rounded-lg bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-600"><WalletCards className="h-3.5 w-3.5" />当前门店暂未接入 POS</span>
  }

  const posCards = pos ? [
    { label: '有效销售额', value: formatCents(BigInt(pos.effectiveAfterRefund) + adjustmentCents) },
    { label: '实收金额', value: formatCents(BigInt(pos.effectiveAfterRefund)) },
    { label: '订单数', value: String(pos.orderCount) },
    { label: '客单价', value: formatCents(BigInt(pos.avgOrderCents)) },
    { label: '退款金额', value: formatCents(BigInt(pos.refundAmount)) },
    { label: '折扣金额', value: formatCents(BigInt(pos.discountAmount)) },
  ] : []

  const channelCards = pos ? [
    ['微信', pos.byChannel.wechat],
    ['支付宝', pos.byChannel.alipay],
    ['现金', pos.byChannel.cash],
    ['其他', pos.byChannel.other],
  ] : []

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <button onClick={onBack} className="flex items-center gap-1.5 rounded-2xl bg-white px-3.5 py-2.5 text-sm font-medium text-slate-500 shadow-card transition hover:text-budu-600">
          <ArrowLeft className="h-4 w-4" />{t('返回首页')}
        </button>
        <div>
          <h2 className="text-xl font-bold text-slate-800">{t('每日门店录入')}</h2>
          <p className="mt-0.5 text-[13px] text-slate-400">{t('营业数据按门店来源自动/人工匹配，值班人员与工时用于工资与人效计算')}</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {statusBadge()}
          {confirmed && <span className="rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-600">已确认{overview?.entry?.confirmedBy ? ` · ${overview.entry.confirmedBy}` : ''}</span>}
          <button onClick={() => setExportOpen(true)} className="btn-secondary px-3 py-2"><FileSpreadsheet className="h-4 w-4 text-budu-600" />{t('表格导出')}</button>
        </div>
      </div>

      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600">{error}</div>}
      {savedTip && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-600">{savedTip}</div>}

      <div className="card p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={t('门店')} icon={Building2}>
            <select value={store} onChange={(e) => setStore(e.target.value)} className={inputCls}>
              {allStores().map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
            </select>
          </Field>
          <Field label={t('日期')} icon={CalendarDays}>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
          </Field>
          <div className="flex items-end">
            <p className="text-xs text-slate-400">
              {source === 'pos' ? '该门店营业数据由 POS 自动同步，普通员工不可修改。' : source === 'hybrid' ? '该门店优先读取 POS 数据，管理员可调整补录。' : '当前门店暂未接入 POS，营业数据由门店录入。'}
            </p>
          </div>
        </div>
      </div>

      <section className="card p-5">
        <h3 className="text-[15px] font-bold text-slate-800">今日经营概览</h3>
        {loadingOverview && !overview ? (
          <p className="mt-3 text-sm text-slate-400">正在加载…</p>
        ) : source === 'pos' || source === 'hybrid' ? (
          <>
            {salesDataStatus === 'sync_failed' ? (
              <p className="mt-3 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-600">POS 数据同步异常，请稍后刷新；值班人员与库存/备注填写不受影响。</p>
            ) : pos ? (
              <>
                <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                  {posCards.map((card) => (
                    <div key={card.label} className="rounded-2xl border border-slate-100 bg-slate-50/70 p-3">
                      <p className="text-[11px] text-slate-400">{card.label}</p>
                      <p className="mt-1 text-lg font-black tabular-nums text-slate-900">{card.value}</p>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-500">
                  {channelCards.map(([label, value]) => (
                    <span key={label}>{label} <b className="tabular-nums text-slate-700">{formatCents(BigInt(value))}</b></span>
                  ))}
                </div>
                {BigInt(pos.effectiveSales) === 0n && <p className="mt-3 text-xs text-slate-400">今日 POS 销售额 ¥0.00（确无订单）</p>}
                {adjustmentCents !== 0n && <p className="mt-2 text-xs text-emerald-600">管理员调整：{adjustmentCents > 0n ? '+' : ''}{formatCents(adjustmentCents)}</p>}
              </>
            ) : (
              <p className="mt-3 text-sm text-slate-400">POS 数据同步中…</p>
            )}
            {source === 'hybrid' && isManager && (
              <div className="mt-4 grid grid-cols-1 gap-3 rounded-2xl border border-emerald-100 bg-emerald-50/50 p-4 md:grid-cols-3">
                <label className="text-xs font-semibold text-slate-500">调整金额（元，可正可负）<input inputMode="decimal" value={adjustCents} onChange={(e) => setAdjustCents(e.target.value)} placeholder="0.00" className={`mt-1 ${inputCls}`} /></label>
                <label className="text-xs font-semibold text-slate-500">调整说明<input value={adjustNote} onChange={(e) => setAdjustNote(e.target.value)} placeholder="例如：POS 缺单补录" className={`mt-1 ${inputCls}`} /></label>
                <div className="flex items-end"><button onClick={saveAdjust} disabled={saving === 'adjust'} className="w-full rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving === 'adjust' ? '保存中…' : '保存调整'}</button></div>
              </div>
            )}
          </>
        ) : (
          <>
            <p className="mt-2 text-xs text-slate-400">{salesDataStatus === 'waiting_input' ? '等待门店录入' : '营业数据已录入'}</p>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label={t('营业收入（元）')}><input type="number" step="0.01" min="0" value={inc} onChange={(e) => setInc(e.target.value)} placeholder="0.00" disabled={!canEditSales || (confirmed && !isManager)} className={inputCls} /></Field>
              <Field label={t('订单数（单）')}><input type="number" step="1" min="0" value={ord} onChange={(e) => setOrd(e.target.value)} placeholder="0" disabled={!canEditSales || (confirmed && !isManager)} className={inputCls} /></Field>
              <div className="flex items-end"><button onClick={saveManual} disabled={saving === 'manual' || !canEditSales || (confirmed && !isManager)} className="w-full rounded-xl bg-budu-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"><Save className="mr-1 inline h-4 w-4" />{saving === 'manual' ? '保存中…' : '保存营业数据'}</button></div>
            </div>
          </>
        )}
      </section>

      <section className="card p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-[15px] font-bold text-slate-800">今日值班</h3>
          {saving === 'staff' && <span className="text-xs text-slate-400">保存中…</span>}
        </div>
        <div className="mt-4">
          <StaffMultiSelect
            employees={allEmployees}
            selectedIds={staffRows.map((row) => row.staffId)}
            storeKey={store}
            onToggle={toggleStaff}
            disabled={!canEditStaff}
          />
          {staffRows.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {staffRows.map((row) => (
                <span key={row.staffId} className="inline-flex items-center gap-1.5 rounded-full bg-budu-50 px-3 py-1.5 text-xs font-semibold text-budu-700">
                  {row.staffName}
                  <b className="tabular-nums text-budu-600">{Number(row.actualHours).toFixed(1)}h</b>
                </span>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="card p-5">
        <h3 className="text-[15px] font-bold text-slate-800">闭店确认</h3>
        <p className="mt-2 text-xs text-slate-400">提交前请确认：营业数据完整、值班人员与实际工时已确认。确认后普通员工不可修改，店长/管理员可取消确认。</p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {confirmed ? (
            isManager && <button onClick={unconfirmEntry} disabled={saving === 'confirm'} className="rounded-xl border border-slate-200 px-5 py-2.5 text-sm font-semibold text-slate-500 disabled:opacity-50">{saving === 'confirm' ? '处理中…' : '取消确认'}</button>
          ) : (
            <button onClick={confirmEntry} disabled={saving === 'confirm'} className="flex items-center gap-2 rounded-xl bg-budu-500 px-6 py-2.5 text-sm font-semibold text-white shadow-sm disabled:opacity-50"><CheckCircle2 className="h-4 w-4" />{saving === 'confirm' ? '确认中…' : '确认今日营业数据'}</button>
          )}
          {confirmed && overview?.entry?.confirmedAt && <span className="text-xs text-slate-400">确认时间：{new Date(overview.entry.confirmedAt).toLocaleString('zh-CN', { hour12: false })}</span>}
        </div>
      </section>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-4">
          <h3 className="text-[15px] font-bold text-slate-800">{t('业绩明细')}</h3>
          <span className="rounded-lg bg-budu-50 px-2 py-0.5 text-xs font-semibold text-budu-600">{monthLabel(month)} · {storeInfo ? storeInfo.name : ''}</span>
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
                  <tr key={r.d} className="border-t border-slate-50 transition hover:bg-slate-50">
                    <td className="px-5 py-3 font-medium text-slate-700">{r.d}</td>
                    <td className="px-4 py-3">{staffNames.length > 0 ? <div className="flex flex-wrap gap-1">{staffNames.map((n) => <span key={n} className="rounded-md bg-budu-50 px-1.5 py-0.5 text-[11px] font-semibold text-budu-600">{n}</span>)}</div> : <span className="text-xs text-slate-300">—</span>}</td>
                    <td className="px-4 py-3 tabular-nums text-slate-600">¥{formatMoney(r.inc)}</td>
                    <td className="px-4 py-3 tabular-nums text-slate-600">{r.ord.toLocaleString('zh-CN')}</td>
                    <td className="px-4 py-3 tabular-nums text-slate-600">¥{r.ord > 0 ? (r.inc / r.ord).toFixed(2) : '0.00'}</td>
                    <td className="px-4 py-3">{r.local ? <span className="rounded-md bg-budu-50 px-1.5 py-0.5 text-[10px] font-bold text-budu-600">{t('本地录入')}</span> : <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-400">{t('报表')}</span>}</td>
                    <td className="px-4 py-3 text-right">{r.local && user?.role === 'developer' && <div className="inline-flex items-center gap-1"><button onClick={() => handleEdit(r)} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-budu-500 transition hover:bg-budu-50"><Pencil className="h-3.5 w-3.5" />{t('修改')}</button><button onClick={() => handleDelete(r.d)} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-rose-400 transition hover:bg-rose-50"><Trash2 className="h-3.5 w-3.5" />{t('删除')}</button></div>}</td>
                  </tr>
                )
              })}
              {rows.length === 0 && <tr><td colSpan="7" className="px-5 py-12 text-center text-sm text-slate-300">{t('暂无数据，请在上方录入')}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-center text-[11px] text-slate-300">
        {t('营业数据以门店来源为准（POS 自动同步 / 人工录入）；值班与工时以每日实际确认为准，用于工资与人效计算')}
      </p>

      {exportOpen && <StoreEntryExportModal storeKey={store} storeName={storeInfo ? storeInfo.name : ''} onClose={() => setExportOpen(false)} />}
    </div>
  )
}
