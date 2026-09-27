import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Building2, History, KeyRound, MapPin, Plus, Store, UserRound, X } from 'lucide-react'
import { api } from '../utils/api'
import { allStores } from '../utils/selectors'
import { OverlayHeader, OverlayPanel, OverlayScrollRegion, OverlayViewport } from './overlay/OverlayPrimitives'

const inputClass = 'mt-1 min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-budu-300 focus:ring-2 focus:ring-budu-100'
const today = () => new Date().toISOString().slice(0, 10)
const blankProfile = () => ({
  name: '', companyName: '', contactName: '', contactPhone: '', cooperationStartDate: today(),
  defaultDiscountBps: 6500, defaultStoreKey: '', invoiceTitle: '', taxpayerId: '', contractReference: '', internalNote: '', version: 1,
})
const blankStore = () => ({ name: '', contactName: '', phone: '', province: '', city: '', district: '', addressLine: '', status: 'ACTIVE', version: 1 })
const statusLabel = { ACTIVE: '正常', PAUSED: '暂停补货', TERMINATED: '停止合作', INACTIVE: '已停用', active: '启用', disabled: '已禁用' }
const statusTone = { ACTIVE: 'bg-emerald-50 text-emerald-700', PAUSED: 'bg-amber-50 text-amber-700', TERMINATED: 'bg-slate-100 text-slate-600', INACTIVE: 'bg-slate-100 text-slate-600', active: 'bg-emerald-50 text-emerald-700', disabled: 'bg-slate-100 text-slate-600' }

