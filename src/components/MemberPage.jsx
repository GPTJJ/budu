import { useEffect, useState } from 'react'
import { ArrowLeft, Cake, Heart, Plus, Search, X } from 'lucide-react'
import { allStores } from '../utils/selectors'
import { api } from '../utils/api'
import { useI18n } from '../i18n'

const inputCls =
  'w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-budu-400 focus:ring-2 focus:ring-budu-100'
const yuan = (cents) => (Number(cents || 0) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function MemberPage({ currentUser, onBack }) {
  const { t } = useI18n()
  const [q, setQ] = useState('')
  const [members, setMembers] = useState([])
  const [birthdays, setBirthdays] = useState([])
  const [detail, setDetail] = useState(null)
  const [addOpen, setAddOpen] = useState(false)
  const [form, setForm] = useState({ name: '', phone: '', birthday: '' })
  const [consume, setConsume] = useState({ storeKey: allStores()[0]?.key || '', date: new Date().toISOString().slice(0, 10), amount: '', note: '' })
  const [error, setError] = useState('')

  const load = async () => {
    setError('')
    const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`
    try {
      const [list, bd] = await Promise.all([
        api(`/v2/members${q ? `?q=${encodeURIComponent(q)}` : ''}`),
        api(`/v2/members/birthdays?month=${month}`),
      ])
      setMembers(list.rows || [])
      setBirthdays(bd.rows || [])
    } catch (err) {
      setError(t(err.message))
    }
  }

  useEffect(() => {
    const timer = setTimeout(load, q ? 300 : 0)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  const openDetail = async (id) => {
    try {
      const d = await api(`/v2/members/${id}`)
      setDetail(d)
    } catch (err) {
      setError(t(err.message))
    }
  }

  const addMember = async () => {
    setError('')
    try {
      await api('/v2/members', { method: 'POST', body: JSON.stringify(form) })
      setForm({ name: '', phone: '', birthday: '' })
      setAddOpen(false)
      await load()
    } catch (err) {
      setError(t(err.message))
    }
  }

  const addConsumption = async () => {
    setError('')
    const cents = Math.round((Number(consume.amount) || 0) * 100)
    if (!detail || cents <= 0) {
      setError(t('请填写消费金额'))
      return
    }
    try {
      await api(`/v2/members/${detail.member.id}/consumptions`, {
        method: 'POST',
        body: JSON.stringify({ storeKey: consume.storeKey, date: consume.date, amountCents: cents, note: consume.note.trim() }),
      })
      setConsume((s) => ({ ...s, amount: '', note: '' }))
      await openDetail(detail.member.id)
      await load()
    } catch (err) {
      setError(t(err.message))
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <button onClick={onBack} className="flex items-center gap-1.5 rounded-2xl bg-white px-3.5 py-2.5 text-sm font-medium text-slate-500 shadow-card transition hover:text-budu-600">
          <ArrowLeft className="h-4 w-4" />
          {t('返回首页')}
        </button>
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-slate-800">
            <Heart className="h-5 w-5 text-rose-500" />
            {t('会员营销')}
          </h2>
          <p className="mt-0.5 text-[13px] text-slate-400">{t('会员档案、消费记录与积分')}</p>
        </div>
        <button onClick={() => setAddOpen(true)} className="ml-auto inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-budu-500 to-grape-500 px-4 py-2.5 text-sm font-semibold text-white">
          <Plus className="h-4 w-4" />
          {t('新增会员')}
        </button>
      </div>

      {error && <p className="rounded-xl bg-rose-50 px-4 py-2 text-xs font-medium text-rose-500">{error}</p>}

      {birthdays.length > 0 && (
        <div className="card border-l-4 border-l-rose-400 p-4">
          <p className="flex items-center gap-2 text-sm font-bold text-slate-700">
            <Cake className="h-4 w-4 text-rose-500" />
            {t('本月生日会员')}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {birthdays.map((m) => (
              <button key={m.id} onClick={() => openDetail(m.id)} className="rounded-lg bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-600 hover:bg-rose-100">
                {m.name} · {m.birthday}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-4">
          <h3 className="text-[15px] font-bold text-slate-800">{t('会员列表')}</h3>
          <span className="rounded-lg bg-budu-50 px-2 py-0.5 text-xs font-semibold text-budu-600">{members.length}</span>
          <label className="relative ml-auto block">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-300" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('搜索姓名/手机号')} className={`${inputCls} pl-9`} />
          </label>
        </div>
        <div className="divide-y divide-slate-50">
          {members.map((m) => (
            <button key={m.id} onClick={() => openDetail(m.id)} className="flex w-full items-center gap-3 px-5 py-3 text-left transition hover:bg-budu-50/40">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-budu-400 to-grape-500 text-sm font-bold text-white">
                {m.name.slice(0, 1)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-700">
                  {m.name}
                  {m.birthday && <span className="ml-1.5 text-[10px] text-rose-400">🎂 {m.birthday}</span>}
                </p>
                <p className="text-[11px] text-slate-400">{m.phone}</p>
              </div>
              <span className="rounded-lg bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-600">{m.points} {t('积分')}</span>
            </button>
          ))}
          {members.length === 0 && <p className="grid place-items-center py-10 text-xs text-slate-300">{t('暂无会员，点击右上角新增')}</p>}
        </div>
      </div>

      {addOpen && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => setAddOpen(false)} />
          <div className="relative w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-slate-800">{t('新增会员')}</h3>
            <div className="mt-4 space-y-2">
              <input value={form.name} onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))} placeholder={t('姓名')} className={inputCls} />
              <input value={form.phone} onChange={(e) => setForm((s) => ({ ...s, phone: e.target.value }))} placeholder={t('手机号（11 位）')} className={inputCls} />
              <input type="date" value={form.birthday} onChange={(e) => setForm((s) => ({ ...s, birthday: e.target.value }))} className={inputCls} />
            </div>
            <div className="mt-4 flex gap-2">
              <button onClick={() => setAddOpen(false)} className="flex-1 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-500">
                {t('取消')}
              </button>
              <button onClick={addMember} className="flex-1 rounded-xl bg-gradient-to-r from-budu-500 to-grape-500 px-4 py-2.5 text-sm font-semibold text-white">
                {t('保存')}
              </button>
            </div>
          </div>
        </div>
      )}

      {detail && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => setDetail(null)} />
          <div className="relative max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold text-slate-800">{detail.member.name}</h3>
                <p className="mt-0.5 text-xs text-slate-400">
                  {detail.member.phone} · {t('积分')} {detail.member.points}
                </p>
              </div>
              <button onClick={() => setDetail(null)} className="grid h-9 w-9 place-items-center rounded-xl bg-slate-50 text-slate-400">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-4 rounded-2xl bg-slate-50 p-3">
              <p className="mb-2 text-xs font-semibold text-slate-500">{t('录入消费')}（1 元 = 1 积分）</p>
              <div className="grid grid-cols-2 gap-2">
                <select value={consume.storeKey} onChange={(e) => setConsume((s) => ({ ...s, storeKey: e.target.value }))} className={inputCls}>
                  {allStores().map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <input type="date" value={consume.date} onChange={(e) => setConsume((s) => ({ ...s, date: e.target.value }))} className={inputCls} />
                <input type="number" step="0.01" min="0" value={consume.amount} onChange={(e) => setConsume((s) => ({ ...s, amount: e.target.value }))} placeholder={t('金额（元）')} className={inputCls} />
                <input value={consume.note} onChange={(e) => setConsume((s) => ({ ...s, note: e.target.value }))} placeholder={t('备注')} className={inputCls} />
              </div>
              <button onClick={addConsumption} className="mt-2 w-full rounded-xl bg-budu-500 px-4 py-2 text-sm font-semibold text-white">
                {t('保存消费')}
              </button>
            </div>

            <div className="mt-4">
              <p className="mb-2 text-xs font-semibold text-slate-500">{t('消费记录')}</p>
              <div className="space-y-1.5">
                {(detail.consumptions || []).map((c) => (
                  <div key={c.id} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-xs">
                    <div>
                      <p className="font-semibold text-slate-700">
                        {c.storeKey} · {c.date}
                      </p>
                      {c.note && <p className="text-[10px] text-slate-400">{c.note}</p>}
                    </div>
                    <span className="font-bold text-slate-700">¥{yuan(c.amountCents)}</span>
                  </div>
                ))}
                {(detail.consumptions || []).length === 0 && <p className="grid place-items-center py-6 text-xs text-slate-300">{t('暂无消费记录')}</p>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
