import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Boxes, Check, Package, Pencil, Plus, X } from 'lucide-react'
import { api } from '../utils/api'

const sortRows = (rows) => [...rows].sort((a, b) => a.category.localeCompare(b.category) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh-CN'))

function Editor({ value, busy, onChange, onClose, onSave }) {
  const product = value.category === 'product'
  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center sm:p-4">
      <button className="absolute inset-0 bg-slate-950/45 backdrop-blur-sm" onClick={onClose} aria-label="关闭编辑" />
      <section role="dialog" aria-modal="true" aria-labelledby="master-editor-title" className="relative w-full rounded-t-[28px] bg-white shadow-2xl sm:max-w-lg sm:rounded-[28px]">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div><h3 id="master-editor-title" className="font-bold text-slate-900">{value.id ? '编辑' : '新增'}{product ? '产品' : '物料'}</h3><p className="mt-0.5 text-xs text-slate-400">仅维护调拨基础资料，不关联库存数量</p></div>
          <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full bg-slate-100 text-slate-500" aria-label="关闭"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-4 p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
          {product && <label className="block text-xs font-bold text-slate-500">产品编号<input aria-label="产品编号" value={value.code} onChange={(event) => onChange({ ...value, code: event.target.value.slice(0, 40) })} className="input mt-1.5" placeholder="例如 NO.13" /></label>}
          <label className="block text-xs font-bold text-slate-500">{product ? '产品名称' : '物料名称'}<input aria-label={product ? '产品名称' : '物料名称'} value={value.name} onChange={(event) => onChange({ ...value, name: event.target.value.slice(0, 50) })} className="input mt-1.5" placeholder={`请输入${product ? '产品' : '物料'}名称`} /></label>
          <label className="block text-xs font-bold text-slate-500">排序<input aria-label="排序" type="number" min="0" max="999999" inputMode="numeric" value={value.sortOrder} onChange={(event) => onChange({ ...value, sortOrder: event.target.value.replace(/\D/g, '').slice(0, 6) })} className="input mt-1.5" /></label>
          <label className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3 text-sm font-bold text-slate-600"><span><span className="block">新建调拨可选</span><span className="mt-0.5 block text-[11px] font-medium text-slate-400">停用后历史记录仍保留</span></span><input aria-label="启用状态" type="checkbox" checked={value.enabled} onChange={(event) => onChange({ ...value, enabled: event.target.checked })} className="h-5 w-5 accent-budu-500" /></label>
          <div className="grid grid-cols-2 gap-3 pt-1"><button onClick={onClose} className="btn-secondary min-h-12">取消</button><button onClick={onSave} disabled={busy || !value.name.trim() || (product && !value.code.trim())} className="btn-primary min-h-12 disabled:cursor-not-allowed disabled:opacity-40"><Check className="h-4 w-4" />{busy ? '保存中…' : '保存'}</button></div>
        </div>
      </section>
    </div>
  )
}

