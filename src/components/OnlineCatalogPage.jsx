import { useEffect, useMemo, useState } from 'react'
import { api } from '../utils/api'
import { centsToYuan, compressProductImage, formatCents, yuanToCents } from '../utils/pos'

const EMPTY_FORM = {
  mode: 'new',
  inventoryItemId: '',
  name: '',
  sku: '',
  salePrice: '',
  costPrice: '',
  unit: '份',
  spec: '',
  onlineCategoryId: '',
  mpId: '',
  title: '',
  subtitle: '',
  price: '',
  shelfLife: '',
  storage: '',
  sortOrder: 0,
  status: 'DRAFT',
  media: { cover: '', gallery: [], detail: [] },
}

const STATUS_LABEL = { DRAFT: '草稿', ON: '上架', OFF: '下架' }
const PUBLISH_LABEL = { UNPUBLISHED: '未发布', PUBLISHED: '已发布', FAILED: '发布失败' }
const STATUS_STYLE = {
  ON: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  OFF: 'bg-slate-100 text-slate-500 border-slate-200',
  DRAFT: 'bg-amber-50 text-amber-700 border-amber-200',
}

function Field({ label, children, hint }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-slate-500">{label}</span>
      <div className="mt-1">{children}</div>
      {hint ? <span className="mt-1 block text-[11px] text-slate-400">{hint}</span> : null}
    </label>
  )
}

const inputClass = 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-budu-400 focus:ring-2 focus:ring-budu-100'

// 后端已把 cloud:// 换成临时链接、把 /images/* 映射到 /mp-images/*，这里只取展示值。
function mediaPreview(product) {
  const display = product?.mediaDisplay || {}
  return display.cover || display.gallery?.[0] || ''
}

const DIRECT_SRC = /^(data:image\/|https?:\/\/)/i

function MediaThumb({ src, alt = '', className = 'h-14 w-14', rounded = 'rounded-xl', emptyLabel = '无预览', textClass = 'text-[10px]' }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [src])
  return (
    <div className={`${className} overflow-hidden ${rounded} bg-slate-100`}>
      {src && !failed ? (
        <img src={src} alt={alt} className="h-full w-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <div className={`grid h-full w-full place-items-center ${textClass} text-slate-400`}>{emptyLabel}</div>
      )}
    </div>
  )
}

function Modal({ title, children, onClose, wide = false }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 px-3 py-8">
      <div className={`w-full ${wide ? 'max-w-4xl' : 'max-w-xl'} rounded-2xl bg-white shadow-xl`}>
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h2 className="text-base font-semibold text-slate-800">{title}</h2>
          <button type="button" className="rounded-lg px-2 py-1 text-sm text-slate-400 hover:bg-slate-100" onClick={onClose}>关闭</button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  )
}