function Pill({ status }) {
  return <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${statusTone[status] || statusTone.TERMINATED}`}>{statusLabel[status] || status}</span>
}

function Sheet({ title, onClose, children, wide = false }) {
  return (
    <OverlayViewport className="fixed inset-0 z-[80] flex items-end justify-center sm:items-center sm:p-4">
      <button type="button" aria-label="关闭遮罩" onClick={onClose} className="budu-overlay-backdrop absolute inset-0 bg-slate-950/45 backdrop-blur-[2px]" />
      <OverlayPanel role="dialog" aria-modal="true" aria-label={title} className={`relative flex max-h-[calc(100dvh-env(safe-area-inset-top))] w-full flex-col overflow-hidden rounded-t-[28px] bg-white shadow-2xl sm:max-h-[92dvh] sm:rounded-[28px] ${wide ? 'sm:max-w-4xl' : 'sm:max-w-xl'}`}>
        <OverlayHeader className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h3 className="text-lg font-black text-slate-800">{title}</h3>
          <button type="button" aria-label="关闭弹窗" onClick={onClose} className="grid h-10 w-10 place-items-center rounded-xl bg-slate-100 text-slate-500"><X className="h-5 w-5" /></button>
        </OverlayHeader>
        <OverlayScrollRegion className="pb-[max(1rem,env(safe-area-inset-bottom))]">{children}</OverlayScrollRegion>
      </OverlayPanel>
    </OverlayViewport>
  )
}

function Field({ label, children, span = '' }) {
  return <label className={`block text-xs font-bold text-slate-500 ${span}`}>{label}{children}</label>
}

function ProfileFields({ value, onChange }) {
  const buduStores = allStores()
  const set = (key, next) => onChange({ ...value, [key]: next })
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="合作商名称"><input className={inputClass} value={value.name} onChange={(e) => set('name', e.target.value)} /></Field>
      <Field label="公司主体"><input className={inputClass} value={value.companyName} onChange={(e) => set('companyName', e.target.value)} /></Field>
      <Field label="联系人"><input className={inputClass} value={value.contactName} onChange={(e) => set('contactName', e.target.value)} /></Field>
      <Field label="联系电话"><input className={inputClass} value={value.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} /></Field>
      <Field label="合作开始日期"><input className={inputClass} type="date" value={value.cooperationStartDate || ''} onChange={(e) => set('cooperationStartDate', e.target.value)} /></Field>
      <Field label="进货折扣（%）"><input className={inputClass} type="number" min="0.01" max="100" step="0.01" value={Number(value.defaultDiscountBps || 0) / 100} onChange={(e) => set('defaultDiscountBps', Math.round(Number(e.target.value || 0) * 100))} /></Field>
      <Field label="默认 budu 发货门店"><select className={inputClass} value={value.defaultStoreKey} onChange={(e) => set('defaultStoreKey', e.target.value)}><option value="">请选择</option>{buduStores.map((store) => <option key={store.key} value={store.key}>{store.name}</option>)}</select></Field>
      <Field label="发票抬头"><input className={inputClass} value={value.invoiceTitle || ''} onChange={(e) => set('invoiceTitle', e.target.value)} /></Field>
      <Field label="纳税人识别号"><input className={inputClass} value={value.taxpayerId || ''} onChange={(e) => set('taxpayerId', e.target.value)} /></Field>
      <Field label="合同 / 档案引用"><input className={inputClass} value={value.contractReference || ''} onChange={(e) => set('contractReference', e.target.value)} placeholder="档案编号或受控链接" /></Field>
      <Field label="内部备注" span="sm:col-span-2"><textarea className={`${inputClass} min-h-24 py-2`} value={value.internalNote || ''} onChange={(e) => set('internalNote', e.target.value)} /></Field>
    </div>
  )
}

function StoreFields({ value, onChange }) {
  const set = (key, next) => onChange({ ...value, [key]: next })
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="门店名称"><input className={inputClass} value={value.name} onChange={(e) => set('name', e.target.value)} /></Field>
      <Field label="状态"><select className={inputClass} value={value.status} onChange={(e) => set('status', e.target.value)}><option value="ACTIVE">启用</option><option value="INACTIVE">停用</option></select></Field>
      <Field label="联系人"><input className={inputClass} value={value.contactName} onChange={(e) => set('contactName', e.target.value)} /></Field>
      <Field label="联系电话"><input className={inputClass} value={value.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
      <Field label="省 / 直辖市"><input className={inputClass} value={value.province} onChange={(e) => set('province', e.target.value)} /></Field>
      <Field label="城市"><input className={inputClass} value={value.city} onChange={(e) => set('city', e.target.value)} /></Field>
      <Field label="区 / 县"><input className={inputClass} value={value.district} onChange={(e) => set('district', e.target.value)} /></Field>
      <Field label="详细收货地址"><input className={inputClass} value={value.addressLine} onChange={(e) => set('addressLine', e.target.value)} /></Field>
    </div>
  )
}

function SubmitBar({ error, busy, label, onSubmit }) {
  return <div className="mt-5"><p role="alert" className="min-h-5 text-sm font-semibold text-rose-600">{error}</p><button type="button" disabled={busy} onClick={onSubmit} className="btn-primary mt-2 min-h-12 w-full disabled:opacity-50">{busy ? '保存中…' : label}</button></div>
}

export default function PartnerManagementPage({ onBack }) {
  const [rows, setRows] = useState([])
  const [selected, setSelected] = useState(null)
  const [loading, setLoading] = useState(true)
  const [dialog, setDialog] = useState('')
  const [profile, setProfile] = useState(blankProfile())
  const [store, setStore] = useState(blankStore())
  const [account, setAccount] = useState({ username: '', password: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const loadList = async () => {
    const data = await api('/v2/partner-management/partners')
    setRows(data.rows || [])
  }
  const openDetail = async (id) => {
    setLoading(true)
    try {
      const data = await api(`/v2/partner-management/partners/${id}`)
      setSelected(data.partner)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { loadList().catch((e) => setError(e.message)).finally(() => setLoading(false)) }, [])
  const activeUser = useMemo(() => selected?.users?.find((user) => user.status === 'active'), [selected])

  const beginCreate = () => {
    const next = blankProfile()
    next.defaultStoreKey = allStores()[0]?.key || ''
    setProfile(next); setStore(blankStore()); setAccount({ username: '', password: '' }); setError(''); setDialog('create')
  }
  const beginEdit = () => { setProfile({ ...blankProfile(), ...selected }); setError(''); setDialog('profile') }
  const beginStore = (row = null) => { setStore(row ? { ...row } : blankStore()); setError(''); setDialog('store') }
  const run = async (work) => {
    setBusy(true); setError('')
    try { await work(); setDialog(''); await loadList(); if (selected?.id) await openDetail(selected.id) } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const create = async () => {
    setBusy(true); setError('')
    try {
      const data = await api('/v2/partner-management/partners', { method: 'POST', body: JSON.stringify({ ...profile, status: 'ACTIVE', store, account }) })
      await loadList()
      setSelected(data.partner)
      setDialog('')
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }
  const saveProfile = () => run(() => api(`/v2/partner-management/partners/${selected.id}`, { method: 'PUT', body: JSON.stringify(profile) }))
  const saveStore = () => run(() => api(store.id ? `/v2/partner-management/partners/${selected.id}/stores/${store.id}` : `/v2/partner-management/partners/${selected.id}/stores`, { method: store.id ? 'PUT' : 'POST', body: JSON.stringify(store) }))
  const changeStatus = (status) => run(() => api(`/v2/partner-management/partners/${selected.id}/status`, { method: 'PUT', body: JSON.stringify({ status, version: selected.version }) }))
  const createAccount = () => run(() => api(`/v2/partner-management/partners/${selected.id}/users`, { method: 'POST', body: JSON.stringify(account) }))
  const changeAccount = (row, status) => run(() => api(`/v2/partner-management/partners/${selected.id}/users/${row.id}/status`, { method: 'PUT', body: JSON.stringify({ status }) }))

  return (
    <section className="space-y-4" data-testid="partner-management-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3"><button type="button" onClick={onBack} className="grid h-11 w-11 place-items-center rounded-xl border border-slate-200 bg-white text-slate-500"><ArrowLeft className="h-5 w-5" /></button><div><p className="text-xs font-black tracking-[0.12em] text-budu-500">PARTNER DOMAIN</p><h2 className="text-xl font-black text-slate-900">合作商档案</h2></div></div>
        <button type="button" onClick={beginCreate} className="btn-primary min-h-11"><Plus className="h-4 w-4" />创建合作商</button>
      </div>
      {error && !dialog && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-600">{error}</p>}

      <div className="grid gap-4 lg:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.6fr)]">
        <div className="space-y-3">
          {loading && !rows.length ? <div className="card p-6 text-sm text-slate-400">加载合作商档案…</div> : rows.map((row) => <button type="button" key={row.id} onClick={() => openDetail(row.id)} className={`w-full rounded-2xl border bg-white p-4 text-left shadow-sm ${selected?.id === row.id ? 'border-budu-300 ring-2 ring-budu-100' : 'border-slate-100'}`}><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="truncate font-black text-slate-800">{row.name}</p><p className="mt-1 truncate text-xs text-slate-400">{row.companyName || '待补公司主体'}</p></div><Pill status={row.status} /></div><div className="mt-3 flex gap-3 text-xs text-slate-500"><span>{row.storeCount} 家合作门店</span><span>{row.userCount} 个账号</span></div></button>)}
          {!loading && rows.length === 0 && <div className="card p-8 text-center text-sm text-slate-400">尚未创建合作商</div>}
        </div>

        <div className="min-w-0">
          {!selected ? <div className="card grid min-h-64 place-items-center p-8 text-center"><div><Building2 className="mx-auto h-9 w-9 text-budu-300" /><p className="mt-3 text-sm text-slate-400">选择合作商查看档案，或创建新的受控账号</p></div></div> : <div className="space-y-4">
            <div className="card p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><h3 className="text-xl font-black text-slate-900">{selected.name}</h3><Pill status={selected.status} /></div><p className="mt-1 text-sm text-slate-500">{selected.companyName}</p></div><button type="button" onClick={beginEdit} className="btn-secondary min-h-10">编辑档案</button></div><div className="mt-4 grid gap-3 rounded-2xl bg-slate-50 p-4 text-sm text-slate-600 sm:grid-cols-2"><p>联系人：{selected.contactName}</p><p>电话：{selected.contactPhone}</p><p>合作开始：{selected.cooperationStartDate || '未填写'}</p><p>进货折扣：{(selected.defaultDiscountBps / 100).toFixed(2)}%</p><p>发票抬头：{selected.invoiceTitle || '未填写'}</p><p>纳税人识别号：{selected.taxpayerId || '未填写'}</p></div><div className="mt-4 flex flex-wrap gap-2">{selected.status !== 'ACTIVE' && <button type="button" onClick={() => changeStatus('ACTIVE')} className="btn-secondary min-h-10">恢复正常</button>}{selected.status !== 'PAUSED' && <button type="button" onClick={() => changeStatus('PAUSED')} className="min-h-10 rounded-xl bg-amber-50 px-4 text-sm font-bold text-amber-700">暂停补货</button>}{selected.status !== 'TERMINATED' && <button type="button" onClick={() => changeStatus('TERMINATED')} className="min-h-10 rounded-xl bg-rose-50 px-4 text-sm font-bold text-rose-700">停止合作</button>}</div></div>

            <div className="card p-5"><div className="flex items-center justify-between"><div className="flex items-center gap-2"><Store className="h-5 w-5 text-budu-500" /><h3 className="font-black text-slate-800">合作门店</h3></div>{selected.status !== 'TERMINATED' && <button type="button" onClick={() => beginStore()} className="btn-secondary min-h-10"><Plus className="h-4 w-4" />新增门店</button>}</div><div className="mt-4 grid gap-3 sm:grid-cols-2">{selected.stores.map((row) => <button type="button" key={row.id} onClick={() => beginStore(row)} className="rounded-2xl border border-slate-100 p-4 text-left"><div className="flex justify-between gap-2"><p className="font-bold text-slate-800">{row.name}</p><Pill status={row.status} /></div><p className="mt-2 text-xs leading-5 text-slate-500">{row.province}{row.city}{row.district}{row.addressLine}</p><p className="mt-1 text-xs text-slate-400">{row.contactName} · {row.phone}</p></button>)}</div></div>

            <div className="card p-5"><div className="flex items-center gap-2"><KeyRound className="h-5 w-5 text-budu-500" /><h3 className="font-black text-slate-800">登录账号</h3></div><div className="mt-4 space-y-2">{selected.users.map((row) => <div key={row.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-100 p-4"><div><div className="flex items-center gap-2"><UserRound className="h-4 w-4 text-slate-400" /><p className="font-bold text-slate-700">{row.username}</p><Pill status={row.status} /></div><p className="mt-1 text-xs text-slate-400">User 状态：{row.userStatus}</p></div><button type="button" onClick={() => changeAccount(row, row.status === 'active' ? 'disabled' : 'active')} className="btn-secondary min-h-10">{row.status === 'active' ? '禁用绑定' : '启用绑定'}</button></div>)}</div>{!activeUser && selected.status !== 'TERMINATED' && <button type="button" onClick={() => { setAccount({ username: '', password: '' }); setError(''); setDialog('account') }} className="btn-primary mt-4 min-h-11">创建登录账号</button>}<p className="mt-3 text-xs text-slate-400">User 是唯一凭证权威；1.0 当前最多一个启用账号，底层支持未来多个 PartnerUser。</p></div>

            <div className="card p-5"><div className="flex items-center gap-2"><History className="h-5 w-5 text-budu-500" /><h3 className="font-black text-slate-800">操作审计</h3></div><div className="mt-4 space-y-2">{selected.audits.slice(0, 20).map((log) => <div key={log.id} className="rounded-xl bg-slate-50 p-3 text-xs text-slate-500"><div className="flex justify-between gap-2"><span className="font-bold text-slate-700">{log.action}</span><span>{new Date(log.createdAt).toLocaleString('zh-CN', { hour12: false })}</span></div><p className="mt-1">{log.actorUsername || log.actorUserId}</p></div>)}</div></div>
          </div>}
        </div>
      </div>

      {dialog === 'create' && <Sheet title="创建合作商" onClose={() => setDialog('')} wide><div className="space-y-6 p-5"><div><h4 className="mb-3 font-black text-slate-700">合作商档案</h4><ProfileFields value={profile} onChange={setProfile} /></div><div><h4 className="mb-3 font-black text-slate-700">首家合作门店</h4><StoreFields value={store} onChange={setStore} /></div><div><h4 className="mb-3 font-black text-slate-700">首个登录账号</h4><div className="grid gap-3 sm:grid-cols-2"><Field label="用户名"><input className={inputClass} autoComplete="off" value={account.username} onChange={(e) => setAccount({ ...account, username: e.target.value })} /></Field><Field label="初始密码"><input className={inputClass} type="password" autoComplete="new-password" value={account.password} onChange={(e) => setAccount({ ...account, password: e.target.value })} /></Field></div><p className="mt-2 text-xs text-slate-400">密码只提交到 User 密码哈希权威，不写入 Partner 或审计日志。</p></div><SubmitBar error={error} busy={busy} label="原子创建 Partner、门店与账号" onSubmit={create} /></div></Sheet>}
      {dialog === 'profile' && <Sheet title="编辑合作商档案" onClose={() => setDialog('')} wide><div className="p-5"><ProfileFields value={profile} onChange={setProfile} /><SubmitBar error={error} busy={busy} label="保存档案" onSubmit={saveProfile} /></div></Sheet>}
      {dialog === 'store' && <Sheet title={store.id ? '编辑合作门店' : '新增合作门店'} onClose={() => setDialog('')}><div className="p-5"><StoreFields value={store} onChange={setStore} /><SubmitBar error={error} busy={busy} label="保存合作门店" onSubmit={saveStore} /></div></Sheet>}
      {dialog === 'account' && <Sheet title="创建合作商登录账号" onClose={() => setDialog('')}><div className="p-5"><Field label="用户名"><input className={inputClass} autoComplete="off" value={account.username} onChange={(e) => setAccount({ ...account, username: e.target.value })} /></Field><Field label="初始密码"><input className={inputClass} type="password" autoComplete="new-password" value={account.password} onChange={(e) => setAccount({ ...account, password: e.target.value })} /></Field><SubmitBar error={error} busy={busy} label="创建并绑定账号" onSubmit={createAccount} /></div></Sheet>}
    </section>
  )
}
