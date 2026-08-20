import { useEffect, useState } from 'react'
import { ArrowLeft, Download, Plus, Trash2, Wallet } from 'lucide-react'
import { allStores, storeName } from '../utils/selectors'
import { api } from '../utils/api'
import { t } from '../utils/text'

const inputCls = 'input'
const CATEGORIES = ['房租', '人工', '水电', '原料', '平台佣金', '其他']

const yuan = (cents) => (Number(cents || 0) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

async function downloadCsv(url) {
  const res = await fetch(url, { credentials: 'same-origin' })
  const blob = await res.blob()
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = url.split('/').pop().split('?')[0] || 'export.csv'
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

export default function FinancePage({ currentUser, onBack }) {
  const canManage = ['developer', 'admin', 'finance', 'manager'].includes(currentUser?.role)
  const [month, setMonth] = useState(`${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`)
  const [store, setStore] = useState('all')
  const [expenses, setExpenses] = useState([])
  const [profit, setProfit] = useState({ rows: [], monthly: [] })
  const [form, setForm] = useState({ storeKey: allStores()[0]?.key || '', date: new Date().toISOString().slice(0, 10), category: '其他', amount: '', note: '' })
  const [error, setError] = useState('')
  const [savedTip, setSavedTip] = useState('')

  const load = async () => {
    setError('')
    const qs = new URLSearchParams({ month })
    if (store !== 'all') qs.set('store', store)
    try {
      const [ex, pf] = await Promise.all([api(`/v2/expenses?${qs}`), api(`/v2/profit?${qs}`)])
      setExpenses(ex.rows || [])
      setProfit(pf)
    } catch (err) {
      setError(t(err.message))
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, store])

  const submit = async () => {
    setError('')
    const cents = Math.round((Number(form.amount) || 0) * 100)
    if (!form.date || cents <= 0) {
      setError(t('请填写日期与金额'))
      return
    }
    try {
      await api('/v2/expenses', {
        method: 'POST',
        body: JSON.stringify({
          storeKey: form.storeKey,
          date: form.date,
          category: form.category,
          amountCents: cents,
          note: form.note.trim(),
        }),
      })
      setForm((s) => ({ ...s, amount: '', note: '' }))
      setSavedTip(t('费用已录入 ✓'))
      setTimeout(() => setSavedTip(''), 2000)
      await load()
    } catch (err) {
      setError(t(err.message))
    }
  }

  const remove = async (id) => {
    if (!window.confirm(t('确定删除该费用记录吗？'))) return
    try {
      await api(`/v2/expenses/${id}`, { method: 'DELETE' })
      await load()
    } catch (err) {
      setError(t(err.message))
    }
  }

  const total = profit.monthly.reduce((s, r) => s + Number(r.profitCents), 0)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <button onClick={onBack} className="flex items-center gap-1.5 rounded-2xl bg-white px-3.5 py-2.5 text-sm font-medium text-slate-500 shadow-card transition hover:text-budu-600">
          <ArrowLeft className="h-4 w-4" />
          {t('返回首页')}
        </button>
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-slate-800">
            <Wallet className="h-5 w-5 text-budu-500" />
            {t('财务利润')}
          </h2>
          <p className="mt-0.5 text-[13px] text-slate-400">{t('录入费用，按门店计算日/月利润并导出报表')}</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className={inputCls} />
          <select value={store} onChange={(e) => setStore(e.target.value)} className={inputCls}>
            <option value="all">{t('全部门店')}</option>
            {allStores().map((s) => (
              <option key={s.key} value={s.key}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            onClick={() => downloadCsv(`/api/v2/export/profit?month=${month}${store !== 'all' ? `&store=${store}` : ''}`)}
            className="inline-flex items-center gap-1.5 rounded-xl bg-budu-50 px-3 py-2 text-xs font-semibold text-budu-600 transition hover:bg-budu-100"
          >
            <Download className="h-3.5 w-3.5" />
            {t('导出利润')}
          </button>
        </div>
      </div>

      {savedTip && <p className="rounded-xl bg-emerald-50 px-4 py-2 text-xs font-semibold text-emerald-600">{savedTip}</p>}
      {error && <p className="rounded-xl bg-rose-50 px-4 py-2 text-xs font-medium text-rose-500">{error}</p>}

      {canManage && <div className="card p-5">
        <h3 className="text-[15px] font-bold text-slate-800">{t('费用录入')}</h3>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4">
          <select value={form.storeKey} onChange={(e) => setForm((s) => ({ ...s, storeKey: e.target.value }))} className={inputCls}>
            {allStores().map((s) => (
              <option key={s.key} value={s.key}>
                {s.name}
              </option>
            ))}
          </select>
          <input type="date" value={form.date} onChange={(e) => setForm((s) => ({ ...s, date: e.target.value }))} className={inputCls} />
          <select value={form.category} onChange={(e) => setForm((s) => ({ ...s, category: e.target.value }))} className={inputCls}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(c)}
              </option>
            ))}
          </select>
          <input type="number" step="0.01" min="0" value={form.amount} onChange={(e) => setForm((s) => ({ ...s, amount: e.target.value }))} placeholder={t('金额（元）')} className={inputCls} />
          <input value={form.note} onChange={(e) => setForm((s) => ({ ...s, note: e.target.value }))} placeholder={t('备注（选填）')} className={`${inputCls} md:col-span-2`} />
          <button onClick={submit} className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-budu-500 px-4 py-2.5 text-sm font-semibold text-white">
            <Plus className="h-4 w-4" />
            {t('录入费用')}
          </button>
        </div>
      </div>}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
        <div className="card overflow-hidden xl:col-span-5">
          <div className="border-b border-slate-100 px-5 py-4">
            <h3 className="text-[15px] font-bold text-slate-800">{t('门店利润排行')}</h3>
            <p className="mt-0.5 text-xs text-slate-400">
              {t('{month} · 总利润 ¥{amount}', { month, amount: yuan(total) })}
            </p>
          </div>
          <div className="divide-y divide-slate-50">
            {profit.monthly.map((r, i) => (
              <div key={r.storeKey} className="flex items-center gap-3 px-5 py-3">
                <span className={`grid h-6 w-6 place-items-center rounded-lg text-[11px] font-bold text-white ${i === 0 ? 'bg-amber-400' : i === 1 ? 'bg-slate-300' : i === 2 ? 'bg-orange-400' : 'bg-slate-100 text-slate-400'}`}>
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-700">{storeName(r.storeKey)}</p>
                  <p className="text-[11px] text-slate-400">
                    {t('收入 ¥{a} · 费用 ¥{b}', { a: yuan(r.incCents), b: yuan(r.expenseCents) })}
                  </p>
                </div>
                <span className={`text-sm font-bold ${Number(r.profitCents) >= 0 ? 'text-emerald-600' : 'text-rose-500'}`}>¥{yuan(r.profitCents)}</span>
              </div>
            ))}
            {profit.monthly.length === 0 && <p className="grid place-items-center py-10 text-xs text-slate-300">{t('暂无利润数据')}</p>}
          </div>
        </div>

        <div className="card overflow-hidden xl:col-span-7">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <h3 className="text-[15px] font-bold text-slate-800">{t('费用明细')}</h3>
            <span className="rounded-lg bg-budu-50 px-2 py-0.5 text-xs font-semibold text-budu-600">{expenses.length}</span>
          </div>
          <div className="max-h-[420px] divide-y divide-slate-50 overflow-y-auto">
            {expenses.map((r) => (
              <div key={r.id} className="flex items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-700">
                    {t(r.category)} · {storeName(r.storeKey)} · {r.date}
                  </p>
                  {r.note && <p className="mt-0.5 text-[11px] text-slate-400">{r.note}</p>}
                </div>
                <span className="text-sm font-bold text-rose-500">¥{yuan(r.amountCents)}</span>
                {canManage && <button onClick={() => remove(r.id)} className="rounded-lg p-1.5 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500" aria-label={t('删除')}>
                  <Trash2 className="h-4 w-4" />
                </button>}
              </div>
            ))}
            {expenses.length === 0 && <p className="grid place-items-center py-10 text-xs text-slate-300">{t('本月暂无费用记录')}</p>}
          </div>
        </div>
      </div>
    </div>
  )
}
