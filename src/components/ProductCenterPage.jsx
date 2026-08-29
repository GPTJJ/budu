import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, Check, CheckCircle2, Download, FolderTree, ImagePlus, Package, Pencil, Plus, Search, Upload, X } from 'lucide-react'
import * as XLSX from 'xlsx'
import { api } from '../utils/api'
import { centsToYuan, compressProductImage, formatCents, yuanToCents } from '../utils/pos'
import { analyzeProductMenuSheets, applyAutoSku } from '../utils/productExcel'
import LazyImage from './LazyImage'

const emptyForm = {
  productId: '',
  name: '',
  sku: '',
  transferCode: '',
  posCategory: '',
  productCategoryId: '',
  salePrice: '',
  costPrice: '',
  unit: '份',
  image: '',
  imageDirty: false,
  hasImage: false,
  barcode: '',
  isActive: true,
  transferEnabled: false,
  partnerSupplyEnabled: false,
  productGroupId: '',
  variantName: '',
  trackInventory: false,
  sortOrder: 0,
  version: 1,
}

const inputClass = 'mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 outline-none transition focus:border-budu-400 focus:ring-2 focus:ring-budu-100'

function toForm(product) {
  return {
    ...emptyForm,
    ...product,
    salePrice: centsToYuan(product.salePriceCents),
    costPrice: centsToYuan(product.costPriceCents),
    image: '',
    imageDirty: false,
  }
}

function versionedImageUrl(path, updatedAt) {
  return `${path}?v=${encodeURIComponent(updatedAt || '')}`
}

function productThumbnailUrl(product, prefix = '/api/v2/products') {
  return product?.hasImage ? versionedImageUrl(`${prefix}/${product.productId}/thumbnail`, product.updatedAt) : ''
}

function productOriginalUrl(product) {
  return product?.hasImage ? versionedImageUrl(`/api/v2/products/${product.productId}/image`, product.updatedAt) : ''
}

function groupThumbnailUrl(group, prefix = '/api/v2/product-groups') {
  return group?.hasCoverImage ? versionedImageUrl(`${prefix}/${group.id}/thumbnail`, group.updatedAt) : ''
}

function groupOriginalUrl(group) {
  return group?.hasCoverImage ? versionedImageUrl(`/api/v2/product-groups/${group.id}/image`, group.updatedAt) : ''
}

function purposeEnabled(product, purpose) {
  if (purpose === 'pos') return product.isActive
  if (purpose === 'transfer') return product.transferEnabled
  if (purpose === 'partner') return product.partnerSupplyEnabled
  return product.isActive || product.transferEnabled || product.partnerSupplyEnabled
}