export default function ProductMaterialManagementPage({ onBack }) {
  const [tab, setTab] = useState('product')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [editor, setEditor] = useState(null)
  const [busy, setBusy] = useState(false)
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const data = await api('/v2/transfer-master-items')
      setRows(sortRows(data.rows || []))
      setError('')
    } catch (err) { setError(err.message) } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  const visible = useMemo(() => rows.filter((item) => item.category === tab), [rows, tab])
  const activeCount = visible.filter((item) => item.enabled).length

  const openAdd = () => {
    const nextOrder = visible.reduce((max, item) => Math.max(max, Number(item.sortOrder) || 0), 0) + 1
    setEditor({ id: '', category: tab, name: '', code: '', sortOrder: String(nextOrder), enabled: true, version: 0 })
    setError('')
  }

  const save = async () => {
    if (!editor || busy) return
    setBusy(true)
    try {
      const payload = { ...editor, sortOrder: Number(editor.sortOrder), version: editor.version }
      const data = await api(editor.id ? `/v2/transfer-master-items/${editor.id}` : '/v2/transfer-master-items', {
        method: editor.id ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      })
      const saved = data.item
      setRows((current) => sortRows(editor.id ? current.map((item) => item.id === saved.id ? saved : item) : [...current, saved]))
      setEditor(null)
      setNotice(`${saved.category === 'product' ? '产品' : '物料'}资料已保存`)
      setError('')
      window.setTimeout(() => setNotice(''), 2200)
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  const toggle = async (item) => {
    if (busyId) return
    setBusyId(item.id)
    try {
      const data = await api(`/v2/transfer-master-items/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...item, enabled: !item.enabled }),
      })
      setRows((current) => sortRows(current.map((row) => row.id === item.id ? data.item : row)))
      setNotice(data.item.enabled ? '已启用，新建调拨可选' : '已停用，历史记录不受影响')
      setError('')
      window.setTimeout(() => setNotice(''), 2200)
    } catch (err) { setError(err.message) } finally { setBusyId('') }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4" data-testid="product-material-management-page">
      <header className="flex items-center gap-3">
        <button onClick={onBack} className="grid h-10 w-10 place-items-center rounded-2xl bg-white text-slate-500 shadow-card" aria-label="返回首页"><ArrowLeft className="h-5 w-5" /></button>
        <div className="min-w-0 flex-1"><h2 className="text-xl font-bold text-slate-900">产品物料管理</h2><p className="text-xs text-slate-400">PostgreSQL 主数据 · 不管理库存数量</p></div>
        <button onClick={openAdd} className="btn-primary min-h-11 px-4"><Plus className="h-4 w-4" />新增{tab === 'product' ? '产品' : '物料'}</button>
      </header>

      {notice && <p role="status" className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">{notice}</p>}
      {error && <p role="alert" className="rounded-2xl bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-600">{error}</p>}

      <section className="rounded-[24px] bg-white p-3 shadow-card">
        <div className="grid grid-cols-2 rounded-2xl bg-slate-100 p-1" role="tablist" aria-label="主数据类型">
          {[['product', '产品', Package], ['material', '物料', Boxes]].map(([key, label, Icon]) => <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={`flex min-h-11 items-center justify-center gap-2 rounded-xl text-sm font-bold ${tab === key ? 'bg-white text-budu-600 shadow-sm' : 'text-slate-400'}`}><Icon className="h-4 w-4" />{label}</button>)}
        </div>
        <p className="px-2 pb-1 pt-3 text-xs text-slate-400">共 {visible.length} 项 · 已启用 {activeCount} 项</p>
      </section>

      <div className="space-y-2">
        {loading ? <div className="rounded-[24px] bg-white py-16 text-center text-sm text-slate-300 shadow-card">正在读取主数据…</div> : visible.map((item) => (
          <article key={item.id} data-master-item-id={item.id} className={`rounded-[24px] border bg-white p-4 shadow-card ${item.enabled ? 'border-slate-100' : 'border-slate-100 opacity-70'}`}>
            <div className="flex items-start gap-3">
              <div className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl ${item.enabled ? 'bg-budu-50 text-budu-600' : 'bg-slate-100 text-slate-400'}`}>{tab === 'product' ? <Package className="h-5 w-5" /> : <Boxes className="h-5 w-5" />}</div>
              <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="font-bold text-slate-800">{item.name}</h3><span className={`rounded-full px-2 py-1 text-[11px] font-bold ${item.enabled ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>{item.enabled ? '已启用' : '已停用'}</span></div><p className="mt-1 text-xs text-slate-400">{tab === 'product' ? `编号 ${item.code || '—'} · ` : ''}排序 {item.sortOrder}</p>{item.used && <p className="mt-1 text-[11px] font-semibold text-amber-600">已用于历史调拨/采购 · 仅可停用</p>}</div>
              <button onClick={() => setEditor({ ...item, sortOrder: String(item.sortOrder) })} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-500" aria-label={`编辑${item.name}`}><Pencil className="h-4 w-4" /></button>
            </div>
            <button onClick={() => toggle(item)} disabled={busyId === item.id} className={`mt-3 min-h-10 w-full rounded-xl text-sm font-bold ${item.enabled ? 'bg-slate-100 text-slate-500' : 'bg-budu-50 text-budu-600'}`}>{busyId === item.id ? '处理中…' : item.enabled ? '停用' : '启用'}</button>
          </article>
        ))}
        {!loading && !visible.length && <div className="rounded-[24px] border border-dashed border-slate-200 py-16 text-center text-sm text-slate-300">暂无{tab === 'product' ? '产品' : '物料'}资料</div>}
      </div>

      {editor && <Editor value={editor} busy={busy} onChange={setEditor} onClose={() => setEditor(null)} onSave={save} />}
    </div>
  )
}
