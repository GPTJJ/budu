import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft, ArrowRight, Check, ChevronRight, Download, FileSpreadsheet, Filter,
  Minus, PackageCheck, Plus, RefreshCcw, Search, Trash2, Truck, X,
} from 'lucide-react'
import { allStores } from '../utils/selectors'
import { getInventoryRequests, loadUserData } from '../utils/userData'
import { api } from '../utils/api'
import { canManageTransferStore, hasInventoryTransferAll } from '../../shared/accountPermissions'
import { takeNotificationRecordFocus } from '../utils/notificationNavigation'
import {
  initialTransferDraft, itemCountLabel, materialDraftItems, mergeTransferItems,
  productDraftRows, setDraftMaterialQuantity, setDraftProductQuantity,
  toggleDraftProduct, transferStatusLabel, transferViewStatus, validTransferQuantity,
} from '../utils/storeTransfer'
import { exportTransferExcel, exportTransferImage } from '../utils/storeTransferExport'

const statusStyle = {
  pending: 'bg-amber-50 text-amber-700',
  shipped: 'bg-emerald-50 text-emerald-700',
  canceled: 'bg-slate-100 text-slate-500',
  unknown: 'bg-slate-100 text-slate-500',
}

const formatTime = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'

function Sheet({ title, children, onClose, labelledBy = 'transfer-sheet-title' }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center sm:p-4">
      <button className="absolute inset-0 bg-slate-950/45 backdrop-blur-sm" onClick={onClose} aria-label="关闭" />
      <section role="dialog" aria-modal="true" aria-labelledby={labelledBy} className="relative max-h-[92vh] w-full overflow-y-auto rounded-t-[28px] bg-white shadow-2xl sm:max-w-xl sm:rounded-[28px]">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-100 bg-white/95 px-5 py-4 backdrop-blur">
          <h3 id={labelledBy} className="text-base font-bold text-slate-900">{title}</h3>
          <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full bg-slate-100 text-slate-500" aria-label="关闭"><X className="h-4 w-4" /></button>
        </div>
        {children}
      </section>
    </div>
  )
}

function QuantityControl({ value, onChange, ariaLabel }) {
  const number = Number(value) || 0
  return (
    <div className="flex items-center gap-1 rounded-xl bg-slate-100 p-1">
      <button type="button" onClick={() => onChange(number > 1 ? String(number - 1) : '')} className="grid h-9 w-9 place-items-center rounded-lg bg-white text-slate-500" aria-label={`${ariaLabel}减一`}><Minus className="h-4 w-4" /></button>
      <input aria-label={ariaLabel} inputMode="numeric" pattern="[0-9]*" value={value} onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, 6))} className="h-9 w-16 bg-transparent text-center text-sm font-bold tabular-nums text-slate-800 outline-none" placeholder="0" />
      <button type="button" onClick={() => onChange(String(Math.min(999999, number + 1)))} className="grid h-9 w-9 place-items-center rounded-lg bg-white text-budu-600" aria-label={`${ariaLabel}加一`}><Plus className="h-4 w-4" /></button>
    </div>
  )
}