export default function OnlineCatalogPage() {
  const [user, setUser] = useState(null)
  const [authError, setAuthError] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [categories, setCategories] = useState([])
  const [products, setProducts] = useState([])
  const [filter, setFilter] = useState('all')
  const [form, setForm] = useState(null)
  const [categoryForm, setCategoryForm] = useState(null)
  const [items, setItems] = useState([])
  const [itemQuery, setItemQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [cloudbaseConfigured, setCloudbaseConfigured] = useState(null)
  const [previewDoc, setPreviewDoc] = useState(null)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [categoryResult, productResult, statusResult] = await Promise.all([
        api('/v2/online-catalog/categories'),
        api('/v2/online-catalog/products'),
        api('/v2/online-catalog/status').catch(() => null),
      ])
      setCategories(categoryResult.categories || [])
      setProducts(productResult.products || [])
      setCloudbaseConfigured(statusResult?.cloudbase?.configured ?? null)
    } catch (err) {
      setError(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    api('/auth/me')
      .then(({ user: current }) => {
        if (cancelled) return null
        setUser(current)
        return load()
      })
      .catch((err) => {
        if (cancelled) return
        setAuthError(err.status === 401 ? '请先登录 OS 后再管理小程序商品。' : (err.message || '登录状态核验失败'))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  const loadItems = async (query = '') => {
    try {
      const result = await api(`/v2/online-catalog/items${query ? `?q=${encodeURIComponent(query)}` : ''}`)
      setItems(result.items || [])
    } catch (err) {
      setError(err.message || '读取 OS 商品失败')
    }
  }

  const openCreate = async () => {
    setForm({ ...EMPTY_FORM, onlineCategoryId: categories.find((category) => category.isActive)?.id || '' })
    setItems([])
    setItemQuery('')
    await loadItems('')
  }

  const openEdit = (product) => {
    setForm({
      mode: 'edit',
      id: product.id,
      inventoryItemId: product.inventoryItemId,
      name: product.item?.name || '',
      sku: product.item?.sku || '',
      onlineCategoryId: product.onlineCategoryId || '',
      mpId: product.mpId,
      title: product.title,
      subtitle: product.subtitle,
      price: product.priceCents === null ? '' : centsToYuan(product.priceCents),
      shelfLife: product.shelfLife,
      storage: product.storage,
      unit: product.unit,
      spec: product.spec,
      sortOrder: product.sortOrder,
      status: product.status,
      media: product.media || { cover: '', gallery: [], detail: [] },
      displayMedia: product.mediaDisplay || { cover: '', gallery: [], detail: [] },
      combo: product.combo || null,
    })
  }

  const chooseItem = (item) => {
    setForm((current) => ({
      ...current,
      inventoryItemId: item.id,
      name: item.name,
      sku: item.sku || '',
      unit: item.unit || '份',
      spec: item.spec || '',
      salePrice: item.salePriceCents === null ? '' : centsToYuan(item.salePriceCents),
      costPrice: item.costPriceCents === null ? '' : centsToYuan(item.costPriceCents),
      title: current.title || item.name,
      price: current.price || (item.salePriceCents === null ? '' : centsToYuan(item.salePriceCents)),
    }))
  }

  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }))

  // 新上传的图片本身是 data:/https（可直接渲染），历史档案回退到后端解析出的 mediaDisplay
  const formDisplay = (key, index = 0) => {
    const raw = key === 'cover' ? form?.media?.cover : (form?.media?.[key] || [])[index]
    if (typeof raw === 'string' && DIRECT_SRC.test(raw)) return raw
    const display = form?.displayMedia || {}
    return key === 'cover' ? (display.cover || '') : (display[key]?.[index] || '')
  }

  // 浏览器先压缩，再交给服务端上传云存储，库里只留下 cloud:// 文件 ID
  const uploadImage = async (file) => {
    const dataUrl = await compressProductImage(file)
    const result = await api('/v2/online-catalog/uploads', { method: 'POST', body: JSON.stringify({ data: dataUrl }) })
    return { fileId: result.fileId, url: result.url || '' }
  }

  const onCover = async (file) => {
    if (!file) return
    setUploading(true)
    try {
      const { fileId, url } = await uploadImage(file)
      setForm((current) => ({
        ...current,
        media: { ...(current.media || {}), cover: fileId },
        displayMedia: { ...(current.displayMedia || {}), cover: url },
      }))
      setError('')
    } catch (err) {
      setError(err.message || '图片上传失败')
    } finally {
      setUploading(false)
    }
  }

  const onMediaFiles = async (files, key) => {
    const limit = key === 'gallery' ? 9 : 20
    const selected = Array.from(files || [])
    if (!selected.length) return
    const current = (form?.media || {})[key] || []
    if (current.length >= limit) {
      setError(`${key === 'gallery' ? '轮播图' : '详情图'}最多 ${limit} 张`)
      return
    }
    setUploading(true)
    try {
      const uploaded = []
      for (const file of selected) {
        if (current.length + uploaded.length >= limit) break
        uploaded.push(await uploadImage(file))
      }
      if (!uploaded.length) return
      setForm((state) => ({
        ...state,
        media: { ...(state.media || {}), [key]: [...((state.media || {})[key] || []), ...uploaded.map((item) => item.fileId)].slice(0, limit) },
        displayMedia: { ...(state.displayMedia || {}), [key]: [...((state.displayMedia || {})[key] || []), ...uploaded.map((item) => item.url)].slice(0, limit) },
      }))
      setError('')
    } catch (err) {
      setError(err.message || '图片上传失败')
    } finally {
      setUploading(false)
    }
  }

  const removeMedia = (key, index) => {
    setForm((current) => ({
      ...current,
      media: { ...(current.media || {}), [key]: ((current.media || {})[key] || []).filter((_, i) => i !== index) },
      displayMedia: { ...(current.displayMedia || {}), [key]: ((current.displayMedia || {})[key] || []).filter((_, i) => i !== index) },
    }))
  }

  const removeCover = () => {
    setForm((current) => ({
      ...current,
      media: { ...(current.media || {}), cover: '' },
      displayMedia: { ...(current.displayMedia || {}), cover: '' },
    }))
  }

  const save = async () => {
    if (!form) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const payload = {
        onlineCategoryId: form.onlineCategoryId,
        mpId: form.mode === 'new' ? form.mpId || undefined : undefined,
        title: form.title,
        subtitle: form.subtitle,
        price: form.price,
        shelfLife: form.shelfLife,
        storage: form.storage,
        unit: form.unit,
        spec: form.spec,
        sortOrder: form.sortOrder,
        status: form.status,
        media: form.media,
      }
      if (form.mode === 'edit') {
        await api(`/v2/online-catalog/products/${form.id}`, { method: 'PUT', body: JSON.stringify(payload) })
        setNotice('已保存。发布后小程序才会更新。')
      } else if (form.mode === 'existing') {
        await api('/v2/online-catalog/products', {
          method: 'POST',
          body: JSON.stringify({ ...payload, mode: 'existing', inventoryItemId: form.inventoryItemId }),
        })
        setNotice('线上档案已创建。发布后小程序才会更新。')
      } else {
        await api('/v2/online-catalog/products', {
          method: 'POST',
          body: JSON.stringify({
            ...payload,
            mode: 'new',
            name: form.name,
            sku: form.sku,
            salePrice: form.salePrice,
            costPrice: form.costPrice,
          }),
        })
        setNotice('商品与线上档案已创建。发布后小程序才会更新。')
      }
      setForm(null)
      await load()
    } catch (err) {
      setError(err.message || '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const importExisting = async () => {
    if (!window.confirm('按商品名称匹配 OS 商品并建立线上档案？组合商品会跳过，未匹配的会列在结果里。')) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const { report } = await api('/v2/online-catalog/import-existing', { method: 'POST' })
      setNotice(`导入完成：新建 ${report.created.length}，已管理 ${report.skipped.length}，未匹配 ${report.unmatched.length}，组合商品 ${report.combo.length}，OS 未启用 ${report.inactive.length}，失败 ${report.failed.length}`)
      await load()
    } catch (err) {
      setError(err.message || '导入失败')
    } finally {
      setBusy(false)
    }
  }

  const previewProduct = async (product) => {
    setBusy(true)
    setError('')
    try {
      const { doc } = await api(`/v2/online-catalog/products/${product.id}/preview`)
      setPreviewDoc({ product, doc })
    } catch (err) {
      setError(err.message || '预览失败')
    } finally {
      setBusy(false)
    }
  }

  const publish = async (product) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await api(`/v2/online-catalog/products/${product.id}/publish`, { method: 'POST' })
      setNotice(`已发布 ${product.mpId}（${result.result?.action === 'created' ? '新建' : '更新'}）。`)
      await load()
    } catch (err) {
      setError(err.message || '发布失败')
      await load()
    } finally {
      setBusy(false)
    }
  }

  const saveCategory = async () => {
    if (!categoryForm) return
    setBusy(true)
    setError('')
    try {
      const payload = {
        name: categoryForm.name,
        sortOrder: Number(categoryForm.sortOrder) || 0,
        isActive: categoryForm.isActive !== false,
      }
      if (categoryForm.id) {
        await api(`/v2/online-catalog/categories/${categoryForm.id}`, { method: 'PUT', body: JSON.stringify(payload) })
      } else {
        await api('/v2/online-catalog/categories', { method: 'POST', body: JSON.stringify(payload) })
      }
      setCategoryForm(null)
      await load()
    } catch (err) {
      setError(err.message || '分类保存失败')
    } finally {
      setBusy(false)
    }
  }

  const visible = useMemo(() => {
    if (filter === 'all') return products
    return products.filter((product) => product.onlineCategoryId === filter)
  }, [products, filter])

  const categoryName = (id) => categories.find((category) => category.id === id)?.name || '未分类'

  if (authError) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-50 px-4">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-slate-800">小程序商城管理</h1>
          <p className="mt-2 text-sm text-slate-500">{authError}</p>
          <a className="mt-5 inline-block rounded-xl bg-budu-500 px-5 py-2 text-sm font-semibold text-white" href="/">返回登录</a>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-16">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-widest text-slate-400">budu · online catalog</div>
            <h1 className="text-lg font-semibold text-slate-800">小程序商城管理</h1>
          </div>
          <div className="flex items-center gap-2">
            <a className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50" href="/">返回 OS</a>
            <button type="button" className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50" onClick={importExisting} disabled={busy}>
              导入现有
            </button>
            <button type="button" className="rounded-xl bg-budu-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" onClick={openCreate} disabled={!categories.length}>
              新增商品
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-5">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <button type="button" className={`rounded-full border px-3 py-1.5 text-xs ${filter === 'all' ? 'border-budu-300 bg-budu-50 text-budu-700' : 'border-slate-200 bg-white text-slate-500'}`} onClick={() => setFilter('all')}>全部 {products.length}</button>
          {categories.map((category) => (
            <button key={category.id} type="button" className={`rounded-full border px-3 py-1.5 text-xs ${filter === category.id ? 'border-budu-300 bg-budu-50 text-budu-700' : 'border-slate-200 bg-white text-slate-500'} ${category.isActive ? '' : 'opacity-50'}`} onClick={() => setFilter(category.id)}>
              {category.name} {products.filter((product) => product.onlineCategoryId === category.id).length}
            </button>
          ))}
          <button type="button" className="ml-auto rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50" onClick={() => setCategoryForm({ name: '', sortOrder: categories.length, isActive: true })}>管理分类</button>
        </div>

        {error ? <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</div> : null}
        {notice ? <div className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{notice}</div> : null}
        {cloudbaseConfigured === false ? (
          <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700">
            CloudBase 发布凭据未配置（TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY）：可以保存和导入，发布不可用。
          </div>
        ) : null}

        {loading ? (
          <div className="rounded-2xl bg-white p-10 text-center text-sm text-slate-400">加载中…</div>
        ) : visible.length === 0 ? (
          <div className="rounded-2xl bg-white p-10 text-center text-sm text-slate-400">
            还没有线上商品。点右上角“新增商品”创建第一条；或先建分类。
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            <div className="hidden grid-cols-[64px_1.6fr_1fr_100px_100px_170px] gap-3 border-b border-slate-100 px-4 py-2 text-[11px] font-medium text-slate-400 md:grid">
              <div>图片</div><div>商品</div><div>分类</div><div>线上价</div><div>状态</div><div className="text-right">操作</div>
            </div>
            {visible.map((product) => (
              <div key={product.id} className="grid grid-cols-1 gap-3 border-b border-slate-100 px-4 py-3 last:border-0 md:grid-cols-[64px_1.6fr_1fr_100px_100px_170px] md:items-center">
                <div className="h-14 w-14">
                  <MediaThumb src={mediaPreview(product)} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-slate-800">{product.title || product.item?.name}</span>
                    <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{product.mpId}</span>
                    {product.combo ? (
                      <span className="rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">组合 ×{product.combo.slots ?? '?'}</span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-slate-400">{product.subtitle || product.item?.name} · {product.spec || product.item?.spec || '—'}</div>
                  {product.publishState === 'FAILED' && product.lastError ? <div className="mt-0.5 truncate text-[11px] text-rose-500">{product.lastError}</div> : null}
                </div>
                <div className="text-xs text-slate-500">{product.category?.name || categoryName(product.onlineCategoryId)}</div>
                <div className="text-sm font-medium text-slate-700">{product.priceCents ? formatCents(product.priceCents) : '—'}</div>
                <div>
                  <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] ${STATUS_STYLE[product.status] || STATUS_STYLE.DRAFT}`}>{STATUS_LABEL[product.status] || product.status}</span>
                  <div className="mt-1 text-[10px] text-slate-400">{PUBLISH_LABEL[product.publishState] || product.publishState}</div>
                </div>
                <div className="flex items-center justify-end gap-1.5">
                  <button type="button" className="rounded-lg border border-slate-200 px-2 py-1.5 text-[11px] text-slate-500 hover:bg-slate-50" onClick={() => previewProduct(product)} disabled={busy}>预览</button>
                  <button type="button" className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50" onClick={() => openEdit(product)}>编辑</button>
                  <button type="button" className="rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-50" onClick={() => publish(product)} disabled={busy}>发布</button>
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="mt-4 text-xs leading-5 text-slate-400">
          这里保存的是 OS 侧线上档案；点“发布”后才会写入小程序商品目录。小程序客户端有 60 秒缓存，发布后约 1 分钟内生效，不需要重新发版。
        </p>
      </main>

      {form ? (
        <Modal title={form.mode === 'edit' ? `编辑 ${form.mpId}` : '新增小程序商品'} onClose={() => setForm(null)} wide>
          <div className="space-y-4">
            {form.mode !== 'edit' ? (
              <div className="flex gap-2">
                <button type="button" className={`rounded-xl border px-3 py-2 text-xs ${form.mode === 'new' ? 'border-budu-300 bg-budu-50 text-budu-700' : 'border-slate-200 text-slate-500'}`} onClick={() => setForm((current) => ({ ...current, mode: 'new' }))}>新建 OS 商品</button>
                <button type="button" className={`rounded-xl border px-3 py-2 text-xs ${form.mode === 'existing' ? 'border-budu-300 bg-budu-50 text-budu-700' : 'border-slate-200 text-slate-500'}`} onClick={() => setForm((current) => ({ ...current, mode: 'existing' }))}>选择现有 OS 商品</button>
              </div>
            ) : null}

            {form.mode === 'existing' ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="flex gap-2">
                  <input className={inputClass} placeholder="搜索 OS 商品名称或 SKU" value={itemQuery} onChange={(event) => setItemQuery(event.target.value)} />
                  <button type="button" className="rounded-xl bg-slate-800 px-3 py-2 text-xs font-medium text-white" onClick={() => loadItems(itemQuery)}>搜索</button>
                </div>
                <div className="mt-2 max-h-40 overflow-y-auto">
                  {items.map((item) => (
                    <button key={item.id} type="button" className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs hover:bg-white ${form.inventoryItemId === item.id ? 'bg-white ring-1 ring-budu-200' : ''}`} onClick={() => chooseItem(item)}>
                      <span className="truncate text-slate-700">{item.name} <span className="text-slate-400">{item.sku}</span></span>
                      <span className="shrink-0 text-slate-500">{item.salePriceCents ? formatCents(item.salePriceCents) : '未定价'}</span>
                    </button>
                  ))}
                  {!items.length ? <div className="px-2 py-2 text-xs text-slate-400">没有可用的 OS 商品（已有线上档案的不会重复出现）。</div> : null}
                </div>
              </div>
            ) : null}

            {form.mode === 'new' ? (
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="商品名称（OS）"><input className={inputClass} value={form.name} onChange={(event) => update('name', event.target.value)} /></Field>
                <Field label="SKU"><input className={inputClass} value={form.sku} onChange={(event) => update('sku', event.target.value)} /></Field>
                <Field label="POS 售价（元）"><input className={inputClass} value={form.salePrice} onChange={(event) => update('salePrice', event.target.value)} /></Field>
                <Field label="成本价（元）"><input className={inputClass} value={form.costPrice} onChange={(event) => update('costPrice', event.target.value)} /></Field>
              </div>
            ) : null}

            <div className="grid gap-3 md:grid-cols-2">
              <Field label="线上分类">
                <select className={inputClass} value={form.onlineCategoryId} onChange={(event) => update('onlineCategoryId', event.target.value)}>
                  <option value="">请选择</option>
                  {categories.filter((category) => category.isActive).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                </select>
              </Field>
              <Field label="小程序商品 ID" hint={form.mode === 'edit' ? '创建后不可修改' : '留空自动分配；要接管现有商品请用“导入现有”'}>
                <input className={inputClass} value={form.mpId} onChange={(event) => update('mpId', event.target.value)} disabled={form.mode === 'edit'} />
              </Field>
              <Field label="线上标题"><input className={inputClass} value={form.title} onChange={(event) => update('title', event.target.value)} /></Field>
              <Field label="副标题"><input className={inputClass} value={form.subtitle} onChange={(event) => update('subtitle', event.target.value)} /></Field>
              <Field label="线上售价（元）" hint={form.mode === 'new' ? '留空默认跟随 POS 售价' : '可单独设置' }><input className={inputClass} value={form.price} onChange={(event) => update('price', event.target.value)} /></Field>
              <Field label="排序"><input className={inputClass} type="number" value={form.sortOrder} onChange={(event) => update('sortOrder', event.target.value)} /></Field>
              <Field label="单位"><input className={inputClass} value={form.unit} onChange={(event) => update('unit', event.target.value)} /></Field>
              <Field label="规格"><input className={inputClass} value={form.spec} onChange={(event) => update('spec', event.target.value)} /></Field>
              <Field label="保质期"><input className={inputClass} value={form.shelfLife} onChange={(event) => update('shelfLife', event.target.value)} /></Field>
              <Field label="保存方式"><input className={inputClass} value={form.storage} onChange={(event) => update('storage', event.target.value)} /></Field>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <Field label="状态">
                <select className={inputClass} value={form.status} onChange={(event) => update('status', event.target.value)}>
                  <option value="DRAFT">草稿</option>
                  <option value="ON">上架</option>
                  <option value="OFF">下架</option>
                </select>
              </Field>
              <Field label="封面图" hint={uploading ? '图片上传中…' : '建议 1:1；上传后存云存储，不再写入数据库'}>
                <input type="file" accept="image/*" className="block w-full text-xs text-slate-500" onChange={(event) => onCover(event.target.files?.[0])} />
              </Field>
            </div>

            {form.combo ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-700">
                组合商品：{form.combo.slots ?? '?'} 款自由搭配{form.combo.repeat ? '（可重复选同款）' : ''}，
                口味范围 {(form.combo.flavorIds || []).join(' / ') || '—'} 由 POS 侧维护，本页不改动。
                发布时原样保留组合结构，只更新价格、文案和图片。
              </div>
            ) : null}

            {form.media?.cover ? (
              <div className="flex items-center gap-3 rounded-xl border border-slate-200 p-2">
                <MediaThumb src={formDisplay('cover')} className="h-16 w-16" rounded="rounded-lg" emptyLabel="云端图" />
                <button type="button" className="text-xs text-rose-500" onClick={removeCover}>移除封面</button>
              </div>
            ) : null}

            <div className="grid gap-3 md:grid-cols-2">
              <Field label="轮播图（可多选）" hint="最多 9 张；第一张会作为卡片主图">
                <input type="file" accept="image/*" multiple className="block w-full text-xs text-slate-500" onChange={(event) => onMediaFiles(event.target.files, 'gallery')} />
              </Field>
              <Field label="详情图（可多选）" hint="最多 20 张">
                <input type="file" accept="image/*" multiple className="block w-full text-xs text-slate-500" onChange={(event) => onMediaFiles(event.target.files, 'detail')} />
              </Field>
            </div>

            {['gallery', 'detail'].map((key) => (
              (form.media?.[key] || []).length ? (
                <div key={key} className="rounded-xl border border-slate-200 p-2">
                  <div className="mb-1 text-[11px] text-slate-400">{key === 'gallery' ? '轮播图' : '详情图'}（{form.media[key].length}）</div>
                  <div className="flex flex-wrap gap-2">
                    {form.media[key].map((_, index) => (
                      <div key={`${key}-${index}`} className="relative h-16 w-16 overflow-hidden rounded-lg bg-slate-100">
                        <MediaThumb
                          src={formDisplay(key, index)}
                          className="h-16 w-16"
                          rounded="rounded-lg"
                          emptyLabel="已上传"
                          textClass="text-[10px]"
                        />
                        <button type="button" className="absolute right-0 top-0 rounded-bl bg-slate-900/60 px-1 text-[10px] text-white" onClick={() => removeMedia(key, index)}>×</button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null
            ))}

            <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
              <button type="button" className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600" onClick={() => setForm(null)}>取消</button>
              <button type="button" className="rounded-xl bg-budu-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" onClick={save} disabled={busy || uploading}>{uploading ? '上传中…' : '保存'}</button>
            </div>
          </div>
        </Modal>
      ) : null}

      {previewDoc ? (
        <Modal title={`发布预览 ${previewDoc.doc.id}`} onClose={() => setPreviewDoc(null)} wide>
          <p className="mb-2 text-xs text-slate-400">这是将写入 CloudBase 的文档内容（图片以占位符显示）。发布前可据此核对字段。</p>
          <pre className="max-h-[60vh] overflow-auto rounded-xl bg-slate-900 p-4 text-xs leading-5 text-slate-100">{JSON.stringify(previewDoc.doc, null, 2)}</pre>
        </Modal>
      ) : null}

      {categoryForm ? (
        <Modal title="线上分类" onClose={() => setCategoryForm(null)}>
          <div className="space-y-3">
            <div className="max-h-56 space-y-1 overflow-y-auto">
              {categories.map((category) => (
                <button key={category.id} type="button" className="flex w-full items-center justify-between rounded-lg border border-slate-100 px-3 py-2 text-left text-sm hover:bg-slate-50" onClick={() => setCategoryForm({ ...category })}>
                  <span className={category.isActive ? 'text-slate-700' : 'text-slate-400'}>{category.name}{category.isActive ? '' : '（停用）'}</span>
                  <span className="text-xs text-slate-400">排序 {category.sortOrder}</span>
                </button>
              ))}
            </div>
            <div className="grid gap-2 border-t border-slate-100 pt-3 md:grid-cols-3">
              <Field label="分类名称"><input className={inputClass} value={categoryForm.name} onChange={(event) => setCategoryForm((current) => ({ ...current, name: event.target.value }))} /></Field>
              <Field label="排序"><input className={inputClass} type="number" value={categoryForm.sortOrder} onChange={(event) => setCategoryForm((current) => ({ ...current, sortOrder: event.target.value }))} /></Field>
              <Field label="启用">
                <select className={inputClass} value={categoryForm.isActive === false ? 'false' : 'true'} onChange={(event) => setCategoryForm((current) => ({ ...current, isActive: event.target.value === 'true' }))}>
                  <option value="true">启用</option>
                  <option value="false">停用</option>
                </select>
              </Field>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600" onClick={() => setCategoryForm({ name: '', sortOrder: categories.length, isActive: true })}>新建分类</button>
              <button type="button" className="rounded-xl bg-budu-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" onClick={saveCategory} disabled={busy}>保存</button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
