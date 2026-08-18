import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, CheckCircle2, Download, ImagePlus, Package, Pencil, Plus, Search, Upload, X } from 'lucide-react'
import * as XLSX from 'xlsx'
import { api } from '../utils/api'
import { centsToYuan, compressProductImage, formatCents, yuanToCents } from '../utils/pos'
import { analyzeProductMenuSheets, applyAutoSku } from '../utils/productExcel'

const emptyForm = {
  productId: '',
  name: '',
  sku: '',
  posCategory: '',
  salePrice: '',
  costPrice: '',
  unit: '份',
  image: '',
  barcode: '',
  isActive: true,
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
  }
}

export default function ProductCenterPage({ onBack }) {
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [status, setStatus] = useState('all')
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
      const data = await api('/v2/products')
      setProducts(data.rows || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadProducts() }, [])

  const categories = useMemo(
    () => [...new Set(products.map((item) => item.posCategory).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')),
    [products],
  )
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return products.filter((item) => {
      if (category !== 'all' && item.posCategory !== category) return false
      if (status === 'active' && !item.isActive) return false
      if (status === 'inactive' && item.isActive) return false
      return !q || [item.name, item.sku, item.barcode].some((value) => String(value || '').toLowerCase().includes(q))
    })
  }, [products, search, category, status])

  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }))

  const handleImage = async (file) => {
    if (!file) return
    setError('')
    try {
      update('image', await compressProductImage(file))
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
        ['菜品名', 'SKU', '分类', '售价（元）', '成本价（元）', '单位', '条码', '是否上架', '参与库存', '排序'],
        ...products.map((item) => [
          item.name,
          item.sku,
          item.posCategory,
          Number(item.salePriceCents) / 100,
          Number(item.costPriceCents) / 100,
          item.unit,
          item.barcode || '',
          item.isActive ? '是' : '否',
          item.trackInventory ? '是' : '否',
          item.sortOrder,
        ]),
      ])
      sheet['!cols'] = [{ wch: 24 }, { wch: 20 }, { wch: 16 }, { wch: 13 }, { wch: 13 }, { wch: 10 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 10 }]
      sheet['!autofilter'] = { ref: `A1:J${Math.max(1, products.length + 1)}` }
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
            salePriceCents: row.salePriceCents,
            costPriceCents: row.costPriceCents,
            unit: row.unit,
            barcode: row.barcode,
            sortOrder: row.sortOrder,
            ...(Object.prototype.hasOwnProperty.call(row, 'trackInventory') ? { trackInventory: row.trackInventory } : {}),
            isActive: true,
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
        posCategory: form.posCategory,
        salePriceCents: yuanToCents(form.salePrice),
        costPriceCents: yuanToCents(form.costPrice),
        unit: form.unit,
        image: form.image,
        barcode: form.barcode,
        isActive: form.isActive,
        trackInventory: form.trackInventory,
        sortOrder: Number(form.sortOrder),
        ...(form.productId ? { version: form.version } : {}),
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
          <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-semibold text-slate-600 shadow-sm hover:border-budu-200 hover:text-budu-600">
            <Upload className="h-4 w-4" />导入菜单
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => handleMenuFile(e.target.files?.[0])} />
          </label>
          <button onClick={exportMenu} disabled={loading} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-semibold text-slate-600 shadow-sm hover:border-budu-200 hover:text-budu-600 disabled:opacity-50">
            <Download className="h-4 w-4" />导出菜单
          </button>
          <button onClick={() => setForm({ ...emptyForm })} className="flex items-center gap-2 rounded-xl bg-budu-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-budu-600">
            <Plus className="h-4 w-4" />新增商品
          </button>
        </div>
      </div>

      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600">{error}</div>}
      {notice && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-600">{notice}</div>}

      <section className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm">
        <div className="grid gap-3 md:grid-cols-[minmax(240px,1fr)_180px_160px]">
          <label className="relative">
            <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索名称 / SKU / 条码" className="w-full rounded-xl border border-slate-200 py-2.5 pl-10 pr-3 text-sm outline-none focus:border-budu-400" />
          </label>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-600 outline-none">
            <option value="all">全部分类</option>
            {categories.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-600 outline-none">
            <option value="all">全部状态</option>
            <option value="active">已上架</option>
            <option value="inactive">已下架</option>
          </select>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] text-left text-sm">
            <thead className="border-b border-slate-100 bg-slate-50/80 text-xs font-semibold text-slate-400">
              <tr><th className="px-5 py-3">商品</th><th className="px-4 py-3">SKU / 条码</th><th className="px-4 py-3">分类</th><th className="px-4 py-3">售价 / 成本</th><th className="px-4 py-3">库存</th><th className="px-4 py-3">状态</th><th className="px-4 py-3">排序</th><th className="px-5 py-3 text-right">操作</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan="8" className="px-5 py-14 text-center text-slate-400">正在加载商品…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan="8" className="px-5 py-14 text-center text-slate-400"><Package className="mx-auto mb-2 h-8 w-8 text-slate-300" />暂无符合条件的商品</td></tr>
              ) : rows.map((item) => (
                <tr key={item.productId} className="hover:bg-slate-50/70">
                  <td className="px-5 py-3.5"><div className="flex items-center gap-3">{item.image ? <img src={item.image} alt="" className="h-12 w-12 rounded-xl object-cover" /> : <div className="grid h-12 w-12 place-items-center rounded-xl bg-slate-100 text-slate-300"><Package className="h-5 w-5" /></div>}<div><p className="font-semibold text-slate-800">{item.name}</p><p className="mt-0.5 text-xs text-slate-400">{item.unit}</p></div></div></td>
                  <td className="px-4 py-3.5"><p className="font-mono text-xs font-semibold text-slate-600">{item.sku}</p><p className="mt-1 text-xs text-slate-400">{item.barcode || '—'}</p></td>
                  <td className="px-4 py-3.5 text-slate-600">{item.posCategory}</td>
                  <td className="px-4 py-3.5"><p className="font-semibold text-slate-800">{formatCents(item.salePriceCents)}</p><p className="mt-0.5 text-xs text-slate-400">成本 {formatCents(item.costPriceCents)}</p></td>
                  <td className="px-4 py-3.5 text-xs text-slate-500">{item.trackInventory ? '参与库存' : '不参与'}</td>
                  <td className="px-4 py-3.5"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${item.isActive ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>{item.isActive ? '已上架' : '已下架'}</span></td>
                  <td className="px-4 py-3.5 text-slate-500">{item.sortOrder}</td>
                  <td className="px-5 py-3.5 text-right"><button onClick={() => setForm(toForm(item))} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-budu-600 hover:bg-budu-50"><Pencil className="h-3.5 w-3.5" />编辑</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
              <p className="text-xs text-slate-400">有问题的行会自动跳过；已存在商品按 SKU 或菜品名更新，所有导入商品自动上架。</p>
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
                <div className="aspect-square overflow-hidden rounded-2xl border border-dashed border-slate-300 bg-slate-50">{form.image ? <img src={form.image} alt="商品预览" className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center text-center text-slate-400"><ImagePlus className="mx-auto h-8 w-8" /><span className="mt-2 block text-xs">上传商品图片</span></div>}</div>
                <label className="mt-3 block cursor-pointer rounded-xl border border-slate-200 px-3 py-2.5 text-center text-xs font-semibold text-slate-600 hover:bg-slate-50">选择图片<input type="file" accept="image/*" className="hidden" onChange={(e) => handleImage(e.target.files?.[0])} /></label>
                {form.image && <button type="button" onClick={() => update('image', '')} className="mt-2 w-full text-xs text-slate-400 hover:text-rose-500">移除图片</button>}
              </div>
              <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                <label className="text-xs font-semibold text-slate-500">商品名称<input required value={form.name} onChange={(e) => update('name', e.target.value)} className={inputClass} /></label>
                <label className="text-xs font-semibold text-slate-500">唯一 SKU<input required value={form.sku} onChange={(e) => update('sku', e.target.value.toUpperCase().replace(/\s/g, ''))} placeholder="例如 BUDU-001" className={inputClass} /></label>
                <label className="text-xs font-semibold text-slate-500">商品分类<input required list="pos-category-options" value={form.posCategory} onChange={(e) => update('posCategory', e.target.value)} className={inputClass} /><datalist id="pos-category-options">{categories.map((item) => <option key={item} value={item} />)}</datalist></label>
                <label className="text-xs font-semibold text-slate-500">单位<input required value={form.unit} onChange={(e) => update('unit', e.target.value)} placeholder="份 / 杯 / 个" className={inputClass} /></label>
                <label className="text-xs font-semibold text-slate-500">售价（元）<input required inputMode="decimal" value={form.salePrice} onChange={(e) => update('salePrice', e.target.value)} placeholder="0.00" className={inputClass} /></label>
                <label className="text-xs font-semibold text-slate-500">成本价（元）<input required inputMode="decimal" value={form.costPrice} onChange={(e) => update('costPrice', e.target.value)} placeholder="0.00" className={inputClass} /></label>
                <label className="text-xs font-semibold text-slate-500">商品条码（可空）<input value={form.barcode} onChange={(e) => update('barcode', e.target.value)} className={inputClass} /></label>
                <label className="text-xs font-semibold text-slate-500">排序<input type="number" value={form.sortOrder} onChange={(e) => update('sortOrder', e.target.value)} className={inputClass} /></label>
                <label className="flex items-center gap-3 rounded-xl border border-slate-200 p-3 text-sm font-medium text-slate-600"><input type="checkbox" checked={form.isActive} onChange={(e) => update('isActive', e.target.checked)} className="h-4 w-4 accent-budu-500" />上架到 POS</label>
                <label className="flex items-center gap-3 rounded-xl border border-slate-200 p-3 text-sm font-medium text-slate-600"><input type="checkbox" checked={form.trackInventory} onChange={(e) => update('trackInventory', e.target.checked)} className="h-4 w-4 accent-budu-500" />参与库存（本阶段不扣减）</label>
              </div>
            </div>
            <div className="flex justify-end gap-3 border-t border-slate-100 px-6 py-4"><button type="button" onClick={() => setForm(null)} className="rounded-xl border border-slate-200 px-5 py-2.5 text-sm font-semibold text-slate-500">取消</button><button disabled={saving} className="rounded-xl bg-budu-500 px-6 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{saving ? '保存中…' : '保存商品'}</button></div>
          </form>
        </div>
      )}
    </div>
  )
}