export default function StoreTransferPage({ currentUser, onBack }) {
  const stores = allStores()
  const transferAll = hasInventoryTransferAll(currentUser)
  const ownStoreKeys = (currentUser?.storeKeys || []).filter((key) => stores.some((store) => store.key === key))
  const defaultTo = ownStoreKeys[0] || stores[0]?.key || ''
  const defaultFrom = stores.find((store) => store.key !== defaultTo)?.key || ''
  const [screen, setScreen] = useState('records')
  const [listTab, setListTab] = useState('pending')
  const [historyScope, setHistoryScope] = useState('normal')
  const [fromStoreKey, setFromStoreKey] = useState(defaultFrom)
  const [toStoreKey, setToStoreKey] = useState(defaultTo)
  const [pickerTab, setPickerTab] = useState('product')
  const [draft, setDraft] = useState(initialTransferDraft)
  const [picked, setPicked] = useState([])
  const [note, setNote] = useState('')
  const [reviewOpen, setReviewOpen] = useState(false)
  const [detail, setDetail] = useState(null)
  const [shipConfirm, setShipConfirm] = useState(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [filters, setFilters] = useState({ dateFrom: '', dateTo: '', fromStoreKey: '', toStoreKey: '' })
  const [exportOpen, setExportOpen] = useState(false)
  const [exportFilters, setExportFilters] = useState(() => ({ dateFrom: '', dateTo: '', storeKeys: stores.map((store) => store.key), itemType: 'all' }))
  const [exportError, setExportError] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [masterItems, setMasterItems] = useState([])
  const [productCategories, setProductCategories] = useState([])
  const [productSearch, setProductSearch] = useState('')
  const [productCategoryFilter, setProductCategoryFilter] = useState('all')
  const [masterLoading, setMasterLoading] = useState(true)
  const [version, setVersion] = useState(0)
  const [notificationFocusId, setNotificationFocusId] = useState(() => takeNotificationRecordFocus('inventory-transfer'))

  const storeLabel = (key, legacyName = '') => legacyName || stores.find((store) => store.key === key)?.name || key || '—'
  const allRequests = useMemo(() => getInventoryRequests().filter((request) => request.type === 'transfer').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))), [version])
  const filtered = allRequests.filter((request) => {
    const date = String(request.createdAt || '').slice(0, 10)
    if (filters.dateFrom && date < filters.dateFrom) return false
    if (filters.dateTo && date > filters.dateTo) return false
    if (filters.fromStoreKey && request.fromStoreKey !== filters.fromStoreKey) return false
    if (filters.toStoreKey && request.storeKey !== filters.toStoreKey) return false
    const view = transferViewStatus(request.status)
    if (historyScope === 'canceled') return view === 'canceled'
    return view === listTab
  })
  const counts = allRequests.reduce((result, request) => {
    const key = transferViewStatus(request.status)
    result[key] = (result[key] || 0) + 1
    return result
  }, {})
  const products = picked.filter((item) => item.category === 'product')
  const materials = picked.filter((item) => item.category === 'material')
  const allActiveProducts = masterItems.filter((item) => item.category === 'product' && item.enabled)
  const activeProducts = allActiveProducts.filter((item) => {
    const keyword = productSearch.trim().toLocaleLowerCase('zh-CN')
    if (keyword && !`${item.name} ${item.code}`.toLocaleLowerCase('zh-CN').includes(keyword)) return false
    if (productCategoryFilter === 'uncategorized') return !item.productCategoryId
    if (productCategoryFilter !== 'all') return item.productCategoryId === productCategoryFilter
    return true
  })
  const activeMaterials = masterItems.filter((item) => item.category === 'material' && item.enabled)
  const canReview = picked.length > 0 && picked.every((item) => validTransferQuantity(item.quantity))

  useEffect(() => {
    let active = true
    Promise.all([api('/v2/transfer-master-items?active=true'), api('/v2/product-categories?active=true')])
      .then(([itemData, categoryData]) => { if (active) { setMasterItems(itemData.rows || []); setProductCategories(categoryData.rows || []); setError('') } })
      .catch((err) => { if (active) setError(err.message) })
      .finally(() => { if (active) setMasterLoading(false) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!notificationFocusId) return
    const request = allRequests.find((row) => row.id === notificationFocusId)
    if (request) {
      setHistoryScope(transferViewStatus(request.status) === 'canceled' ? 'canceled' : 'normal')
      if (transferViewStatus(request.status) !== 'canceled') setListTab(transferViewStatus(request.status))
      setDetail(request)
      setNotificationFocusId('')
    }
  }, [allRequests, notificationFocusId])

  useEffect(() => {
    const receiveFocus = (event) => {
      const refId = takeNotificationRecordFocus('inventory-transfer') || String(event.detail?.refId || '')
      if (refId) setNotificationFocusId(refId)
    }
    window.addEventListener('budu:notification-record-focus', receiveFocus)
    return () => window.removeEventListener('budu:notification-record-focus', receiveFocus)
  }, [])

  const resetCreate = () => {
    setFromStoreKey(defaultFrom)
    setToStoreKey(defaultTo)
    setPickerTab('product')
    setProductSearch('')
    setProductCategoryFilter('all')
    setDraft(initialTransferDraft())
    setPicked([])
    setNote('')
    setError('')
  }

  const addSelectedProducts = () => {
    const rows = productDraftRows(draft)
    if (!draft.product.selectedNames.length) return setError('请先选择产品')
    if (!rows.length) return setError('请输入 1-999999 的整数数量')
    setPicked((current) => mergeTransferItems(current, rows))
    setDraft((current) => ({ ...current, product: { selectedNames: [], batchQuantity: '' } }))
    setError('')
  }

  const changeMaterial = (name, value) => {
    const next = setDraftMaterialQuantity(draft, name, value)
    setDraft(next)
    setPicked((current) => mergeTransferItems(current.filter((item) => !(item.category === 'material' && item.productName === name)), materialDraftItems(next).filter((item) => item.productName === name)))
    setError('')
  }

  const updatePickedQuantity = (target, value) => {
    setPicked((current) => current.map((item) => item.category === target.category && item.productName === target.productName ? { ...item, quantity: value } : item))
    if (target.category === 'material') setDraft((current) => setDraftMaterialQuantity(current, target.productName, value))
  }

  const removePicked = (target) => {
    setPicked((current) => current.filter((item) => !(item.category === target.category && item.productName === target.productName)))
    if (target.category === 'material') setDraft((current) => setDraftMaterialQuantity(current, target.productName, ''))
  }

  const openReview = () => {
    if (!fromStoreKey) return setError('请选择调出门店')
    if (!toStoreKey) return setError('请选择调入门店')
    if (fromStoreKey === toStoreKey) return setError('调出门店不能与调入门店相同')
    if (!picked.length) return setError('请至少选择一种产品或物料')
    if (picked.some((item) => !validTransferQuantity(item.quantity))) return setError('所有数量必须是 1-999999 的整数')
    setError('')
    setReviewOpen(true)
  }

  const submit = async () => {
    if (busy) return
    setBusy(true)
    try {
      await api('/v2/transfer-requests', {
        method: 'POST',
        body: JSON.stringify({
          fromStoreKey,
          toStoreKey,
          items: picked.map((item) => ({ name: item.productName, quantity: Number(item.quantity), category: item.category, note: item.note || '' })),
          note: note.trim(),
        }),
      })
      await loadUserData()
      setVersion((value) => value + 1)
      setReviewOpen(false)
      resetCreate()
      setScreen('records')
      setHistoryScope('normal')
      setListTab('pending')
      setNotice('调拨已提交，等待调出门店备货')
      window.setTimeout(() => setNotice(''), 2600)
    } catch (err) {
      setError(err.message)
      setReviewOpen(false)
    } finally {
      setBusy(false)
    }
  }

  const withdraw = async (request) => {
    if (!window.confirm('确认撤回这笔待备货调拨吗？记录会保留在历史中。')) return
    setBusy(true)
    try {
      await api(`/v2/transfer-requests/${request.id}`, { method: 'DELETE' })
      await loadUserData()
      setVersion((value) => value + 1)
      setDetail(null)
      setNotice('调拨已撤回，历史记录已保留')
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  const ship = async (request) => {
    setBusy(true)
    try {
      await api(`/v2/transfer-requests/${request.id}/ship`, { method: 'POST', body: JSON.stringify({}) })
      await loadUserData()
      setVersion((value) => value + 1)
      setShipConfirm(null)
      setDetail(null)
      setListTab('shipped')
      setHistoryScope('normal')
      setNotice('已确认发货')
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  const toggleExportStore = (storeKey) => setExportFilters((current) => ({
    ...current,
    storeKeys: current.storeKeys.includes(storeKey) ? current.storeKeys.filter((key) => key !== storeKey) : [...current.storeKeys, storeKey],
  }))

  const runExport = () => {
    if (exportFilters.dateFrom && exportFilters.dateTo && exportFilters.dateFrom > exportFilters.dateTo) return setExportError('开始日期不能晚于结束日期')
    if (!exportFilters.storeKeys.length) return setExportError('请至少选择一个门店')
    exportTransferExcel(allRequests, { ...exportFilters, storeLabel })
    setExportError('')
    setExportOpen(false)
  }

  if (screen === 'create') return (
    <div className="mx-auto max-w-3xl space-y-4 pb-[calc(10rem+env(safe-area-inset-bottom))] sm:pb-28" data-testid="transfer-create-page">
      <header className="flex items-center gap-3">
        <button onClick={() => { resetCreate(); setScreen('records') }} className="grid h-10 w-10 place-items-center rounded-2xl bg-white text-slate-500 shadow-card" aria-label="返回调拨记录"><ArrowLeft className="h-5 w-5" /></button>
        <div><h2 className="text-xl font-bold text-slate-900">创建调拨</h2><p className="text-xs text-slate-400">填写后先核对，再正式提交</p></div>
      </header>

      <section className="rounded-[24px] bg-white p-4 shadow-card">
        <p className="mb-3 text-xs font-bold uppercase tracking-[.18em] text-budu-500">1 · 门店</p>
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
          <label className="min-w-0 text-xs font-semibold text-slate-500">调出门店
            <select aria-label="调出门店" value={fromStoreKey} onChange={(event) => setFromStoreKey(event.target.value)} className="input mt-1.5 w-full"><option value="">请选择</option>{stores.map((store) => <option key={store.key} value={store.key}>{store.name}</option>)}</select>
          </label>
          <ArrowRight className="mb-3 h-5 w-5 text-budu-400" />
          <label className="min-w-0 text-xs font-semibold text-slate-500">调入门店
            <select aria-label="调入门店" value={toStoreKey} onChange={(event) => setToStoreKey(event.target.value)} disabled={!transferAll && ownStoreKeys.length <= 1} className="input mt-1.5 w-full disabled:bg-slate-50 disabled:text-slate-500"><option value="">请选择</option>{(transferAll ? stores : stores.filter((store) => ownStoreKeys.includes(store.key))).map((store) => <option key={store.key} value={store.key}>{store.name}</option>)}</select>
          </label>
        </div>
        {fromStoreKey && toStoreKey && fromStoreKey === toStoreKey && <p role="alert" className="mt-2 text-xs font-semibold text-rose-500">调出门店不能与调入门店相同</p>}
      </section>

      <section className="rounded-[24px] bg-white p-4 shadow-card">
        <p className="mb-3 text-xs font-bold uppercase tracking-[.18em] text-budu-500">2 · 选择货品</p>
        <div className="grid grid-cols-2 rounded-2xl bg-slate-100 p-1" role="tablist" aria-label="货品类型">
          {['product', 'material'].map((key) => <button key={key} role="tab" aria-selected={pickerTab === key} onClick={() => setPickerTab(key)} className={`rounded-xl py-2.5 text-sm font-bold ${pickerTab === key ? 'bg-white text-budu-600 shadow-sm' : 'text-slate-400'}`}>{key === 'product' ? '产品' : '物料'}</button>)}
        </div>
        {pickerTab === 'product' ? (
          <div className="mt-4" data-testid="transfer-product-draft">
            <label className="relative block"><Search className="absolute left-3 top-3.5 h-4 w-4 text-slate-300" /><input aria-label="搜索调拨产品" value={productSearch} onChange={(event) => setProductSearch(event.target.value)} placeholder="搜索产品名称 / 编号" className="input pl-9" /></label>
            <div className="mt-3 flex gap-2 overflow-x-auto pb-1" aria-label="调拨产品分类筛选"><button onClick={() => setProductCategoryFilter('all')} className={`shrink-0 rounded-full px-3 py-2 text-xs font-bold ${productCategoryFilter === 'all' ? 'bg-budu-600 text-white' : 'bg-slate-100 text-slate-500'}`}>全部</button><button onClick={() => setProductCategoryFilter('uncategorized')} className={`shrink-0 rounded-full px-3 py-2 text-xs font-bold ${productCategoryFilter === 'uncategorized' ? 'bg-budu-600 text-white' : 'bg-slate-100 text-slate-500'}`}>未分类</button>{productCategories.map((category) => <button key={category.id} onClick={() => setProductCategoryFilter(category.id)} className={`shrink-0 rounded-full px-3 py-2 text-xs font-bold ${productCategoryFilter === category.id ? 'bg-budu-600 text-white' : 'bg-slate-100 text-slate-500'}`}>{category.name}</button>)}</div>
            <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
              {activeProducts.map((item) => {
                const selected = draft.product.selectedNames.includes(item.name)
                const displayName = item.code && item.name.startsWith(item.code) ? item.name.slice(item.code.length) : item.name
                return <button key={item.id} type="button" aria-pressed={selected} onClick={() => setDraft((current) => toggleDraftProduct(current, item.name))} className={`min-h-20 rounded-2xl border p-2 text-left transition ${selected ? 'border-budu-400 bg-budu-50 text-budu-700 ring-1 ring-budu-200' : 'border-slate-100 bg-white text-slate-600'}`}><span className="block text-base font-black">{item.code || '—'}</span><span className="mt-1 block text-xs font-semibold">{displayName}</span></button>
              })}
            </div>
            {!masterLoading && !activeProducts.length && <p className="rounded-2xl border border-dashed border-slate-200 py-8 text-center text-sm text-slate-300">当前搜索或分类下暂无已启用产品</p>}
            <div className="mt-4 flex flex-wrap items-end gap-3 rounded-2xl bg-slate-50 p-3">
              <label className="min-w-[140px] flex-1 text-xs font-semibold text-slate-500">本批统一数量<input aria-label="产品批量数量" inputMode="numeric" value={draft.product.batchQuantity} onChange={(event) => setDraft((current) => setDraftProductQuantity(current, event.target.value.replace(/\D/g, '').slice(0, 6)))} placeholder="输入整数" className="input mt-1.5" /></label>
              <button type="button" onClick={addSelectedProducts} className="btn-primary min-h-11 px-5">加入清单 · {draft.product.selectedNames.length} 种</button>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-2" data-testid="transfer-material-draft">
            {activeMaterials.map((item) => {
              const value = draft.material.quantities[item.name] || ''
              return <div key={item.id} className={`flex items-center justify-between gap-3 rounded-2xl border px-3 py-2.5 ${Number(value) > 0 ? 'border-budu-200 bg-budu-50/60' : 'border-slate-100 bg-white'}`}><span className="min-w-0 flex-1 text-sm font-semibold text-slate-700">{item.name}</span><QuantityControl value={value} onChange={(next) => changeMaterial(item.name, next)} ariaLabel={`${item.name}数量`} /></div>
            })}
            {!masterLoading && !activeMaterials.length && <p className="rounded-2xl border border-dashed border-slate-200 py-8 text-center text-sm text-slate-300">暂无已启用物料，请先在产品物料管理中启用</p>}
          </div>
        )}
      </section>

      <section className="rounded-[24px] bg-white p-4 shadow-card">
        <div className="flex items-center justify-between"><p className="text-xs font-bold uppercase tracking-[.18em] text-budu-500">3 · 已选清单</p><span className="text-xs font-bold text-slate-400">{itemCountLabel(picked)}</span></div>
        {!picked.length ? <p className="py-8 text-center text-sm text-slate-300">尚未选择产品或物料</p> : ['product', 'material'].map((category) => {
          const rows = picked.filter((item) => item.category === category)
          if (!rows.length) return null
          return <div key={category} className="mt-4"><h4 className="mb-2 text-xs font-bold text-slate-500">{category === 'product' ? '产品' : '物料'} · {rows.length} 种</h4><div className="space-y-2">{rows.map((item) => <div key={`${item.category}-${item.productName}`} className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-100 p-3"><span className="min-w-[120px] flex-1 text-sm font-semibold text-slate-700">{item.productName}</span><QuantityControl value={String(item.quantity)} onChange={(value) => updatePickedQuantity(item, value)} ariaLabel={`${item.productName}清单数量`} /><button type="button" onClick={() => removePicked(item)} className="grid h-10 w-10 place-items-center rounded-xl text-rose-400" aria-label={`删除${item.productName}`}><Trash2 className="h-4 w-4" /></button></div>)}</div></div>
        })}
      </section>

      <section className="rounded-[24px] bg-white p-4 shadow-card"><label className="text-xs font-bold uppercase tracking-[.18em] text-budu-500">4 · 备注<textarea aria-label="调拨备注" value={note} onChange={(event) => setNote(event.target.value.slice(0, 200))} rows="3" placeholder="整笔调拨共用备注（选填）" className="input mt-3 resize-none normal-case tracking-normal" /></label><p className="mt-1 text-right text-[11px] text-slate-300">{note.length}/200</p></section>
      {error && <p role="alert" className="rounded-2xl bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-600">{error}</p>}
      <div data-testid="transfer-submit-bar" className="fixed inset-x-0 z-40 border-t border-slate-100 bg-white/95 p-3 backdrop-blur sm:static sm:rounded-[24px] sm:border-0 sm:shadow-card" style={{ bottom: 'calc(5rem + env(safe-area-inset-bottom))' }}><div className="mx-auto max-w-3xl"><button onClick={openReview} disabled={!canReview || busy} className="btn-primary min-h-12 w-full disabled:cursor-not-allowed disabled:opacity-40">核对并提交 <ChevronRight className="h-4 w-4" /></button></div></div>
      {reviewOpen && <Sheet title="确认调拨信息" onClose={() => setReviewOpen(false)}><div className="space-y-4 p-5"><div className="rounded-2xl bg-budu-50 p-4"><p className="text-xs text-budu-500">调拨方向</p><p className="mt-1 text-lg font-black text-budu-800">{storeLabel(fromStoreKey)} → {storeLabel(toStoreKey)}</p></div>{[['产品', products], ['物料', materials]].map(([label, rows]) => rows.length ? <div key={label}><h4 className="mb-2 text-xs font-bold text-slate-500">{label} · {rows.length} 种</h4><div className="divide-y divide-slate-100 rounded-2xl border border-slate-100">{rows.map((item) => <div key={item.productName} className="flex justify-between gap-3 px-4 py-3 text-sm"><span className="font-semibold text-slate-700">{item.productName}</span><span className="font-black tabular-nums text-slate-800">× {item.quantity}</span></div>)}</div></div> : null)}<div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-600"><span className="font-bold">备注：</span>{note.trim() || '—'}</div>{error && <p role="alert" className="text-sm font-semibold text-rose-500">{error}</p>}<div className="grid grid-cols-2 gap-3"><button onClick={() => setReviewOpen(false)} className="btn-secondary min-h-12">返回修改</button><button onClick={submit} disabled={busy} className="btn-primary min-h-12"><Check className="h-4 w-4" />{busy ? '提交中…' : '确认提交'}</button></div></div></Sheet>}
    </div>
  )

  return (
    <div className="mx-auto max-w-5xl space-y-5" data-testid="transfer-records-page">
      <header className="flex flex-wrap items-center gap-3">
        <button onClick={onBack} className="grid h-10 w-10 place-items-center rounded-2xl bg-white text-slate-500 shadow-card" aria-label="返回首页"><ArrowLeft className="h-5 w-5" /></button>
        <div className="min-w-0 flex-1"><h2 className="flex items-center gap-2 text-xl font-bold text-slate-900"><RefreshCcw className="h-5 w-5 text-budu-500" />门店调拨 2.0</h2><p className="text-xs text-slate-400">调入门店发起，调出门店确认发货</p></div>
        <button onClick={() => { resetCreate(); setScreen('create') }} className="btn-primary min-h-11 px-4"><Plus className="h-4 w-4" />创建调拨</button>
      </header>
      {notice && <p role="status" className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">{notice}</p>}
      {error && <p role="alert" className="rounded-2xl bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-600">{error}</p>}

      <section className="rounded-[24px] bg-white p-3 shadow-card">
        <div className="flex flex-wrap items-center gap-2">
          <div className="grid min-w-[240px] flex-1 grid-cols-2 rounded-2xl bg-slate-100 p-1" role="tablist" aria-label="调拨状态">
            {[['pending', '待备货'], ['shipped', '已发货']].map(([key, label]) => <button key={key} role="tab" aria-selected={historyScope === 'normal' && listTab === key} onClick={() => { setHistoryScope('normal'); setListTab(key) }} className={`rounded-xl py-2.5 text-sm font-bold ${historyScope === 'normal' && listTab === key ? 'bg-white text-budu-600 shadow-sm' : 'text-slate-400'}`}>{label} <span className="ml-1 tabular-nums">{counts[key] || 0}</span></button>)}
          </div>
          <button onClick={() => { setHistoryScope(historyScope === 'canceled' ? 'normal' : 'canceled') }} className={`rounded-xl px-3 py-2.5 text-xs font-bold ${historyScope === 'canceled' ? 'bg-slate-700 text-white' : 'bg-slate-100 text-slate-500'}`}>已取消/驳回 {counts.canceled || 0}</button>
          <button onClick={() => setFiltersOpen((value) => !value)} className="rounded-xl bg-slate-100 p-2.5 text-slate-500" aria-label="筛选"><Filter className="h-4 w-4" /></button>
          <button onClick={() => { setExportError(''); setExportOpen(true) }} className="rounded-xl bg-emerald-50 p-2.5 text-emerald-600" aria-label="导出 Excel"><FileSpreadsheet className="h-4 w-4" /></button>
        </div>
        {filtersOpen && <div className="mt-3 grid gap-2 border-t border-slate-100 pt-3 sm:grid-cols-4"><input aria-label="开始日期" type="date" value={filters.dateFrom} onChange={(event) => setFilters((current) => ({ ...current, dateFrom: event.target.value }))} className="input" /><input aria-label="结束日期" type="date" value={filters.dateTo} onChange={(event) => setFilters((current) => ({ ...current, dateTo: event.target.value }))} className="input" /><select aria-label="筛选调出门店" value={filters.fromStoreKey} onChange={(event) => setFilters((current) => ({ ...current, fromStoreKey: event.target.value }))} className="input"><option value="">全部调出门店</option>{stores.map((store) => <option key={store.key} value={store.key}>{store.name}</option>)}</select><select aria-label="筛选调入门店" value={filters.toStoreKey} onChange={(event) => setFilters((current) => ({ ...current, toStoreKey: event.target.value }))} className="input"><option value="">全部调入门店</option>{stores.map((store) => <option key={store.key} value={store.key}>{store.name}</option>)}</select></div>}
      </section>

      <div className="space-y-3">
        {filtered.map((request) => {
          const view = transferViewStatus(request.status)
          const preview = (request.items || []).slice(0, 3)
          return <button key={request.id} data-transfer-record-id={request.id} onClick={() => setDetail(request)} className="w-full rounded-[24px] border border-slate-100 bg-white p-4 text-left shadow-card transition hover:border-budu-200">
            <div className="flex items-start gap-3"><div className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl ${view === 'shipped' ? 'bg-emerald-50 text-emerald-600' : view === 'pending' ? 'bg-amber-50 text-amber-600' : 'bg-slate-100 text-slate-500'}`}>{view === 'shipped' ? <PackageCheck className="h-5 w-5" /> : <Truck className="h-5 w-5" />}</div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="font-black text-slate-800">{storeLabel(request.fromStoreKey, request.fromStoreName)} <ArrowRight className="inline h-4 w-4 text-budu-400" /> {storeLabel(request.storeKey, request.storeName)}</h3><span className={`rounded-full px-2 py-1 text-[11px] font-bold ${statusStyle[view]}`}>{transferStatusLabel(request.status)}</span></div><p className="mt-1 text-xs text-slate-400">{formatTime(request.createdAt)} · {itemCountLabel(request.items)} · 申请人 {request.createdBy || '—'}</p><p className="mt-2 truncate text-xs text-slate-500">{preview.map((item) => `${item.productName} ×${item.quantity}`).join(' · ')}{(request.items || []).length > 3 ? ' …' : ''}</p>{view === 'shipped' && <p className="mt-1 text-[11px] text-emerald-600">发货人 {request.shippedBy || '—'} · {formatTime(request.shippedAt)}</p>}</div><ChevronRight className="mt-3 h-4 w-4 shrink-0 text-slate-300" /></div>
          </button>
        })}
        {!filtered.length && <div className="rounded-[24px] border border-dashed border-slate-200 py-16 text-center"><Truck className="mx-auto h-8 w-8 text-slate-200" /><p className="mt-3 text-sm text-slate-300">当前条件下暂无调拨记录</p></div>}
      </div>

      {detail && <Sheet title="调拨详情" onClose={() => setDetail(null)}><div className="space-y-4 p-5"><div className="rounded-2xl bg-budu-50 p-4"><div className="flex items-center justify-between gap-2"><p className="text-[11px] font-bold text-budu-500">{detail.id}</p><span className={`rounded-full px-2 py-1 text-[11px] font-bold ${statusStyle[transferViewStatus(detail.status)]}`}>{transferStatusLabel(detail.status)}</span></div><p className="mt-2 text-xl font-black text-budu-800">{storeLabel(detail.fromStoreKey, detail.fromStoreName)} → {storeLabel(detail.storeKey, detail.storeName)}</p></div><div className="grid grid-cols-2 gap-2 text-xs"><div className="rounded-2xl bg-slate-50 p-3"><p className="text-slate-400">申请人 / 时间</p><p className="mt-1 font-bold text-slate-700">{detail.createdBy || '—'}</p><p className="mt-1 text-slate-500">{formatTime(detail.createdAt)}</p></div><div className="rounded-2xl bg-slate-50 p-3"><p className="text-slate-400">发货人 / 时间</p><p className="mt-1 font-bold text-slate-700">{detail.shippedBy || '—'}</p><p className="mt-1 text-slate-500">{formatTime(detail.shippedAt)}</p></div></div>{['product', 'material'].map((category) => { const rows = (detail.items || []).filter((item) => item.category === category); return rows.length ? <div key={category}><h4 className="mb-2 text-xs font-bold text-slate-500">{category === 'product' ? '产品' : '物料'} · {rows.length} 种</h4><div className="divide-y divide-slate-100 rounded-2xl border border-slate-100">{rows.map((item) => <div key={item.id || item.productName} className="flex items-start justify-between gap-3 px-4 py-3"><div><p className="text-sm font-semibold text-slate-700">{item.productName || '—'}</p><p className="mt-1 text-[11px] text-slate-400">编码 {item.itemCode || '—'}{item.productCategory ? ` · ${item.productCategory}` : ''}{item.note ? ` · ${item.note}` : ''}</p></div><span className="font-black tabular-nums text-slate-800">× {item.quantity}</span></div>)}</div></div> : null })}<div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-600"><span className="font-bold">备注：</span>{detail.note || '—'}</div>{transferViewStatus(detail.status) === 'canceled' && <div className="rounded-2xl bg-slate-100 p-3 text-xs text-slate-500">撤回人 {detail.withdrawnBy || '—'} · {formatTime(detail.withdrawnAt)}</div>}<button onClick={() => exportTransferImage(detail, storeLabel)} className="btn-secondary min-h-11 w-full"><Download className="h-4 w-4" />调拨单图片</button>{transferViewStatus(detail.status) === 'pending' && <div className="space-y-2 border-t border-slate-100 pt-4">{canManageTransferStore(currentUser, detail.fromStoreKey) && <button onClick={() => setShipConfirm(detail)} className="btn-primary min-h-12 w-full"><Truck className="h-4 w-4" />确认发货</button>}{(detail.createdBy === currentUser?.username || transferAll) && <button onClick={() => withdraw(detail)} disabled={busy} className="min-h-11 w-full rounded-xl bg-slate-100 text-sm font-bold text-slate-500">撤回调拨</button>}</div>}</div></Sheet>}
      {exportOpen && <Sheet title="导出门店物资调拨" onClose={() => setExportOpen(false)} labelledBy="transfer-export-title"><div className="space-y-4 p-5"><p className="rounded-2xl bg-emerald-50 p-3 text-xs text-emerald-700">只统计已发货，以发货确认时间为准；不代表当前库存。</p><div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2"><label className="text-xs font-bold text-slate-500">开始日期<input aria-label="导出开始日期" type="date" value={exportFilters.dateFrom} onChange={(event) => setExportFilters((current) => ({ ...current, dateFrom: event.target.value }))} className="input mt-1.5" /></label><span className="mb-3 text-slate-300">—</span><label className="text-xs font-bold text-slate-500">结束日期<input aria-label="导出结束日期" type="date" value={exportFilters.dateTo} onChange={(event) => setExportFilters((current) => ({ ...current, dateTo: event.target.value }))} className="input mt-1.5" /></label></div><fieldset><legend className="mb-2 text-xs font-bold text-slate-500">门店（可多选）</legend><div className="grid grid-cols-2 gap-2">{stores.map((store) => <label key={store.key} className="flex min-h-11 items-center gap-2 rounded-xl bg-slate-50 px-3 text-sm font-semibold text-slate-600"><input aria-label={`导出门店${store.name}`} type="checkbox" checked={exportFilters.storeKeys.includes(store.key)} onChange={() => toggleExportStore(store.key)} className="h-4 w-4 accent-budu-500" />{store.name}</label>)}</div></fieldset><fieldset><legend className="mb-2 text-xs font-bold text-slate-500">货品类型</legend><div className="grid grid-cols-3 rounded-2xl bg-slate-100 p-1">{[['all', '全部'], ['product', '产品'], ['material', '物料']].map(([key, label]) => <button key={key} type="button" onClick={() => setExportFilters((current) => ({ ...current, itemType: key }))} className={`min-h-10 rounded-xl text-sm font-bold ${exportFilters.itemType === key ? 'bg-white text-budu-600 shadow-sm' : 'text-slate-400'}`}>{label}</button>)}</div></fieldset>{exportError && <p role="alert" className="text-sm font-semibold text-rose-500">{exportError}</p>}<button onClick={runExport} className="btn-primary min-h-12 w-full"><FileSpreadsheet className="h-4 w-4" />导出汇总 Excel</button></div></Sheet>}
      {shipConfirm && <Sheet title="确认已发货" onClose={() => setShipConfirm(null)} labelledBy="ship-confirm-title"><div className="space-y-4 p-5"><div className="rounded-2xl bg-amber-50 p-4 text-sm text-amber-800"><p className="font-bold">请确认货品已经从调出门店发出。</p><p className="mt-1 text-xs">确认后状态变为“已发货”，并记录发货人与时间；不会修改任何库存，也不能普通撤回。</p></div><p className="text-center text-base font-black text-slate-800">{storeLabel(shipConfirm.fromStoreKey, shipConfirm.fromStoreName)} → {storeLabel(shipConfirm.storeKey, shipConfirm.storeName)}</p><div className="grid grid-cols-2 gap-3"><button onClick={() => setShipConfirm(null)} className="btn-secondary min-h-12">取消</button><button onClick={() => ship(shipConfirm)} disabled={busy} className="btn-primary min-h-12"><Check className="h-4 w-4" />{busy ? '处理中…' : '确认已发货'}</button></div></div></Sheet>}
    </div>
  )
}
