import { useEffect, useState } from 'react'
import { ArrowLeft, Boxes, Check, Pencil, Plus, X } from 'lucide-react'
import { api } from '../utils/api'

const inputClass = 'mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 outline-none focus:border-budu-400 focus:ring-2 focus:ring-budu-100'
const sortRows = (rows) => [...rows].sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder) || a.name.localeCompare(b.name, 'zh-CN'))

function MaterialEditor({ value, busy, onChange, onClose, onSave }) {
  return <div className="fixed inset-0 z-[80] grid place-items-center overflow-y-auto bg-slate-900/45 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={value.id ? '编辑物料' : '新增物料'}>
    <form onSubmit={(event) => { event.preventDefault(); onSave() }} className="my-6 w-full max-w-lg rounded-3xl bg-white shadow-2xl">
      <div className="flex items-center border-b border-slate-100 px-5 py-4"><div><h3 className="font-black text-slate-900">{value.id ? '编辑物料' : '新增物料'}</h3><p className="mt-0.5 text-xs text-slate-400">物料不支持物理删除，停用不影响历史记录</p></div><button type="button" onClick={onClose} className="ml-auto grid h-9 w-9 place-items-center rounded-xl text-slate-400" aria-label="关闭"><X className="h-5 w-5" /></button></div>
      <div className="space-y-4 p-5">
        <label className="block text-xs font-bold text-slate-500">物料名称<input required maxLength={50} value={value.name} onChange={(event) => onChange({ ...value, name: event.target.value })} className={inputClass} /></label>
        <label className="block text-xs font-bold text-slate-500">排序<input aria-label="排序" required type="number" min="0" max="999999" value={value.sortOrder} onChange={(event) => onChange({ ...value, sortOrder: event.target.value })} className={inputClass} /></label>
        <label className="flex items-center justify-between rounded-xl border border-slate-200 p-3 text-sm font-bold text-slate-600">门店调拨启用<input type="checkbox" checked={value.enabled} onChange={(event) => onChange({ ...value, enabled: event.target.checked })} className="h-5 w-5 accent-budu-500" /></label>
      </div>
      <div className="flex justify-end gap-3 border-t border-slate-100 px-5 py-4"><button type="button" onClick={onClose} className="btn-secondary min-h-11 px-5">取消</button><button disabled={busy} className="btn-primary min-h-11 px-6"><Check className="h-4 w-4" />{busy ? '保存中…' : '保存'}</button></div>
    </form>
  </div>
}

export default function ProductMaterialManagementPage({ onBack }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [editor, setEditor] = useState(null)
  const [busy, setBusy] = useState(false)
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = async () => {
    setLoading(true)
    try { const data = await api('/v2/transfer-master-items?category=material'); setRows(sortRows(data.rows || [])); setError('') }
    catch (err) { setError(err.message) } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const save = async () => {
    if (!editor || busy) return
    setBusy(true)
    try {
      const payload = { ...editor, category: 'material', sortOrder: Number(editor.sortOrder), version: editor.version }
      const data = await api(editor.id ? `/v2/transfer-master-items/${editor.id}` : '/v2/transfer-master-items', { method: editor.id ? 'PUT' : 'POST', body: JSON.stringify(payload) })
      const saved = data.item
      setRows((current) => sortRows(editor.id ? current.map((item) => item.id === saved.id ? saved : item) : [...current, saved]))
      setEditor(null); setNotice('物料资料已保存'); setError('')
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  const toggle = async (item) => {
    if (busyId) return
    setBusyId(item.id)
    try {
      const data = await api(`/v2/transfer-master-items/${item.id}`, { method: 'PUT', body: JSON.stringify({ ...item, enabled: !item.enabled }) })
      setRows((current) => sortRows(current.map((row) => row.id === item.id ? data.item : row)))
      setNotice(data.item.enabled ? '物料已启用，新建调拨可选' : '物料已停用，历史记录不受影响'); setError('')
    } catch (err) { setError(err.message) } finally { setBusyId('') }
  }

  return <div className="mx-auto max-w-4xl space-y-4" data-testid="material-management-page">
    <header className="flex flex-wrap items-center gap-3"><button onClick={onBack} className="grid h-10 w-10 place-items-center rounded-2xl bg-white text-slate-500 shadow-card" aria-label="返回首页"><ArrowLeft className="h-5 w-5" /></button><div className="min-w-0 flex-1"><h2 className="text-xl font-bold text-slate-900">物料管理</h2><p className="text-xs text-slate-400">独立维护调拨/采购物料 · 不管理商品或库存数量</p></div><button onClick={() => setEditor({ id: '', category: 'material', name: '', enabled: true, sortOrder: String(rows.reduce((max, item) => Math.max(max, Number(item.sortOrder) || 0), 0) + 1), version: 0 })} className="btn-primary min-h-11 w-full px-4 sm:w-auto"><Plus className="h-4 w-4" />新增物料</button></header>
    {notice && <p role="status" className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">{notice}</p>}{error && <p role="alert" className="rounded-2xl bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-600">{error}</p>}
    <section className="overflow-hidden rounded-[24px] border border-slate-100 bg-white shadow-card">
      {loading ? <p className="py-16 text-center text-sm text-slate-300">正在读取物料主数据…</p> : <div className="divide-y divide-slate-100">{rows.map((item) => <article key={item.id} data-master-item-id={item.id} className={`flex items-center gap-3 px-3 py-3 sm:px-4 ${item.enabled ? '' : 'opacity-70'}`}><div className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl ${item.enabled ? 'bg-budu-50 text-budu-600' : 'bg-slate-100 text-slate-400'}`}><Boxes className="h-5 w-5" /></div><div className="min-w-0 flex-1"><h3 className="truncate font-bold text-slate-800">{item.name}</h3><p className="mt-1 text-xs text-slate-400">排序 {item.sortOrder} · {item.enabled ? '已启用' : '已停用'}</p>{item.used && <p className="mt-1 text-[11px] font-semibold text-amber-600">已用于历史调拨/采购 · 仅可停用</p>}</div><button onClick={() => setEditor({ ...item, sortOrder: String(item.sortOrder) })} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-500" aria-label={`编辑${item.name}`}><Pencil className="h-4 w-4" /></button><button onClick={() => toggle(item)} disabled={busyId === item.id} className="min-h-10 shrink-0 rounded-xl bg-budu-50 px-3 text-xs font-bold text-budu-600">{busyId === item.id ? '…' : item.enabled ? '停用' : '启用'}</button></article>)}</div>}
      {!loading && !rows.length && <p className="py-16 text-center text-sm text-slate-300">暂无物料资料</p>}
    </section>
    {editor && <MaterialEditor value={editor} busy={busy} onChange={setEditor} onClose={() => setEditor(null)} onSave={save} />}
  </div>
}