function CategoryManager({ categories, onClose, onSaved }) {
  const [editor, setEditor] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async () => {
    if (!editor?.name.trim() || busy) return
    setBusy(true)
    try {
      const data = await api(editor.id ? `/v2/product-categories/${editor.id}` : '/v2/product-categories', { method: editor.id ? 'PUT' : 'POST', body: JSON.stringify({ ...editor, sortOrder: Number(editor.sortOrder) }) })
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
  return <div className="fixed inset-0 z-[90] grid place-items-center overflow-y-auto bg-slate-900/45 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="分类管理"><div className="my-6 w-full max-w-xl rounded-3xl bg-white shadow-2xl"><div className="flex items-center border-b border-slate-100 px-5 py-4"><div><h3 className="font-black text-slate-900">分类管理</h3><p className="text-xs text-slate-400">全系统唯一 ProductCategory</p></div><button onClick={onClose} className="ml-auto grid h-9 w-9 place-items-center rounded-xl text-slate-400" aria-label="关闭"><X className="h-5 w-5" /></button></div><div className="space-y-3 p-5"><div className="flex justify-end"><button onClick={() => setEditor({ id: '', name: '', sortOrder: String(categories.reduce((max, row) => Math.max(max, row.sortOrder), 0) + 1), isActive: true, version: 0 })} className="btn-primary min-h-10 px-4"><Plus className="h-4 w-4" />新增分类</button></div>{error && <p className="rounded-xl bg-rose-50 p-3 text-sm font-bold text-rose-600">{error}</p>}<div className="divide-y divide-slate-100 rounded-2xl border border-slate-100">{categories.map((category) => <div key={category.id} data-category-id={category.id} className="flex items-center gap-2 px-3 py-3"><div className="min-w-0 flex-1"><p className="truncate font-bold text-slate-800">{category.name}</p><p className="text-xs text-slate-400">排序 {category.sortOrder} · {category.productCount || 0} 个商品 · {category.isActive ? '已启用' : '已停用'}</p></div><button onClick={() => setEditor({ ...category, sortOrder: String(category.sortOrder) })} className="grid h-9 w-9 place-items-center rounded-xl bg-slate-100 text-slate-500" aria-label={`编辑分类${category.name}`}><Pencil className="h-4 w-4" /></button><button onClick={() => toggle(category)} disabled={busy} className="min-h-9 rounded-xl bg-budu-50 px-3 text-xs font-bold text-budu-600">{category.isActive ? '停用' : '启用'}</button></div>)}</div>{editor && <div className="space-y-3 rounded-2xl bg-slate-50 p-4"><label className="block text-xs font-bold text-slate-500">分类名称<input aria-label="分类名称" value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} className={inputClass} /></label><label className="block text-xs font-bold text-slate-500">分类排序<input aria-label="分类排序" type="number" min="0" value={editor.sortOrder} onChange={(event) => setEditor({ ...editor, sortOrder: event.target.value })} className={inputClass} /></label><label className="flex items-center justify-between text-sm font-bold text-slate-600">启用分类<input type="checkbox" checked={editor.isActive} onChange={(event) => setEditor({ ...editor, isActive: event.target.checked })} className="h-5 w-5 accent-budu-500" /></label><button onClick={save} disabled={busy} className="btn-primary min-h-11 w-full"><Check className="h-4 w-4" />保存分类</button></div>}</div></div></div>
}

function ProductGroupManager({ groups, products, onClose, onSaved }) {
  const [editor, setEditor] = useState(null)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const startEditor = (group = null) => {
    setSearch('')
    setError('')
    setEditor(group ? {
      id: group.id, name: group.name, coverImage: '', coverImageDirty: false, hasCoverImage: group.hasCoverImage, updatedAt: group.updatedAt, sortOrder: String(group.sortOrder), isActive: group.isActive, version: group.version,
      members: (group.members || []).map((member) => ({ productId: member.productId, variantName: member.variantName || '' })),
    } : { id: '', name: '', coverImage: '', coverImageDirty: false, hasCoverImage: false, updatedAt: '', sortOrder: String(groups.reduce((max, row) => Math.max(max, row.sortOrder), 0) + 1), isActive: true, version: 0, members: [] })
  }
  const selected = new Map((editor?.members || []).map((member) => [member.productId, member]))
  const candidates = products.filter((product) => !product.productGroupId || product.productGroupId === editor?.id).filter((product) => {
    const q = search.trim().toLowerCase()
    return !q || [product.name, product.sku, product.variantName].some((value) => String(value || '').toLowerCase().includes(q))
  })
  const toggleMember = (product) => setEditor((current) => ({
    ...current,
    members: current.members.some((member) => member.productId === product.productId)
      ? current.members.filter((member) => member.productId !== product.productId)
      : [...current.members, { productId: product.productId, variantName: product.variantName || '' }],
  }))
  const updateVariant = (productId, variantName) => setEditor((current) => ({ ...current, members: current.members.map((member) => member.productId === productId ? { ...member, variantName } : member) }))
  const handleCover = async (file) => {
    if (!file) return
    try { const coverImage = await compressProductImage(file); setEditor((current) => ({ ...current, coverImage, coverImageDirty: true, hasCoverImage: true })); setError('') } catch (err) { setError(err.message) }
  }
  const save = async () => {
    if (!editor?.name.trim() || busy) return
    if (editor.members.some((member) => !member.variantName.trim())) { setError('已选择商品都必须填写款式名称'); return }
    setBusy(true); setError('')
    try {
      const body = { ...editor, sortOrder: Number(editor.sortOrder), members: editor.members.map((member) => ({ ...member, variantName: member.variantName.trim() })) }
      delete body.coverImageDirty
      delete body.hasCoverImage
      delete body.updatedAt
      if (editor.id && !editor.coverImageDirty) delete body.coverImage
      const data = await api(editor.id ? `/v2/product-groups/${editor.id}` : '/v2/product-groups', {
        method: editor.id ? 'PUT' : 'POST',
        body: JSON.stringify(body),
      })
      await onSaved(data.group); setEditor(null)
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  const editorPreview = editor ? editor.coverImage || (!editor.coverImageDirty ? groupOriginalUrl(editor) : '') : ''
  return <div className="fixed inset-0 z-[90] grid place-items-center overflow-y-auto bg-slate-900/45 p-3 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="商品组管理"><div className="my-4 flex max-h-[94dvh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl"><div className="flex shrink-0 items-center border-b border-slate-100 px-5 py-4"><div><h3 className="font-black text-slate-900">商品组管理</h3><p className="text-xs text-slate-400">只组织 POS 展示，真实 SKU 身份保持不变</p></div><button onClick={onClose} className="ml-auto grid h-9 w-9 place-items-center rounded-xl text-slate-400" aria-label="关闭商品组管理"><X className="h-5 w-5" /></button></div><div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">{error && <p className="mb-3 rounded-xl bg-rose-50 p-3 text-sm font-bold text-rose-600">{error}</p>}{!editor ? <div className="space-y-3"><div className="flex justify-end"><button onClick={() => startEditor()} className="btn-primary min-h-10 px-4"><Plus className="h-4 w-4" />新建商品组</button></div><div className="divide-y divide-slate-100 rounded-2xl border border-slate-100">{groups.length === 0 ? <p className="p-8 text-center text-sm text-slate-400">暂无商品组</p> : groups.map((group) => <div key={group.id} data-product-group-id={group.id} className="flex items-start gap-3 px-3 py-4"><div className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-xl bg-slate-100">{group.hasCoverImage ? <LazyImage src={groupThumbnailUrl(group)} alt="" className="h-full w-full object-cover" /> : <Package className="h-5 w-5 text-slate-300" />}</div><div className="min-w-0 flex-1"><p className="truncate font-black text-slate-800">{group.name}</p><p className="mt-1 text-xs text-slate-400">{group.memberCount} 个款式 · 排序 {group.sortOrder} · {group.isActive ? 'POS 聚合 ✓' : '已停用'}</p><p className="mt-1 truncate text-xs text-slate-400">{(group.members || []).map((member) => member.variantName).filter(Boolean).join(' · ') || '尚未添加款式'}</p></div><button onClick={() => startEditor(group)} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-budu-50 text-budu-600" aria-label={`编辑商品组${group.name}`}><Pencil className="h-4 w-4" /></button></div>)}</div></div> : <div className="space-y-4"><button onClick={() => setEditor(null)} className="text-xs font-bold text-slate-400">← 返回商品组列表</button><div className="grid gap-4 sm:grid-cols-[140px_1fr]"><div><div className="aspect-square overflow-hidden rounded-2xl border border-dashed border-slate-300 bg-slate-50">{editorPreview ? <img src={editorPreview} alt="商品组主图" className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center text-center text-slate-400"><ImagePlus className="h-7 w-7" /><span className="text-xs">可选主图</span></div>}</div><label className="mt-2 block cursor-pointer rounded-xl border border-slate-200 px-3 py-2 text-center text-xs font-bold text-slate-600">选择主图<input type="file" accept="image/*" className="hidden" onChange={(event) => handleCover(event.target.files?.[0])} /></label>{editorPreview && <button onClick={() => setEditor((current) => ({ ...current, coverImage: '', coverImageDirty: true, hasCoverImage: false }))} className="mt-2 w-full text-xs text-slate-400">移除主图</button>}</div><div className="space-y-3"><label className="block text-xs font-bold text-slate-500">商品组名称<input aria-label="商品组名称" value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} className={inputClass} /></label><label className="block text-xs font-bold text-slate-500">商品组排序<input aria-label="商品组排序" type="number" value={editor.sortOrder} onChange={(event) => setEditor({ ...editor, sortOrder: event.target.value })} className={inputClass} /></label><label className="flex items-center justify-between rounded-xl bg-budu-50 p-3 text-sm font-bold text-slate-600">启用 POS 聚合<input aria-label="启用商品组" type="checkbox" checked={editor.isActive} onChange={(event) => setEditor({ ...editor, isActive: event.target.checked })} className="h-5 w-5 accent-budu-500" /></label></div></div><div className="rounded-2xl border border-slate-200 p-3"><label className="relative block"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input aria-label="搜索组内商品" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索商品名称 / SKU" className="w-full rounded-xl border border-slate-200 py-2.5 pl-9 pr-3 text-sm outline-none" /></label><div className="mt-3 max-h-72 space-y-2 overflow-y-auto">{candidates.map((product) => { const member = selected.get(product.productId); return <div key={product.productId} className="rounded-xl bg-slate-50 p-3"><label className="flex items-start gap-2"><input aria-label={`加入商品组${product.name}`} type="checkbox" checked={Boolean(member)} onChange={() => toggleMember(product)} className="mt-1 h-4 w-4 accent-budu-500" /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold text-slate-700">{product.name}</span><span className="block truncate text-[11px] text-slate-400">SKU {product.sku || '—'}</span></span></label>{member && <label className="mt-2 block pl-6 text-[11px] font-bold text-slate-500">款式名称<input aria-label={`${product.name}款式名称`} value={member.variantName} onChange={(event) => updateVariant(product.productId, event.target.value)} placeholder="例如 蓝" className={inputClass} /></label>}</div> })}</div></div><button onClick={save} disabled={busy || !editor.name.trim()} className="btn-primary min-h-11 w-full"><Check className="h-4 w-4" />{busy ? '保存中…' : '保存商品组'}</button></div>}</div></div></div>
}

export default function ProductCenterPage({ onBack, user }) {
  const canManage = Boolean(user && ['developer', 'admin', 'finance', 'manager'].includes(user.role))
  const [products, setProducts] = useState([])
  const [productCategories, setProductCategories] = useState([])
  const [productGroups, setProductGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [purpose, setPurpose] = useState('pos')
  const [status, setStatus] = useState('active')
  const [selectedIds, setSelectedIds] = useState([])
  const [bulkCategoryId, setBulkCategoryId] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false)
  const [groupManagerOpen, setGroupManagerOpen] = useState(false)
  const [form, setForm] = useState(null)
  const [importPreview, setImportPreview] = useState(null)
  const [importing, setImporting] = useState(false)
  const [autoSkuEnabled, setAutoSkuEnabled] = useState(false)
  const [skuPrefix, setSkuPrefix] = useState('BUDU-12Y')
  // 勾选自动生成 SKU 时，预览与提交均使用生成后的 SKU（覆盖 Excel 中的原 SKU）
  const previewRows = useMemo(() => {
    if (!importPreview) return []
    const base = importPreview.validRows
    return autoSkuEnabled ? applyAutoSku(base, skuPrefix) : base
  }, [importPreview, autoSkuEnabled, skuPrefix])
  // 表格按「工作表:行号」映射 SKU（有效行显示生成值，无效行保留原值便于排查）
  const skuMap = useMemo(() => {
    const m = {}
    for (const r of previewRows) m[`${r.sourceSheet}:${r.sourceRow}`] = r.sku
    return m
  }, [previewRows])
  const fileInputRef = useRef(null)

  const loadProducts = async () => {
    setLoading(true)
    setError('')
    try {
      const [data, categoryData, groupData] = await Promise.all([api('/v2/products'), api('/v2/product-categories'), api('/v2/product-groups')])
      setProducts(data.rows || [])
      setProductCategories(categoryData.rows || [])
      setProductGroups(groupData.rows || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadProducts() }, [])

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return products.filter((item) => {
      if (category === 'uncategorized' && item.productCategoryId) return false
      if (!['all', 'uncategorized'].includes(category) && item.productCategoryId !== category) return false
      if (status === 'active' && !purposeEnabled(item, purpose)) return false
      if (status === 'inactive' && purposeEnabled(item, purpose)) return false
      return !q || [item.name, item.sku, item.transferCode, item.barcode].some((value) => String(value || '').toLowerCase().includes(q))
    })
  }, [products, search, category, purpose, status])

  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }))

  const handleImage = async (file) => {
    if (!file) return
    setError('')
    try {
      const image = await compressProductImage(file)
      setForm((current) => ({ ...current, image, imageDirty: true, hasImage: true }))
    } catch (e) {
      setError(e.message)
    }
  }

  const handleMenuFile = async (file) => {
    if (!file) return
    setError('')
    setNotice('')
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellText: true })
      const sheets = workbook.SheetNames.map((name) => ({
        name,
        rows: XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: false, defval: '' }),
      }))
      const analysis = analyzeProductMenuSheets(sheets, products)
      if (analysis.rows.length === 0) throw new Error(analysis.sheetErrors[0] || 'Excel 中没有识别到可导入的菜品')
      setImportPreview({ ...analysis, fileName: file.name })
    } catch (e) {
      setError(`菜单分析失败：${e.message}`)
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const exportMenu = () => {
    setError('')
    try {
      const sheet = XLSX.utils.aoa_to_sheet([
        ['商品名称', 'SKU', '商品编号', '正式分类', '售价（元）', '成本价（元）', '单位', '条码', 'POS', '门店调拨', '合作商供货', '排序'],
        ...products.map((item) => [
          item.name,
          item.sku || '',
          item.transferCode || '',
          item.productCategory?.name || '',
          item.salePriceCents == null ? '' : Number(item.salePriceCents) / 100,
          item.costPriceCents == null ? '' : Number(item.costPriceCents) / 100,
          item.unit,
          item.barcode || '',
          item.isActive ? '是' : '否',
          item.transferEnabled ? '是' : '否',
          item.partnerSupplyEnabled ? '是' : '否',
          item.sortOrder,
        ]),
      ])
      sheet['!cols'] = [{ wch: 24 }, { wch: 18 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 18 }, { wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 10 }]
      sheet['!autofilter'] = { ref: `A1:L${Math.max(1, products.length + 1)}` }
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, sheet, '商品菜单')
      XLSX.writeFile(workbook, `budu商品菜单_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.xlsx`)
      setNotice(`已导出 ${products.length} 个商品`)
      setTimeout(() => setNotice(''), 2500)
    } catch (e) {
      setError(`导出失败：${e.message}`)
    }
  }

  const importMenu = async () => {
    if (!importPreview?.validRows.length || importing) return
    setImporting(true)
    setError('')
    try {
      const data = await api('/v2/products/import', {
        method: 'POST',
        body: JSON.stringify({
          rows: previewRows.map((row) => ({
            name: row.name,
            sku: row.sku,
            posCategory: row.posCategory,
            productCategoryId: productCategories.find((category) => category.name === row.posCategory)?.id || '',
            salePriceCents: row.salePriceCents,
            costPriceCents: row.costPriceCents,
            unit: row.unit,
            barcode: row.barcode,
            sortOrder: row.sortOrder,
            ...(Object.prototype.hasOwnProperty.call(row, 'trackInventory') ? { trackInventory: row.trackInventory } : {}),
            isActive: true,
            transferEnabled: false,
            partnerSupplyEnabled: false,
          })),
        }),
      })
      const savedById = new Map((data.rows || []).map((item) => [item.productId, item]))
      setProducts((current) => {
        const next = current.map((item) => savedById.get(item.productId) || item)
        const known = new Set(next.map((item) => item.productId))
        for (const item of data.rows || []) if (!known.has(item.productId)) next.push(item)
        return next.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh-CN'))
      })
      setImportPreview(null)
      setNotice(`菜单导入完成：新增 ${data.created || 0} 个，更新 ${data.updated || 0} 个，已全部自动上架`)
      setTimeout(() => setNotice(''), 5000)
    } catch (e) {
      setError(`导入失败：${e.message}`)
    } finally {
      setImporting(false)
    }
  }

  const save = async (event) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      const body = {
        name: form.name,
        sku: form.sku,
        transferCode: form.transferCode,
        posCategory: form.posCategory,
        productCategoryId: form.productCategoryId,
        productGroupId: form.productGroupId,
        variantName: form.productGroupId ? form.variantName : '',
        salePriceCents: form.salePrice === '' ? '' : yuanToCents(form.salePrice),
        costPriceCents: form.costPrice === '' ? '' : yuanToCents(form.costPrice),
        unit: form.unit,
        barcode: form.barcode,
        isActive: form.isActive,
        transferEnabled: form.transferEnabled,
        partnerSupplyEnabled: form.partnerSupplyEnabled,
        trackInventory: form.trackInventory,
        sortOrder: Number(form.sortOrder),
        ...(form.productId ? { version: form.version } : {}),
        ...(!form.productId || form.imageDirty ? { image: form.image } : {}),
      }
      const data = await api(form.productId ? `/v2/products/${form.productId}` : '/v2/products', {
        method: form.productId ? 'PUT' : 'POST',
        body: JSON.stringify(body),
      })
      const saved = data.product
      setProducts((current) => {
        const next = current.some((item) => item.productId === saved.productId)
          ? current.map((item) => item.productId === saved.productId ? saved : item)
          : [...current, saved]
        return next.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh-CN'))
      })
      setForm(null)
      setNotice(form.productId ? '商品已更新' : '商品已创建')
      setTimeout(() => setNotice(''), 2500)
    } catch (e) {
      if (e.status === 409 && e.data?.latest) {
        setProducts((current) => current.map((item) => item.productId === e.data.latest.productId ? e.data.latest : item))
        setForm(toForm(e.data.latest))
      }
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const saveCategory = (saved) => {
    setProductCategories((current) => [...current.filter((item) => item.id !== saved.id), saved].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh-CN')))
    setProducts((current) => current.map((item) => item.productCategoryId === saved.id ? { ...item, productCategory: saved } : item))
  }

  const saveProductGroup = async (saved) => {
    setProductGroups((current) => [...current.filter((item) => item.id !== saved.id), saved].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh-CN')))
    const data = await api('/v2/products')
    setProducts(data.rows || [])
  }

  const applyBulk = async ({ operation, purpose: targetPurpose, enabled }) => {
    if (!selectedIds.length || bulkBusy) return
    setBulkBusy(true); setError('')
    try {
      const data = await api('/v2/products/bulk', { method: 'PUT', body: JSON.stringify({ ids: selectedIds, operation, productCategoryId: operation === 'category' ? bulkCategoryId : undefined, purpose: targetPurpose, enabled }) })
      const byId = new Map((data.rows || []).map((item) => [item.productId, item]))
      setProducts((current) => current.map((item) => byId.get(item.productId) || item))
      setSelectedIds([]); setNotice(`已批量更新 ${data.updated || 0} 个商品`)
    } catch (err) { setError(err.message) } finally { setBulkBusy(false) }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={onBack} className="grid h-10 w-10 place-items-center rounded-xl border border-slate-200 bg-white text-slate-500 hover:text-budu-600" aria-label="返回">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div>
          <h2 className="text-xl font-bold text-slate-900">商品中心</h2>
          <p className="mt-0.5 text-xs text-slate-400">全门店共享商品主档 · 订单统一引用 product_id</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {canManage && <button onClick={() => setGroupManagerOpen(true)} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-semibold text-slate-600 shadow-sm"><Package className="h-4 w-4" />商品组管理</button>}
          {canManage && <button onClick={() => setCategoryManagerOpen(true)} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-semibold text-slate-600 shadow-sm"><FolderTree className="h-4 w-4" />分类管理</button>}
          {canManage && <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-semibold text-slate-600 shadow-sm hover:border-budu-200 hover:text-budu-600">
            <Upload className="h-4 w-4" />导入菜单
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => handleMenuFile(e.target.files?.[0])} />
          </label>}
          <button onClick={exportMenu} disabled={loading} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-semibold text-slate-600 shadow-sm hover:border-budu-200 hover:text-budu-600 disabled:opacity-50">
            <Download className="h-4 w-4" />导出菜单
          </button>
          {canManage && <button onClick={() => setForm({ ...emptyForm })} className="flex items-center gap-2 rounded-xl bg-budu-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-budu-600">
            <Plus className="h-4 w-4" />新增商品
          </button>}
        </div>
      </div>

      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600">{error}</div>}
      {notice && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-600">{notice}</div>}

      <section className="space-y-3 rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm">
        <div className="grid gap-3 md:grid-cols-[minmax(240px,1fr)_180px_160px]">
          <label className="relative">
            <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input aria-label="搜索商品" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="商品名称 / SKU / 编号" className="w-full rounded-xl border border-slate-200 py-2.5 pl-10 pr-3 text-sm outline-none focus:border-budu-400" />
          </label>
          <select aria-label="商品分类筛选" value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-600 outline-none">
            <option value="all">全部分类</option>
            <option value="uncategorized">未分类</option>
            {productCategories.map((item) => <option key={item.id} value={item.id}>{item.name}{item.isActive ? '' : '（停用）'}</option>)}
          </select>
          <select aria-label="业务状态筛选" value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-600 outline-none">
            <option value="all">全部状态</option>
            <option value="active">启用</option>
            <option value="inactive">停用</option>
          </select>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1" aria-label="业务用途筛选">{[['all', '全部'], ['pos', 'POS'], ['transfer', '门店调拨'], ['partner', '合作商供货']].map(([key, label]) => <button key={key} type="button" onClick={() => setPurpose(key)} className={`shrink-0 rounded-full px-4 py-2 text-xs font-bold ${purpose === key ? 'bg-budu-600 text-white' : 'bg-slate-100 text-slate-500'}`}>{label}</button>)}</div>
      </section>

      {selectedIds.length > 0 && <section className="sticky top-2 z-20 space-y-2 rounded-2xl border border-budu-100 bg-white/95 p-3 shadow-lg backdrop-blur" data-testid="product-bulk-bar"><div className="flex flex-wrap items-center gap-2"><span className="mr-auto text-sm font-black text-budu-700">已选择 {selectedIds.length} 项</span><button onClick={() => setSelectedIds([])} className="text-xs font-bold text-slate-400">取消选择</button></div><div className="flex flex-wrap gap-2"><select aria-label="批量目标分类" value={bulkCategoryId} onChange={(event) => setBulkCategoryId(event.target.value)} className="min-h-10 min-w-36 flex-1 rounded-xl border border-slate-200 px-3 text-xs font-bold text-slate-600"><option value="">未分类</option>{productCategories.filter((item) => item.isActive).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button disabled={bulkBusy} onClick={() => applyBulk({ operation: 'category' })} className="btn-secondary min-h-10 px-3 text-xs">修改分类</button>{[['pos', 'POS'], ['transfer', '调拨'], ['partner', '合作商']].flatMap(([key, label]) => [<button key={`${key}-on`} disabled={bulkBusy} onClick={() => applyBulk({ operation: 'purpose', purpose: key, enabled: true })} className="min-h-10 rounded-xl bg-emerald-50 px-3 text-xs font-bold text-emerald-700">启用{label}</button>, <button key={`${key}-off`} disabled={bulkBusy} onClick={() => applyBulk({ operation: 'purpose', purpose: key, enabled: false })} className="min-h-10 rounded-xl bg-slate-100 px-3 text-xs font-bold text-slate-500">停用{label}</button>])}</div></section>}

      <section className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-3 text-xs font-bold text-slate-400">当前筛选 {rows.length} 个商品</div>
        {loading ? <p className="py-14 text-center text-sm text-slate-400">正在加载商品…</p> : rows.length === 0 ? <div className="px-5 py-14 text-center text-sm text-slate-400"><Package className="mx-auto mb-2 h-8 w-8 text-slate-300" /><p>{purpose === 'partner' ? '暂无符合条件的合作商供货商品' : '暂无符合条件的商品'}</p></div> : (
          <div className="divide-y divide-slate-100">
            {rows.map((item) => (
              <article key={item.productId} data-product-id={item.productId} className="flex items-start gap-2.5 px-3 py-3 sm:gap-3 sm:px-4">
                <input aria-label={`选择${item.name}`} type="checkbox" checked={selectedIds.includes(item.productId)} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...new Set([...current, item.productId])] : current.filter((id) => id !== item.productId))} className="mt-3 h-4 w-4 shrink-0 accent-budu-500" />
                {item.hasImage ? <LazyImage src={productThumbnailUrl(item)} alt="" className="h-11 w-11 shrink-0 rounded-xl object-cover" /> : <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-300"><Package className="h-5 w-5" /></div>}
                <div className="min-w-0 flex-1">
                  <div className="product-title-line">
                    <h3 data-testid="product-title" className="product-mobile-title font-black text-slate-800">{item.name}</h3>
                    <span data-testid="product-price" className="mt-1 block shrink-0 text-sm font-black text-budu-700">{item.salePriceCents == null ? '未设零售价' : formatCents(item.salePriceCents)}</span>
                  </div>
                  <div data-testid="product-badges" className="mt-2 flex flex-wrap gap-1.5">{[['POS', item.isActive], ['调拨', item.transferEnabled], ['合作商', item.partnerSupplyEnabled]].map(([label, enabled]) => <span key={label} className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-400'}`}>{label} {enabled ? '✓' : '—'}</span>)}</div>
                  <p data-testid="product-sku" className="mt-2 break-all text-[11px] font-medium leading-4 text-slate-400">SKU&nbsp;&nbsp;{item.sku || '—'}</p>
                  <p data-testid="product-meta" className="mt-0.5 truncate text-[11px] leading-4 text-slate-400">{item.productCategory?.name || '未分类'} · {item.productGroup ? `${item.productGroup.name} / ${item.variantName || '未命名款式'}` : '未分组'} · 排序 {item.sortOrder}</p>
                </div>
                {canManage ? <button onClick={() => setForm(toForm(item))} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-budu-50 text-budu-600" aria-label={`编辑${item.name}`}><Pencil className="h-4 w-4" /></button> : <span className="text-xs text-slate-300">只读</span>}
              </article>
            ))}
          </div>
        )}
      </section>

      {importPreview && (
        <div className="fixed inset-0 z-[85] grid place-items-center overflow-y-auto bg-slate-900/45 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="菜单导入预览">
          <div className="my-6 flex max-h-[90dvh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl">
            <div className="flex shrink-0 items-center border-b border-slate-100 px-6 py-4">
              <div><h3 className="text-lg font-bold text-slate-900">菜单导入预览</h3><p className="mt-0.5 text-xs text-slate-400">{importPreview.fileName} · 系统已自动匹配菜品名、SKU、分类、售价和成本价</p></div>
              <button onClick={() => setImportPreview(null)} disabled={importing} className="ml-auto grid h-9 w-9 place-items-center rounded-xl text-slate-400 hover:bg-slate-100 disabled:opacity-50" aria-label="关闭"><X className="h-5 w-5" /></button>
            </div>
            <div className="shrink-0 border-b border-slate-100 px-6 py-4">
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
                  <input type="checkbox" checked={autoSkuEnabled} onChange={(e) => setAutoSkuEnabled(e.target.checked)} className="h-4 w-4 accent-budu-500" />
                  自动生成 SKU（忽略表格中的 SKU）
                </label>
                {autoSkuEnabled && (
                  <label className="flex items-center gap-2 text-sm text-slate-500">
                    前缀
                    <input value={skuPrefix} onChange={(e) => setSkuPrefix(e.target.value)} className="w-36 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 outline-none focus:border-budu-400" />
                    <span className="text-xs text-slate-400">示例：{skuPrefix}-01</span>
                  </label>
                )}
              </div>
              <div className="grid grid-cols-3 gap-3 text-center text-sm">
                <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-400">识别菜品</p><p className="mt-1 text-xl font-black text-slate-800">{importPreview.rows.length}</p></div>
                <div className="rounded-xl bg-emerald-50 p-3"><p className="text-xs text-emerald-500">可导入</p><p className="mt-1 text-xl font-black text-emerald-700">{importPreview.validRows.length}</p></div>
                <div className="rounded-xl bg-rose-50 p-3"><p className="text-xs text-rose-500">需检查</p><p className="mt-1 text-xl font-black text-rose-700">{importPreview.rows.length - importPreview.validRows.length}</p></div>
              </div>
              {importPreview.sheetErrors.length > 0 && <div className="mt-3 rounded-xl bg-amber-50 px-4 py-2.5 text-xs text-amber-700">{importPreview.sheetErrors.join('；')}</div>}
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full min-w-[900px] text-left text-xs">
                <thead className="sticky top-0 bg-slate-50 text-slate-400"><tr><th className="px-4 py-3">来源</th><th className="px-4 py-3">菜品名</th><th className="px-4 py-3">SKU</th><th className="px-4 py-3">分类</th><th className="px-4 py-3 text-right">售价</th><th className="px-4 py-3 text-right">成本</th><th className="px-4 py-3">处理方式</th><th className="px-4 py-3">分析结果</th></tr></thead>
                <tbody className="divide-y divide-slate-100">{importPreview.rows.map((row, index) => (
                  <tr key={`${row.sourceSheet}-${row.sourceRow}-${index}`} className={row.errors.length ? 'bg-rose-50/40' : ''}>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-400">{row.sourceSheet} · {row.sourceRow} 行</td>
                    <td className="px-4 py-3 font-semibold text-slate-700">{row.name || '—'}</td>
                    <td className="px-4 py-3 font-mono text-slate-600">{skuMap[`${row.sourceSheet}:${row.sourceRow}`] || row.sku || '—'}</td>
                    <td className="px-4 py-3 text-slate-600">{row.posCategory || '—'}</td>
                    <td className="px-4 py-3 text-right text-slate-700">{row.salePriceCents ? formatCents(row.salePriceCents) : '—'}</td>
                    <td className="px-4 py-3 text-right text-slate-500">{row.costPriceCents ? formatCents(row.costPriceCents) : '—'}</td>
                    <td className="px-4 py-3"><span className={`rounded-full px-2 py-1 font-semibold ${row.action === 'update' ? 'bg-sky-50 text-sky-600' : 'bg-emerald-50 text-emerald-600'}`}>{row.action === 'update' ? '更新并上架' : '新增并上架'}</span></td>
                    <td className="px-4 py-3">{row.errors.length ? <span className="inline-flex items-center gap-1 text-rose-600"><AlertCircle className="h-3.5 w-3.5" />{row.errors.join('；')}</span> : <span className="inline-flex items-center gap-1 text-emerald-600"><CheckCircle2 className="h-3.5 w-3.5" />匹配成功</span>}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-6 py-4">
              <p className="text-xs text-slate-400">有问题的行会自动跳过；已存在商品仅按稳定 SKU 更新，绝不按名称自动关联，所有导入商品自动上架。</p>
              <div className="flex gap-3"><button onClick={() => setImportPreview(null)} disabled={importing} className="rounded-xl border border-slate-200 px-5 py-2.5 text-sm font-semibold text-slate-500 disabled:opacity-50">取消</button><button onClick={importMenu} disabled={importing || importPreview.validRows.length === 0} className="rounded-xl bg-budu-500 px-6 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{importing ? '正在导入…' : `导入并上架 ${importPreview.validRows.length} 项`}</button></div>
            </div>
          </div>
        </div>
      )}

      {form && (
        <div className="fixed inset-0 z-[80] grid place-items-center overflow-y-auto bg-slate-900/45 p-4 backdrop-blur-sm">
          <form onSubmit={save} className="my-6 w-full max-w-3xl rounded-3xl bg-white shadow-2xl">
            <div className="flex items-center border-b border-slate-100 px-6 py-4"><div><h3 className="text-lg font-bold text-slate-900">{form.productId ? '编辑商品' : '新增商品'}</h3><p className="text-xs text-slate-400">商品不支持删除，下架后保留历史关联</p></div><button type="button" onClick={() => setForm(null)} className="ml-auto grid h-9 w-9 place-items-center rounded-xl text-slate-400 hover:bg-slate-100"><X className="h-5 w-5" /></button></div>
            <div className="grid gap-5 p-6 md:grid-cols-[180px_1fr]">
              <div>
                <div className="aspect-square overflow-hidden rounded-2xl border border-dashed border-slate-300 bg-slate-50">{(form.image || (!form.imageDirty ? productOriginalUrl(form) : '')) ? <img src={form.image || productOriginalUrl(form)} alt="商品预览" className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center text-center text-slate-400"><ImagePlus className="mx-auto h-8 w-8" /><span className="mt-2 block text-xs">上传商品图片</span></div>}</div>
                <label className="mt-3 block cursor-pointer rounded-xl border border-slate-200 px-3 py-2.5 text-center text-xs font-semibold text-slate-600 hover:bg-slate-50">选择图片<input type="file" accept="image/*" className="hidden" onChange={(e) => handleImage(e.target.files?.[0])} /></label>
                {(form.image || (!form.imageDirty && form.hasImage)) && <button type="button" onClick={() => setForm((current) => ({ ...current, image: '', imageDirty: true, hasImage: false }))} className="mt-2 w-full text-xs text-slate-400 hover:text-rose-500">移除图片</button>}
              </div>
              <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                <label className="text-xs font-semibold text-slate-500">商品名称<input required value={form.name} onChange={(e) => update('name', e.target.value)} className={inputClass} /></label>
                <label className="text-xs font-semibold text-slate-500">SKU（POS）<input value={form.sku || ''} onChange={(e) => update('sku', e.target.value.toUpperCase().replace(/\s/g, ''))} placeholder="例如 BUDU-001" className={inputClass} /></label>
                <label className="text-xs font-semibold text-slate-500">商品编号（调拨）<input value={form.transferCode || ''} onChange={(e) => update('transferCode', e.target.value.trim())} placeholder="例如 NO.1" className={inputClass} /></label>
                <label className="text-xs font-semibold text-slate-500">商品分类<select aria-label="商品分类" value={form.productCategoryId || ''} onChange={(e) => update('productCategoryId', e.target.value)} className={inputClass}><option value="">未分类</option>{productCategories.filter((item) => item.isActive || item.id === form.productCategoryId).map((item) => <option key={item.id} value={item.id}>{item.name}{item.isActive ? '' : '（停用）'}</option>)}</select></label>
                <label className="text-xs font-semibold text-slate-500">商品组<select aria-label="商品组" value={form.productGroupId || ''} onChange={(e) => { update('productGroupId', e.target.value); if (!e.target.value) update('variantName', '') }} className={inputClass}><option value="">未分组</option>{productGroups.filter((item) => item.isActive || item.id === form.productGroupId).map((item) => <option key={item.id} value={item.id}>{item.name}{item.isActive ? '' : '（停用）'}</option>)}</select></label>
                {form.productGroupId && <label className="text-xs font-semibold text-slate-500">款式名称<input required aria-label="款式名称" value={form.variantName || ''} onChange={(e) => update('variantName', e.target.value)} placeholder="例如 蓝" className={inputClass} /></label>}
                <label className="text-xs font-semibold text-slate-500">单位<input value={form.unit || ''} onChange={(e) => update('unit', e.target.value)} placeholder="份 / 杯 / 个" className={inputClass} /></label>
                <label className="text-xs font-semibold text-slate-500">零售价（元）<input inputMode="decimal" value={form.salePrice} onChange={(e) => update('salePrice', e.target.value)} placeholder="0.00" className={inputClass} /></label>
                <label className="text-xs font-semibold text-slate-500">POS 成本价（元）<input inputMode="decimal" value={form.costPrice} onChange={(e) => update('costPrice', e.target.value)} placeholder="0.00" className={inputClass} /></label>
                <label className="text-xs font-semibold text-slate-500">商品条码（可空）<input value={form.barcode} onChange={(e) => update('barcode', e.target.value)} className={inputClass} /></label>
                <label className="text-xs font-semibold text-slate-500">排序<input type="number" value={form.sortOrder} onChange={(e) => update('sortOrder', e.target.value)} className={inputClass} /></label>
                <div className="space-y-2 rounded-2xl bg-budu-50 p-3 sm:col-span-2"><p className="text-xs font-black text-budu-800">业务用途（相互独立）</p><div className="grid gap-2 sm:grid-cols-3"><label className="flex items-center gap-2 rounded-xl bg-white p-3 text-sm font-bold text-slate-600"><input aria-label="POS 销售" type="checkbox" checked={form.isActive} onChange={(e) => update('isActive', e.target.checked)} className="h-4 w-4 accent-budu-500" />POS 销售</label><label className="flex items-center gap-2 rounded-xl bg-white p-3 text-sm font-bold text-slate-600"><input aria-label="门店调拨" type="checkbox" checked={form.transferEnabled} onChange={(e) => update('transferEnabled', e.target.checked)} className="h-4 w-4 accent-budu-500" />门店调拨</label><label className="flex items-center gap-2 rounded-xl bg-white p-3 text-sm font-bold text-slate-600"><input aria-label="合作商供货" type="checkbox" checked={form.partnerSupplyEnabled} onChange={(e) => update('partnerSupplyEnabled', e.target.checked)} className="h-4 w-4 accent-budu-500" />合作商供货</label></div></div>
                <label className="flex items-center gap-3 rounded-xl border border-slate-200 p-3 text-sm font-medium text-slate-600 sm:col-span-2"><input type="checkbox" checked={form.trackInventory} onChange={(e) => update('trackInventory', e.target.checked)} className="h-4 w-4 accent-budu-500" />参与库存（本阶段不扣减）</label>
              </div>
            </div>
            <div className="flex justify-end gap-3 border-t border-slate-100 px-6 py-4"><button type="button" onClick={() => setForm(null)} className="rounded-xl border border-slate-200 px-5 py-2.5 text-sm font-semibold text-slate-500">取消</button><button disabled={saving} className="rounded-xl bg-budu-500 px-6 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{saving ? '保存中…' : '保存商品'}</button></div>
          </form>
        </div>
      )}
      {categoryManagerOpen && <CategoryManager categories={productCategories} onClose={() => setCategoryManagerOpen(false)} onSaved={saveCategory} />}
      {groupManagerOpen && <ProductGroupManager groups={productGroups} products={products} onClose={() => setGroupManagerOpen(false)} onSaved={saveProductGroup} />}
    </div>
  )
}
