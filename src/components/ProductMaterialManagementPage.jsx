import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Boxes, Check, FolderTree, Package, Pencil, Plus, Search, X } from 'lucide-react'
import { api } from '../utils/api'

const sortRows = (rows) => [...rows].sort((a, b) => a.category.localeCompare(b.category) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh-CN'))
const sortCategories = (rows) => [...rows].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh-CN'))

function Modal({ title, subtitle, onClose, children, wide = false }) {
  return <div className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center sm:p-4"><button className="absolute inset-0 bg-slate-950/45 backdrop-blur-sm" onClick={onClose} aria-label="关闭弹层" /><section role="dialog" aria-modal="true" aria-label={title} className={`relative max-h-[92vh] w-full overflow-y-auto rounded-t-[28px] bg-white shadow-2xl sm:rounded-[28px] ${wide ? 'sm:max-w-2xl' : 'sm:max-w-lg'}`}><div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-100 bg-white/95 px-5 py-4 backdrop-blur"><div><h3 className="font-bold text-slate-900">{title}</h3>{subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}</div><button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full bg-slate-100 text-slate-500" aria-label="关闭"><X className="h-4 w-4" /></button></div>{children}</section></div>
}

function ItemEditor({ value, categories, busy, onChange, onClose, onSave }) {
  const product = value.category === 'product'
  const selectableCategories = categories.filter((category) => category.isActive || category.id === value.productCategoryId)
  return <Modal title={`${value.id ? '编辑' : '新增'}${product ? '产品' : '物料'}`} subtitle="仅维护调拨基础资料，不关联库存数量" onClose={onClose}><div className="space-y-4 p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
    {product && <label className="block text-xs font-bold text-slate-500">产品编号<input aria-label="产品编号" value={value.code} onChange={(event) => onChange({ ...value, code: event.target.value.slice(0, 40) })} className="input mt-1.5" placeholder="例如 NO.13" /></label>}
    <label className="block text-xs font-bold text-slate-500">{product ? '产品名称' : '物料名称'}<input aria-label={product ? '产品名称' : '物料名称'} value={value.name} onChange={(event) => onChange({ ...value, name: event.target.value.slice(0, 50) })} className="input mt-1.5" placeholder={`请输入${product ? '产品' : '物料'}名称`} /></label>
    {product && <label className="block text-xs font-bold text-slate-500">所属分类<select aria-label="所属分类" value={value.productCategoryId || ''} onChange={(event) => onChange({ ...value, productCategoryId: event.target.value })} className="input mt-1.5"><option value="">未分类</option>{selectableCategories.map((category) => <option key={category.id} value={category.id}>{category.name}{category.isActive ? '' : '（已停用）'}</option>)}</select></label>}
    <label className="block text-xs font-bold text-slate-500">排序<input aria-label="排序" type="number" min="0" max="999999" inputMode="numeric" value={value.sortOrder} onChange={(event) => onChange({ ...value, sortOrder: event.target.value.replace(/\D/g, '').slice(0, 6) })} className="input mt-1.5" /></label>
    <label className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3 text-sm font-bold text-slate-600"><span><span className="block">新建调拨可选</span><span className="mt-0.5 block text-[11px] font-medium text-slate-400">停用后历史记录仍保留</span></span><input aria-label="启用状态" type="checkbox" checked={value.enabled} onChange={(event) => onChange({ ...value, enabled: event.target.checked })} className="h-5 w-5 accent-budu-500" /></label>
    <div className="grid grid-cols-2 gap-3 pt-1"><button onClick={onClose} className="btn-secondary min-h-12">取消</button><button onClick={onSave} disabled={busy || !value.name.trim() || (product && !value.code.trim())} className="btn-primary min-h-12 disabled:cursor-not-allowed disabled:opacity-40"><Check className="h-4 w-4" />{busy ? '保存中…' : '保存'}</button></div>
  </div></Modal>
}

function CategoryManager({ categories, onClose, onSaved }) {
  const [editor, setEditor] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async () => {
    if (!editor || busy) return
    setBusy(true)
    try {
      const payload = { ...editor, sortOrder: Number(editor.sortOrder) }
      const data = await api(editor.id ? `/v2/product-categories/${editor.id}` : '/v2/product-categories', { method: editor.id ? 'PUT' : 'POST', body: JSON.stringify(payload) })
      onSaved(data.category); setEditor(null); setError('')
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  const toggle = async (category) => {
    setBusy(true)
    try {
      const data = await api(`/v2/product-categories/${category.id}`, { method: 'PUT', body: JSON.stringify({ ...category, isActive: !category.isActive }) })
      onSaved(data.category); setError('')
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  return <Modal title="分类管理" subtitle="一级产品分类 · 停用不会改写产品或历史调拨" onClose={onClose} wide><div className="space-y-3 p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
    <div className="flex justify-end"><button onClick={() => setEditor({ id: '', name: '', sortOrder: String(categories.reduce((max, row) => Math.max(max, row.sortOrder), 0) + 1), isActive: true, version: 0 })} className="btn-primary min-h-10 px-4"><Plus className="h-4 w-4" />新增分类</button></div>
    {error && <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-600">{error}</p>}
    <div className="divide-y divide-slate-100 rounded-2xl border border-slate-100">{categories.map((category) => <div key={category.id} data-category-id={category.id} className="flex items-center gap-3 px-3 py-3"><div className="min-w-0 flex-1"><p className="font-bold text-slate-800">{category.name}</p><p className="mt-0.5 text-xs text-slate-400">排序 {category.sortOrder} · {category.productCount || 0} 个产品 · {category.isActive ? '已启用' : '已停用'}</p></div><button onClick={() => setEditor({ ...category, sortOrder: String(category.sortOrder) })} className="grid h-9 w-9 place-items-center rounded-xl bg-slate-100 text-slate-500" aria-label={`编辑分类${category.name}`}><Pencil className="h-4 w-4" /></button><button onClick={() => toggle(category)} disabled={busy} className="min-h-9 rounded-xl bg-budu-50 px-3 text-xs font-bold text-budu-600">{category.isActive ? '停用' : '启用'}</button></div>)}</div>
    {!categories.length && <p className="rounded-2xl border border-dashed border-slate-200 py-12 text-center text-sm text-slate-300">尚未创建分类</p>}
    {editor && <div className="space-y-3 rounded-2xl bg-slate-50 p-4"><div className="flex items-center justify-between"><p className="text-sm font-bold text-slate-700">{editor.id ? '编辑分类' : '新增分类'}</p><button onClick={() => setEditor(null)} aria-label="关闭分类编辑"><X className="h-4 w-4 text-slate-400" /></button></div><label className="block text-xs font-bold text-slate-500">分类名称<input aria-label="分类名称" value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value.slice(0, 30) })} className="input mt-1.5" /></label><label className="block text-xs font-bold text-slate-500">分类排序<input aria-label="分类排序" type="number" min="0" max="999999" value={editor.sortOrder} onChange={(event) => setEditor({ ...editor, sortOrder: event.target.value.replace(/\D/g, '').slice(0, 6) })} className="input mt-1.5" /></label><label className="flex items-center justify-between text-sm font-bold text-slate-600">启用分类<input aria-label="分类启用状态" type="checkbox" checked={editor.isActive} onChange={(event) => setEditor({ ...editor, isActive: event.target.checked })} className="h-5 w-5 accent-budu-500" /></label><button onClick={save} disabled={busy || !editor.name.trim()} className="btn-primary min-h-11 w-full disabled:opacity-40"><Check className="h-4 w-4" />保存分类</button></div>}
  </div></Modal>
}

export default function ProductMaterialManagementPage({ onBack }) {
  const [tab, setTab] = useState('product')
  const [rows, setRows] = useState([])
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [editor, setEditor] = useState(null)
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [selectedIds, setSelectedIds] = useState([])
  const [bulkCategoryId, setBulkCategoryId] = useState('')
  const [busy, setBusy] = useState(false)
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const [itemData, categoryData] = await Promise.all([api('/v2/transfer-master-items'), api('/v2/product-categories')])
      setRows(sortRows(itemData.rows || [])); setCategories(sortCategories(categoryData.rows || [])); setError('')
    } catch (err) { setError(err.message) } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const productRows = useMemo(() => rows.filter((item) => item.category === 'product'), [rows])
  const visibleProducts = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase('zh-CN')
    return productRows.filter((item) => {
      if (keyword && !`${item.name} ${item.code}`.toLocaleLowerCase('zh-CN').includes(keyword)) return false
      if (categoryFilter === 'uncategorized' && item.productCategoryId) return false
      if (!['all', 'uncategorized'].includes(categoryFilter) && item.productCategoryId !== categoryFilter) return false
      if (statusFilter === 'active' && !item.enabled) return false
      if (statusFilter === 'inactive' && item.enabled) return false
      return true
    })
  }, [productRows, search, categoryFilter, statusFilter])
  const materialRows = rows.filter((item) => item.category === 'material')
  const categoryCount = (id) => productRows.filter((item) => id === 'all' || (id === 'uncategorized' ? !item.productCategoryId : item.productCategoryId === id)).length

  const openAdd = () => {
    const visible = tab === 'product' ? productRows : materialRows
    setEditor({ id: '', category: tab, name: '', code: '', productCategoryId: '', sortOrder: String(visible.reduce((max, item) => Math.max(max, Number(item.sortOrder) || 0), 0) + 1), enabled: true, version: 0 }); setError('')
  }
  const save = async () => {
    if (!editor || busy) return
    setBusy(true)
    try {
      const payload = { ...editor, sortOrder: Number(editor.sortOrder), version: editor.version }
      const data = await api(editor.id ? `/v2/transfer-master-items/${editor.id}` : '/v2/transfer-master-items', { method: editor.id ? 'PUT' : 'POST', body: JSON.stringify(payload) })
      const saved = data.item
      setRows((current) => sortRows(editor.id ? current.map((item) => item.id === saved.id ? saved : item) : [...current, saved])); setEditor(null); setNotice(`${saved.category === 'product' ? '产品' : '物料'}资料已保存`); setError('')
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  const toggle = async (item) => {
    if (busyId) return
    setBusyId(item.id)
    try {
      const data = await api(`/v2/transfer-master-items/${item.id}`, { method: 'PUT', body: JSON.stringify({ ...item, enabled: !item.enabled }) })
      setRows((current) => sortRows(current.map((row) => row.id === item.id ? data.item : row))); setNotice(data.item.enabled ? '已启用，新建调拨可选' : '已停用，历史记录不受影响'); setError('')
    } catch (err) { setError(err.message) } finally { setBusyId('') }
  }
  const saveCategory = (category) => {
    setCategories((current) => sortCategories(current.some((row) => row.id === category.id) ? current.map((row) => row.id === category.id ? category : row) : [...current, category]))
    setRows((current) => current.map((item) => item.productCategoryId === category.id ? { ...item, productCategory: category } : item))
  }
  const applyBulkCategory = async () => {
    if (!selectedIds.length || busy) return
    const count = selectedIds.length
    setBusy(true)
    try {
      await api('/v2/transfer-master-items/bulk-category', { method: 'PUT', body: JSON.stringify({ ids: selectedIds, productCategoryId: bulkCategoryId }) })
      await load(); setSelectedIds([]); setNotice(`已批量归类 ${count} 个产品`)
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  const visibleIds = visibleProducts.map((item) => item.id)
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id))

  return <div className="mx-auto max-w-5xl space-y-4" data-testid="product-material-management-page">
    <header className="flex flex-wrap items-center gap-3"><button onClick={onBack} className="grid h-10 w-10 place-items-center rounded-2xl bg-white text-slate-500 shadow-card" aria-label="返回首页"><ArrowLeft className="h-5 w-5" /></button><div className="min-w-0 flex-1"><h2 className="text-xl font-bold text-slate-900">产品物料管理</h2><p className="text-xs text-slate-400">PostgreSQL 主数据 · 不管理库存数量</p></div><div className="flex w-full gap-2 sm:w-auto">{tab === 'product' && <button onClick={() => setCategoryManagerOpen(true)} className="btn-secondary min-h-11 flex-1 px-3"><FolderTree className="h-4 w-4" />分类管理</button>}<button onClick={openAdd} className="btn-primary min-h-11 flex-1 px-3"><Plus className="h-4 w-4" />新增{tab === 'product' ? '产品' : '物料'}</button></div></header>
    {notice && <p role="status" className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">{notice}</p>}{error && <p role="alert" className="rounded-2xl bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-600">{error}</p>}
    <section className="rounded-[24px] bg-white p-3 shadow-card"><div className="grid grid-cols-2 rounded-2xl bg-slate-100 p-1" role="tablist" aria-label="主数据类型">{[['product', '产品', Package], ['material', '物料', Boxes]].map(([key, label, Icon]) => <button key={key} role="tab" aria-selected={tab === key} onClick={() => { setTab(key); setSelectedIds([]) }} className={`flex min-h-11 items-center justify-center gap-2 rounded-xl text-sm font-bold ${tab === key ? 'bg-white text-budu-600 shadow-sm' : 'text-slate-400'}`}><Icon className="h-4 w-4" />{label}</button>)}</div></section>
    {tab === 'product' ? <>
      <section className="space-y-3 rounded-[24px] bg-white p-3 shadow-card"><div className="grid gap-2 sm:grid-cols-[1fr_150px]"><label className="relative"><Search className="absolute left-3 top-3.5 h-4 w-4 text-slate-300" /><input aria-label="搜索名称或编号" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称 / 编号" className="input pl-9" /></label><select aria-label="产品状态筛选" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="input"><option value="all">全部状态</option><option value="active">已启用</option><option value="inactive">已停用</option></select></div><div className="flex gap-2 overflow-x-auto pb-1" aria-label="产品分类筛选"><button onClick={() => setCategoryFilter('all')} className={`shrink-0 rounded-full px-3 py-2 text-xs font-bold ${categoryFilter === 'all' ? 'bg-budu-600 text-white' : 'bg-slate-100 text-slate-500'}`}>全部 {categoryCount('all')}</button><button onClick={() => setCategoryFilter('uncategorized')} className={`shrink-0 rounded-full px-3 py-2 text-xs font-bold ${categoryFilter === 'uncategorized' ? 'bg-budu-600 text-white' : 'bg-slate-100 text-slate-500'}`}>未分类 {categoryCount('uncategorized')}</button>{categories.map((category) => <button key={category.id} onClick={() => setCategoryFilter(category.id)} className={`shrink-0 rounded-full px-3 py-2 text-xs font-bold ${categoryFilter === category.id ? 'bg-budu-600 text-white' : 'bg-slate-100 text-slate-500'}`}>{category.name} {categoryCount(category.id)}{category.isActive ? '' : ' · 停用'}</button>)}</div></section>
      {selectedIds.length > 0 && <section className="sticky top-2 z-20 flex flex-wrap items-center gap-2 rounded-2xl border border-budu-100 bg-white/95 p-3 shadow-lg backdrop-blur" data-testid="bulk-category-bar"><span className="mr-auto text-sm font-bold text-budu-700">已选择 {selectedIds.length} 项</span><select aria-label="批量目标分类" value={bulkCategoryId} onChange={(event) => setBulkCategoryId(event.target.value)} className="input min-w-[150px] flex-1 sm:flex-none"><option value="">未分类</option>{categories.filter((category) => category.isActive).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select><button onClick={applyBulkCategory} disabled={busy} className="btn-primary min-h-11 px-4">移动到分类</button></section>}
      <div className="overflow-hidden rounded-[24px] border border-slate-100 bg-white shadow-card"><label className="flex items-center gap-3 border-b border-slate-100 px-4 py-3 text-xs font-bold text-slate-500"><input aria-label="选择当前筛选全部产品" type="checkbox" checked={allVisibleSelected} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...new Set([...current, ...visibleIds])] : current.filter((id) => !visibleIds.includes(id)))} className="h-4 w-4 accent-budu-500" />当前筛选 {visibleProducts.length} 项</label>{loading ? <p className="py-16 text-center text-sm text-slate-300">正在读取主数据…</p> : <div className="divide-y divide-slate-100">{visibleProducts.map((item) => { const displayName = item.code && item.name.startsWith(item.code) ? item.name.slice(item.code.length) : item.name; return <div key={item.id} data-master-item-id={item.id} className="flex items-center gap-3 px-3 py-3"><input aria-label={`选择${item.name}`} type="checkbox" checked={selectedIds.includes(item.id)} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} className="h-4 w-4 shrink-0 accent-budu-500" /><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-slate-800"><span className="mr-2 text-budu-600">{item.code || '—'}</span>{displayName}</p><p className="mt-1 truncate text-xs text-slate-400">{item.productCategory?.name || '未分类'} · {item.enabled ? '已启用' : '已停用'} · 排序 {item.sortOrder}</p></div><button onClick={() => setEditor({ ...item, sortOrder: String(item.sortOrder) })} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-500" aria-label={`编辑${item.name}`}><Pencil className="h-4 w-4" /></button><button onClick={() => toggle(item)} disabled={busyId === item.id} className="min-h-9 shrink-0 rounded-xl bg-budu-50 px-3 text-xs font-bold text-budu-600">{busyId === item.id ? '…' : item.enabled ? '停用' : '启用'}</button></div> })}</div>}{!loading && !visibleProducts.length && <p className="py-16 text-center text-sm text-slate-300">当前筛选下暂无产品</p>}</div>
    </> : <div className="space-y-2">{loading ? <div className="rounded-[24px] bg-white py-16 text-center text-sm text-slate-300 shadow-card">正在读取主数据…</div> : materialRows.map((item) => <article key={item.id} data-master-item-id={item.id} className={`rounded-[24px] border bg-white p-4 shadow-card ${item.enabled ? 'border-slate-100' : 'border-slate-100 opacity-70'}`}><div className="flex items-start gap-3"><div className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl ${item.enabled ? 'bg-budu-50 text-budu-600' : 'bg-slate-100 text-slate-400'}`}><Boxes className="h-5 w-5" /></div><div className="min-w-0 flex-1"><h3 className="font-bold text-slate-800">{item.name}</h3><p className="mt-1 text-xs text-slate-400">排序 {item.sortOrder} · {item.enabled ? '已启用' : '已停用'}</p>{item.used && <p className="mt-1 text-[11px] font-semibold text-amber-600">已用于历史调拨/采购 · 仅可停用</p>}</div><button onClick={() => setEditor({ ...item, sortOrder: String(item.sortOrder) })} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-500" aria-label={`编辑${item.name}`}><Pencil className="h-4 w-4" /></button></div><button onClick={() => toggle(item)} disabled={busyId === item.id} className="mt-3 min-h-10 w-full rounded-xl bg-slate-100 text-sm font-bold text-slate-500">{busyId === item.id ? '处理中…' : item.enabled ? '停用' : '启用'}</button></article>)}{!loading && !materialRows.length && <div className="rounded-[24px] border border-dashed border-slate-200 py-16 text-center text-sm text-slate-300">暂无物料资料</div>}</div>}
    {editor && <ItemEditor value={editor} categories={categories} busy={busy} onChange={setEditor} onClose={() => setEditor(null)} onSave={save} />}
    {categoryManagerOpen && <CategoryManager categories={categories} onClose={() => setCategoryManagerOpen(false)} onSaved={saveCategory} />}
  </div>
}
