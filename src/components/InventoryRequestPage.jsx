import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  Check,
  ChevronDown,
  FileDown,
  PackagePlus,
  Pencil,
  RefreshCcw,
  ShoppingCart,
  Trash2,
  UploadCloud,
  Truck,
  PackageCheck,
  XCircle,
} from 'lucide-react'
import { allStores, products } from '../utils/selectors'
import { getInventoryRequests, loadUserData } from '../utils/userData'
import { TRANSFER_STATUS_LABEL } from '../utils/inventory'
import { api } from '../utils/api'
import { PRODUCT_CATEGORIES, MATERIAL_NAMES, FIXED_BY_CATEGORY, classifyProduct } from '../utils/productCategories'
import InventoryListModal from './InventoryListModal'
import InventoryStockPanel from './InventoryStockPanel'
import { useI18n } from '../i18n'

const inputCls =
  'w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-budu-400 focus:ring-2 focus:ring-budu-100'

const CATEGORY_LABEL = { product: '产品', material: '物料', other: '其他' }
const CATEGORY_STYLE = {
  product: 'bg-budu-50 text-budu-600',
  material: 'bg-emerald-50 text-emerald-600',
  other: 'bg-slate-100 text-slate-500',
}

function compressImage(file, maxSize = 220) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height))
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        canvas.getContext('2d').drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', 0.82))
      }
      img.onerror = () => reject(new Error('图片读取失败'))
      img.src = reader.result
    }
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
}

const TRANSFER_STATUS_STYLE = {
  pending: 'bg-amber-50 text-amber-600',
  in_transit: 'bg-blue-50 text-blue-600',
  completed: 'bg-emerald-50 text-emerald-600',
  rejected: 'bg-rose-50 text-rose-600',
}

export default function InventoryRequestPage({ type, currentUser, onBack }) {
  const { t } = useI18n()
  const isTransfer = type === 'transfer'
  const stores = allStores()
  const [form, setForm] = useState({
    fromStoreKey: stores[0] ? stores[0].key : '',
    storeKey: stores[1] ? stores[1].key : stores[0] ? stores[0].key : '',
    fromStoreName: '',
    storeName: '',
    note: '',
  })
  const [picker, setPicker] = useState({ category: 'product', productName: '', quantity: '', note: '' })
  const [selectedNames, setSelectedNames] = useState([])
  const [picked, setPicked] = useState([])
  const [tempStores, setTempStores] = useState([])
  const [customSide, setCustomSide] = useState(null) // 'fromStoreKey' | 'storeKey' | null
  const [customName, setCustomName] = useState('')
  const [suppliers, setSuppliers] = useState([])
  const [supplierId, setSupplierId] = useState('')
  const [expectedAt, setExpectedAt] = useState('')
  const [supplierModal, setSupplierModal] = useState(false)
  const [supplierForm, setSupplierForm] = useState({ name: '', phone: '', contact: '', note: '' })
  const [itemsMap, setItemsMap] = useState({})
  const [optionEdit, setOptionEdit] = useState(null)
  const [optionForm, setOptionForm] = useState({ spec: '', image: '' })
  const [productMenuOpen, setProductMenuOpen] = useState(false)
  const [productCategory, setProductCategory] = useState(PRODUCT_CATEGORIES[0])
  const [customProductName, setCustomProductName] = useState('')
  const [listTab, setListTab] = useState('pending') // 'pending' | 'done'
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [previewList, setPreviewList] = useState(null)
  const [expandedIds, setExpandedIds] = useState(new Set())
  const [error, setError] = useState('')
  const [savedTip, setSavedTip] = useState('')
  const [version, setVersion] = useState(0)

  const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`
  const productNames = [...new Set(products(month, 'all').map((p) => p.name))].slice(0, 100)
  const filteredProducts = productNames.filter((n) => classifyProduct(n) === productCategory)
  const categoryProducts = [
    ...new Set([...(FIXED_BY_CATEGORY[productCategory] || []), ...filteredProducts]),
  ]
  const allRequests = getInventoryRequests().filter((r) => r.type === type)
  const sortedRequests = [...allRequests].sort((a, b) =>
    String(b.createdAt).localeCompare(String(a.createdAt)),
  )
  const isFinished = (request) => isTransfer
    ? ['completed', 'rejected', 'done'].includes(request.status)
    : request.status === 'done'
  const pendingCount = allRequests.filter((request) => !isFinished(request)).length
  const doneCount = allRequests.length - pendingCount
  const visibleRequests = sortedRequests.filter((r) => {
    const d = (r.createdAt || '').slice(0, 10)
    if (dateFrom && d < dateFrom) return false
    if (dateTo && d > dateTo) return false
    return true
  })
  const requests = visibleRequests.filter((r) =>
    listTab === 'done' ? isFinished(r) : !isFinished(r),
  )
  const isDeveloper = currentUser?.role === 'developer'
  const canManageOptions = currentUser?.role === 'developer'

  const loadItems = async () => {
    try {
      const d = await api('/v2/items')
      const map = {}
      for (const it of d.rows || []) map[it.name] = it
      setItemsMap(map)
    } catch {
      /* 忽略 */
    }
  }

  useEffect(() => {
    loadItems()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (isTransfer) return
    api('/v2/suppliers')
      .then((d) => setSuppliers(d.rows || []))
      .catch(() => {})
  }, [isTransfer])

  const submit = async () => {
    setError('')
    if (isTransfer && form.fromStoreKey === form.storeKey) {
      setError(t('调出门店和调入门店不能相同'))
      return
    }
    if (form.fromStoreKey === '__custom__' || form.storeKey === '__custom__') {
      setError(t('请先完成自定义门店添加'))
      return
    }
    if (picked.length === 0) {
      setError(t('请先添加货品'))
      return
    }
    try {
      const payload = {
        ...(isTransfer ? { toStoreKey: form.storeKey } : { storeKey: form.storeKey }),
        ...(isTransfer ? { fromStoreKey: form.fromStoreKey } : {}),
        ...(isTransfer ? {} : { supplierId: supplierId || undefined, expectedAt: expectedAt || undefined }),
        items: picked.map((it) => ({ name: it.productName, quantity: it.quantity, note: it.note })),
        note: form.note.trim(),
      }
      await api(isTransfer ? '/v2/transfer-requests' : '/v2/purchase-requests', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      await loadUserData()
      setPicked([])
      setForm((s) => ({ ...s, note: '' }))
      setVersion((v) => v + 1)
      setSavedTip(t('已提交申请 ✓'))
      setTimeout(() => setSavedTip(''), 2200)
    } catch (err) {
      setError(t(err.message))
    }
  }

  const remove = async (r) => {
    if (!window.confirm(t('确定删除该申请吗？'))) return
    setError('')
    try {
      await api(`/v2/${isTransfer ? 'transfer-requests' : 'purchase-requests'}/${r.id}`, { method: 'DELETE' })
      await loadUserData()
      setVersion((v) => v + 1)
    } catch (err) {
      setError(t(err.message))
    }
  }

  const canDelete = (r) => isDeveloper || r.createdBy === currentUser?.username

  const runTransferAction = async (request, action) => {
    const confirmText = action === 'ship'
      ? '确认库存无误，并审核通过该申请、安排发货吗？'
      : action === 'receive'
        ? '确认货品已经到店并验收无误吗？'
        : '确定驳回该申请吗？'
    if (!window.confirm(t(confirmText))) return
    const note = action === 'reject' ? window.prompt(t('请输入驳回原因（选填）')) || '' : ''
    setError('')
    try {
      const path = action === 'ship' ? 'ship' : action === 'receive' ? 'receive' : 'reject'
      await api(`/v2/transfer-requests/${request.id}/${path}`, {
        method: 'POST',
        body: JSON.stringify({ note }),
      })
      await loadUserData()
      setVersion((value) => value + 1)
      setSavedTip(t(action === 'ship' ? '已确认发货，申请已完成' : action === 'receive' ? '已确认收货，申请已完成' : '申请已驳回'))
      setTimeout(() => setSavedTip(''), 2400)
    } catch (err) {
      setError(t(err.message))
    }
  }

  const buildCurrentList = () => ({
    type,
    storeKey: form.storeKey,
    fromStoreKey: form.fromStoreKey,
    storeName: form.storeName,
    fromStoreName: form.fromStoreName,
    items: picked,
    note: form.note.trim(),
    status: 'pending',
    createdBy: currentUser?.username || '',
    createdAt: new Date().toISOString(),
  })

  const addCustomStore = (side) => {
    setError('')
    const name = customName.trim()
    if (!name) {
      setError(t('请输入门店名称'))
      return
    }
    if ([...stores, ...tempStores].some((s) => s.name === name)) {
      setError(t('该门店已存在'))
      return
    }
    const key = `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const temp = { key, name }
    setTempStores((list) => [...list, temp])
    setForm((s) => ({
      ...s,
      [side]: key,
      [side === 'fromStoreKey' ? 'fromStoreName' : 'storeName']: name,
    }))
    setCustomSide(null)
    setCustomName('')
    setSavedTip(t('已添加门店：{name}', { name }))
    setTimeout(() => setSavedTip(''), 1800)
  }

  const selectStore = (side, key) => {
    const temp = tempStores.find((s) => s.key === key)
    const nameField = side === 'fromStoreKey' ? 'fromStoreName' : 'storeName'
    setForm((s) => ({
      ...s,
      [side]: key,
      [nameField]: temp ? temp.name : '',
    }))
    setCustomSide(key === '__custom__' ? side : null)
  }

  const storeDisplay = (key, name) => name || stores.find((s) => s.key === key)?.name || key

  const canShip = (r) =>
    isDeveloper ||
    (currentUser?.role === 'manager' && (currentUser.storeKeys || []).includes(r.fromStoreKey))
  const canReceive = (r) =>
    isDeveloper || (currentUser?.role === 'manager' && (currentUser.storeKeys || []).includes(r.storeKey))
  const canReject = canShip
  const canReceivePurchase = (r) =>
    isDeveloper ||
    (currentUser?.role === 'manager' && (currentUser.storeKeys || []).includes(r.storeKey))

  const receivePurchase = async (r) => {
    if (!window.confirm(t('确认货品已到货并入库吗？'))) return
    setError('')
    try {
      await api(`/v2/purchase-requests/${r.id}/receive`, {
        method: 'POST',
        body: JSON.stringify({
          items: (r.items || []).map((it) => ({ itemId: it.itemId, receivedQty: it.receivedQty || it.quantity })),
        }),
      })
      await loadUserData()
      setVersion((v) => v + 1)
      setSavedTip(t('已收货入库 ✓'))
      setTimeout(() => setSavedTip(''), 2400)
    } catch (err) {
      setError(t(err.message))
    }
  }

  const addSupplier = async () => {
    setError('')
    try {
      const res = await api('/v2/suppliers', { method: 'POST', body: JSON.stringify(supplierForm) })
      setSuppliers((list) => [...list, res.supplier])
      setSupplierId(res.supplier.id)
      setSupplierForm({ name: '', phone: '', contact: '', note: '' })
      setSupplierModal(false)
      setSavedTip(t('供应商已添加'))
      setTimeout(() => setSavedTip(''), 1800)
    } catch (err) {
      setError(t(err.message))
    }
  }

  const addItem = () => {
    setError('')
    const qty = Number(picker.quantity)
    if (!qty || qty < 1 || !Number.isFinite(qty)) {
      setError(t('请填写有效数量'))
      return
    }
    if (picker.category === 'other') {
      const name = picker.productName.trim()
      if (!name) {
        setError(t('请选择产品'))
        return
      }
      setPicked((list) => [
        ...list,
        {
          category: 'other',
          productName: name,
          quantity: Math.floor(qty),
          note: picker.note.trim(),
        },
      ])
      setPicker((s) => ({ ...s, productName: '', quantity: '', note: '' }))
      setSavedTip(t('已添加：{name} × {n}', { name, n: Math.floor(qty) }))
      setTimeout(() => setSavedTip(''), 1800)
      return
    }
    if (selectedNames.length === 0) {
      setError(t('请选择产品'))
      return
    }
    const rows = selectedNames.map((name) => ({
      // 产品与物料可混合多选，按名称自动归类
      category: MATERIAL_NAMES.includes(name) ? 'material' : 'product',
      productName: name,
      quantity: Math.floor(qty),
      note: picker.note.trim(),
    }))
    setPicked((list) => [...list, ...rows])
    setSelectedNames([])
    setPicker((s) => ({ ...s, quantity: '', note: '' }))
    setSavedTip(t('已添加 {n} 种货品', { n: rows.length }))
    setTimeout(() => setSavedTip(''), 1800)
  }

  const openOptionEdit = (name) => {
    const item = itemsMap[name]
    setOptionEdit({
      name,
      category: item ? item.category : MATERIAL_NAMES.includes(name) ? 'material' : 'product',
    })
    setOptionForm({ spec: item ? item.spec || '' : '', image: item ? item.image || '' : '' })
  }

  const saveOption = async () => {
    setError('')
    try {
      let item = itemsMap[optionEdit.name]
      if (!item) {
        const created = await api('/v2/items', {
          method: 'POST',
          body: JSON.stringify({
            name: optionEdit.name,
            category: optionEdit.category,
            spec: optionForm.spec.trim(),
            image: optionForm.image,
          }),
        })
        item = created.item
      } else {
        await api(`/v2/items/${item.id}`, {
          method: 'PUT',
          body: JSON.stringify({ ...item, spec: optionForm.spec.trim(), image: optionForm.image }),
        })
      }
      setOptionEdit(null)
      await loadItems()
      setVersion((v) => v + 1)
    } catch (err) {
      setError(t(err.message))
    }
  }

  const OptionCard = ({ name, onSelect, selected }) => {
    const meta = itemsMap[name]
    return (
      <div className="relative">
        <button
          type="button"
          onClick={onSelect}
          className={`flex w-full flex-col items-center gap-1 rounded-xl border p-2 text-center transition ${
            selected
              ? 'border-budu-400 bg-budu-50'
              : 'border-slate-100 bg-white hover:border-budu-200 hover:bg-budu-50/50'
          }`}
        >
          <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-lg bg-gradient-to-br from-budu-50 to-grape-50 text-sm font-bold text-budu-400">
            {meta && meta.image ? (
              <img src={meta.image} alt={name} className="h-full w-full object-cover" />
            ) : (
              name[0]
            )}
          </span>
          <span className="line-clamp-2 w-full text-[11px] font-semibold leading-tight text-slate-700">{name}</span>
          {meta && meta.spec && <span className="w-full truncate text-[10px] text-slate-400">{meta.spec}</span>}
        </button>
        {selected && (
          <span className="absolute left-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-budu-500 text-white shadow-md">
            <Check className="h-3 w-3" />
          </span>
        )}
        {canManageOptions && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              openOptionEdit(name)
            }}
            className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-md bg-white/90 text-slate-400 shadow-sm transition hover:text-budu-600"
            aria-label={t('设置')}
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* 页面头部 */}
      <div className="flex flex-wrap items-center gap-4">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-2xl bg-white px-3.5 py-2.5 text-sm font-medium text-slate-500 shadow-card transition hover:text-budu-600"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('返回首页')}
        </button>
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-slate-800">
            {isTransfer ? (
              <RefreshCcw className="h-5 w-5 text-budu-500" />
            ) : (
              <ShoppingCart className="h-5 w-5 text-grape-500" />
            )}
            {t(isTransfer ? '申请调货' : '申请采购')}
          </h2>
          <p className="mt-0.5 text-[13px] text-slate-400">
            {t(isTransfer ? '提交门店间调货申请，等待开发者处理' : '提交门店采购申请，等待开发者处理')}
          </p>
        </div>
        {savedTip && (
          <span className="ml-auto flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-600">
            <Check className="h-3.5 w-3.5" />
            {savedTip}
          </span>
        )}
      </div>

      {/* 申请表单 */}
      <div className="card p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {isTransfer && (
            <div>
              <span className="mb-1.5 block text-xs font-semibold text-slate-500">{t('调出门店')}</span>
              <select
                value={form.fromStoreKey}
                onChange={(e) => selectStore('fromStoreKey', e.target.value)}
                className={inputCls}
              >
                {[...stores, ...tempStores].map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.name}
                  </option>
                ))}
                <option value="__custom__">＋ {t('自定义门店')}</option>
              </select>
              {customSide === 'fromStoreKey' && (
                <div className="mt-2 flex gap-2">
                  <input
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    placeholder={t('输入新门店名称')}
                    className={inputCls}
                  />
                  <button
                    onClick={() => addCustomStore('fromStoreKey')}
                    className="shrink-0 rounded-xl bg-budu-500 px-3 py-2 text-xs font-semibold text-white transition hover:bg-budu-600"
                  >
                    {t('添加门店')}
                  </button>
                </div>
              )}
            </div>
          )}
          <div>
            <span className="mb-1.5 block text-xs font-semibold text-slate-500">
              {t(isTransfer ? '调入门店' : '采购门店')}
            </span>
            <select
              value={form.storeKey}
              onChange={(e) => selectStore('storeKey', e.target.value)}
              className={inputCls}
            >
              {[...stores, ...tempStores].map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name}
                </option>
              ))}
              <option value="__custom__">＋ {t('自定义门店')}</option>
            </select>
            {customSide === 'storeKey' && (
              <div className="mt-2 flex gap-2">
                <input
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder={t('输入新门店名称')}
                  className={inputCls}
                />
                <button
                  onClick={() => addCustomStore('storeKey')}
                  className="shrink-0 rounded-xl bg-budu-500 px-3 py-2 text-xs font-semibold text-white transition hover:bg-budu-600"
                >
                  {t('添加门店')}
                </button>
              </div>
            )}
          </div>
        </div>

        {!isTransfer && (
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <span className="mb-1.5 block text-xs font-semibold text-slate-500">{t('供应商')}</span>
              <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={inputCls}>
                <option value="">{t('未指定')}</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <button
                onClick={() => setSupplierModal(true)}
                className="mt-1 text-xs font-semibold text-budu-500 transition hover:text-budu-600"
              >
                ＋ {t('新增供应商')}
              </button>
            </div>
            <div>
              <span className="mb-1.5 block text-xs font-semibold text-slate-500">{t('预计到货日期')}</span>
              <input type="date" value={expectedAt} onChange={(e) => setExpectedAt(e.target.value)} className={inputCls} />
            </div>
          </div>
        )}

        {!isTransfer && supplierModal && (
          <div className="fixed inset-0 z-[85] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => setSupplierModal(false)} />
            <div className="relative w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl">
              <h3 className="text-lg font-bold text-slate-800">{t('新增供应商')}</h3>
              <div className="mt-4 space-y-2">
                <input value={supplierForm.name} onChange={(e) => setSupplierForm((s) => ({ ...s, name: e.target.value }))} placeholder={t('供应商名称')} className={inputCls} />
                <input value={supplierForm.phone} onChange={(e) => setSupplierForm((s) => ({ ...s, phone: e.target.value }))} placeholder={t('电话')} className={inputCls} />
                <input value={supplierForm.contact} onChange={(e) => setSupplierForm((s) => ({ ...s, contact: e.target.value }))} placeholder={t('联系人')} className={inputCls} />
                <input value={supplierForm.note} onChange={(e) => setSupplierForm((s) => ({ ...s, note: e.target.value }))} placeholder={t('备注')} className={inputCls} />
              </div>
              <div className="mt-4 flex gap-2">
                <button onClick={() => setSupplierModal(false)} className="flex-1 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-500">
                  {t('取消')}
                </button>
                <button onClick={addSupplier} className="flex-1 rounded-xl bg-gradient-to-r from-budu-500 to-grape-500 px-4 py-2.5 text-sm font-semibold text-white">
                  {t('保存')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 挑选货品：选一个 → 添加到本次申请列表 → 再选下一个 */}
        <div className="mt-5 rounded-2xl bg-slate-50/70 p-4">
          <p className="mb-2 text-xs font-semibold text-slate-500">{t('挑选货品')}</p>
          <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
            {['product', 'material', 'other'].map((c) => (
              <button
                key={c}
                onClick={() => {
                  setPicker((s) => ({ ...s, category: c, productName: '' }))
                  setProductMenuOpen(false)
                }}
                className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition ${
                  picker.category === c
                    ? 'bg-gradient-to-r from-budu-500 to-grape-500 text-white shadow-md shadow-budu-200/60'
                    : 'bg-white text-slate-500 ring-1 ring-slate-100 hover:text-budu-600'
                }`}
                >
                  {t(CATEGORY_LABEL[c])}
                  {c !== 'other' && selectedNames.length > 0 && (
                    <span className="ml-1 rounded-md bg-white/25 px-1 text-[10px] font-bold">{selectedNames.length}</span>
                  )}
                </button>
              ))}
            </div>
          <div className="flex flex-wrap items-center gap-2">
            {picker.category === 'product' ? (
              <div className="relative min-w-[180px] flex-1">
                <button
                  type="button"
                  onClick={() => setProductMenuOpen((v) => !v)}
                  className={`${inputCls} flex items-center justify-between gap-2 text-left`}
                >
                  <span className={picker.productName ? 'text-slate-700' : 'text-slate-400'}>
                    {selectedNames.length > 0
                      ? t('已选 {n} 项', { n: selectedNames.length })
                      : picker.productName || t('选择产品')}
                  </span>
                  <ChevronDown
                    className={`h-4 w-4 shrink-0 text-slate-300 transition-transform ${productMenuOpen ? 'rotate-180' : ''}`}
                  />
                </button>

                {productMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-30" onClick={() => setProductMenuOpen(false)} />
                    <div className="absolute left-0 top-full z-40 mt-1 w-[340px] rounded-2xl border border-slate-100 bg-white p-2.5 shadow-2xl sm:w-[440px]">
                      {/* 二级菜单：产品分类 */}
                      <div className="flex flex-wrap gap-1.5">
                        {PRODUCT_CATEGORIES.map((c) => (
                          <button
                            key={c}
                            onClick={() => setProductCategory(c)}
                            className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition ${
                              productCategory === c
                                ? 'bg-gradient-to-r from-budu-500 to-grape-500 text-white shadow-md shadow-budu-200/60'
                                : 'bg-slate-50 text-slate-500 hover:bg-budu-50 hover:text-budu-600'
                            }`}
                          >
                            {t(c)}
                          </button>
                        ))}
                      </div>

                      {productCategory === '其他' && (
                        <div className="mt-2 flex gap-2">
                          <input
                            value={customProductName}
                            onChange={(e) => setCustomProductName(e.target.value)}
                            placeholder={t('自定义其他内容')}
                            className={`${inputCls} flex-1`}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && customProductName.trim()) {
                                setSelectedNames((s) => [...new Set([...s, customProductName.trim()])])
                                setCustomProductName('')
                              }
                            }}
                          />
                          <button
                            onClick={() => {
                              if (!customProductName.trim()) return
                              setSelectedNames((s) => [...new Set([...s, customProductName.trim()])])
                              setCustomProductName('')
                            }}
                            className="shrink-0 rounded-xl bg-budu-500 px-3 py-2 text-xs font-semibold text-white transition hover:bg-budu-600"
                          >
                            {t('使用')}
                          </button>
                        </div>
                      )}

                      {/* 该分类下的产品（小卡片） */}
                      <div className="mt-2 grid max-h-56 grid-cols-2 gap-1.5 overflow-y-auto pr-1 sm:grid-cols-3">
                        {categoryProducts.map((n) => (
                          <OptionCard
                            key={n}
                            name={n}
                            selected={selectedNames.includes(n)}
                            onSelect={() => {
                              setSelectedNames((s) =>
                                s.includes(n) ? s.filter((x) => x !== n) : [...s, n],
                              )
                            }}
                          />
                        ))}
                        {categoryProducts.length === 0 && (
                          <p className="col-span-full grid place-items-center py-8 text-xs text-slate-300">
                            {t('该分类暂无产品')}
                          </p>
                        )}
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2 border-t border-slate-100 pt-2">
                        <span className="text-[11px] font-semibold text-slate-400">
                          {selectedNames.length > 0
                            ? t('已选 {n} 项，可继续勾选或直接确定', { n: selectedNames.length })
                            : t('可多选后统一填写数量')}
                        </span>
                        <div className="flex gap-1.5">
                          {selectedNames.length > 0 && (
                            <button
                              onClick={() => setSelectedNames([])}
                              className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-[11px] font-semibold text-slate-500 transition hover:bg-slate-200"
                            >
                              {t('清空')}
                            </button>
                          )}
                          <button
                            onClick={() => setProductMenuOpen(false)}
                            className="rounded-lg bg-budu-500 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-budu-600"
                          >
                            {t('确定')}
                          </button>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
            ) : (
              picker.category === 'material' ? (
                <div className="w-full">
                  <div className="grid max-h-48 grid-cols-2 gap-1.5 overflow-y-auto pr-1 sm:grid-cols-4">
                    {MATERIAL_NAMES.map((n) => (
                      <OptionCard
                        key={n}
                        name={n}
                        selected={selectedNames.includes(n)}
                        onSelect={() =>
                          setSelectedNames((s) => (s.includes(n) ? s.filter((x) => x !== n) : [...s, n]))
                        }
                      />
                    ))}
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 text-[11px] font-semibold text-slate-400">
                    <span>
                      {selectedNames.length > 0
                        ? t('已选 {n} 项，可继续勾选其他物料', { n: selectedNames.length })
                        : t('可多选物料后统一填写数量')}
                    </span>
                    {selectedNames.length > 0 && (
                      <button
                        onClick={() => setSelectedNames([])}
                        className="rounded-lg bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-500 ring-1 ring-slate-100 transition hover:text-rose-500"
                      >
                        {t('清空')}
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <input
                  value={picker.productName}
                  onChange={(e) => setPicker((s) => ({ ...s, productName: e.target.value }))}
                  placeholder={t('输入其他名称')}
                  className={`${inputCls} min-w-[180px] flex-1`}
                />
              )
            )}
            <input
              type="number"
              min="1"
              step="1"
              value={picker.quantity}
              onChange={(e) => setPicker((s) => ({ ...s, quantity: e.target.value }))}
              placeholder={t('数量')}
              className={`${inputCls} w-24`}
            />
            <input
              value={picker.note}
              onChange={(e) => setPicker((s) => ({ ...s, note: e.target.value }))}
              placeholder={t('备注')}
              className={`${inputCls} min-w-[100px] flex-1`}
            />
            <button
              onClick={addItem}
              className="flex items-center gap-1.5 rounded-xl bg-budu-500 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-budu-200/60 transition hover:bg-budu-600"
            >
              <PackagePlus className="h-4 w-4" />
              {t('添加到申请列表')}
            </button>
          </div>

          {/* 本次申请已选货品 */}
          <div className="mt-3">
            <p className="mb-1.5 text-[11px] font-semibold text-slate-400">
              {t('本次申请货品 {count} 种', { count: picked.length })}
              {picked.length > 0 && (
                <button
                  onClick={() => setPreviewList(buildCurrentList())}
                  className="ml-2 inline-flex items-center gap-1 rounded-lg bg-budu-50 px-2 py-0.5 text-[11px] font-semibold text-budu-600 transition hover:bg-budu-100"
                >
                  <FileDown className="h-3 w-3" />
                  {t('下载清单')}
                </button>
              )}
            </p>
            {picked.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {picked.map((it, idx) => (
                  <span
                    key={idx}
                    className="group inline-flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 shadow-sm ring-1 ring-slate-100"
                  >
                    <span className={`rounded px-1 py-0.5 text-[9px] font-bold ${CATEGORY_STYLE[it.category] || CATEGORY_STYLE.product}`}>
                      {t(CATEGORY_LABEL[it.category] || '产品')}
                    </span>
                    {it.productName} × {it.quantity}
                    {it.note ? `（${it.note}）` : ''}
                    <button
                      onClick={() => setPicked((list) => list.filter((_, i) => i !== idx))}
                      className="text-slate-300 transition hover:text-rose-500"
                      aria-label={t('删除')}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-slate-300">{t('尚未添加货品，选好产品后点“添加到申请列表”')}</p>
            )}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            value={form.note}
            onChange={(e) => setForm((s) => ({ ...s, note: e.target.value }))}
            placeholder={t('整单备注（选填）')}
            className={`${inputCls} max-w-md flex-1`}
          />
          <button
            onClick={submit}
            className="flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-budu-500 to-grape-500 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-budu-200/60 transition hover:opacity-90"
          >
            <PackagePlus className="h-4 w-4" />
            {t('提交申请')}
          </button>
        </div>
        {error && <p className="mt-3 text-xs font-medium text-rose-500">{error}</p>}
      </div>

      {isTransfer && (
        <InventoryStockPanel
          currentUser={currentUser}
          catalog={productNames}
          version={version}
          onChanged={(message) => {
            setVersion((value) => value + 1)
            setSavedTip(message)
            setTimeout(() => setSavedTip(''), 2200)
          }}
        />
      )}

      {/* 申请列表 */}
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-4">
          <h3 className="text-[15px] font-bold text-slate-800">{t('申请列表')}</h3>
          <div className="flex gap-1 rounded-xl bg-slate-50 p-1">
            <button
              onClick={() => setListTab('pending')}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                listTab === 'pending'
                  ? 'bg-white text-budu-600 shadow-sm'
                  : 'text-slate-500 hover:text-budu-600'
              }`}
            >
              {t('待处理')}
              <span className="ml-1.5 rounded-md bg-amber-50 px-1 py-0.5 text-[10px] font-bold text-amber-600">
                {pendingCount}
              </span>
            </button>
            <button
              onClick={() => setListTab('done')}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                listTab === 'done'
                  ? 'bg-white text-emerald-600 shadow-sm'
                  : 'text-slate-500 hover:text-emerald-600'
              }`}
            >
              {t('已处理')}
              <span className="ml-1.5 rounded-md bg-emerald-50 px-1 py-0.5 text-[10px] font-bold text-emerald-600">
                {doneCount}
              </span>
            </button>
          </div>

          {/* 日期查询 */}
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium text-slate-400">{t('按提交日期查询')}</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="rounded-xl border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-600 outline-none focus:border-budu-400"
            />
            <span className="text-[11px] text-slate-300">~</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="rounded-xl border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-600 outline-none focus:border-budu-400"
            />
            {(dateFrom || dateTo) && (
              <button
                onClick={() => {
                  setDateFrom('')
                  setDateTo('')
                }}
                className="rounded-lg px-2 py-1 text-xs font-medium text-slate-400 transition hover:bg-slate-50 hover:text-slate-600"
              >
                {t('清空日期')}
              </button>
            )}
          </div>
        </div>
        <div className="divide-y divide-slate-50">
          {requests.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
              <span
                className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                  isTransfer
                    ? (r.status === 'done' ? TRANSFER_STATUS_STYLE.completed : TRANSFER_STATUS_STYLE[r.status]) || TRANSFER_STATUS_STYLE.pending
                    : r.status === 'done' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'
                }`}
              >
                {t(isTransfer ? (r.status === 'done' ? '已完成' : TRANSFER_STATUS_LABEL[r.status]) || '待审核' : r.status === 'done' ? '已处理' : '待处理')}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-700">
                  {t('{count} 种货品', { count: r.items ? r.items.length : 1 })}
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {(() => {
                    const itemList = r.items || [{ productName: r.productName, quantity: r.quantity }]
                    const showAll = expandedIds.has(r.id)
                    const visible = showAll ? itemList : itemList.slice(0, 5)
                    return (
                      <>
                        {visible.map((it, idx) => (
                          <span
                            key={idx}
                            className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md bg-slate-50 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600"
                          >
                            <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-bold ${CATEGORY_STYLE[it.category] || CATEGORY_STYLE.product}`}>
                              {t(CATEGORY_LABEL[it.category] || '产品')}
                            </span>
                            <span className="min-w-0 truncate">{it.productName}</span>
                            <span className="shrink-0">× {it.quantity}</span>
                            {it.note && <span className="shrink-0 text-[10px] text-slate-400">（{it.note}）</span>}
                          </span>
                        ))}
                        {itemList.length > 5 && (
                          <button
                            onClick={() =>
                              setExpandedIds((s) => {
                                const next = new Set(s)
                                if (showAll) next.delete(r.id)
                                else next.add(r.id)
                                return next
                              })
                            }
                            className="inline-flex shrink-0 items-center rounded-md bg-budu-50 px-2 py-0.5 text-[11px] font-bold text-budu-600 transition hover:bg-budu-100"
                          >
                            {showAll ? t('收起') : `+${itemList.length - 5}`}
                          </button>
                        )}
                      </>
                    )
                  })()}
                </div>
                <p className="mt-0.5 text-[11px] text-slate-400">
                  {isTransfer
                    ? t('从 {from} 调往 {to}', {
                        from: storeDisplay(r.fromStoreKey, r.fromStoreName),
                        to: storeDisplay(r.storeKey, r.storeName),
                      })
                    : t('采购至 {store}', {
                        store: storeDisplay(r.storeKey, r.storeName),
                      })}
                  {r.note ? ` · ${r.note}` : ''}
                </p>
                <p className="mt-0.5 text-[11px] text-slate-300">
                  {t('由 {name} 提交', { name: r.createdBy })} · {new Date(r.createdAt).toLocaleString()}
                </p>
                {isTransfer && Array.isArray(r.history) && r.history.length > 1 && (
                  <p className="mt-1 text-[10px] text-slate-400">
                    {r.history.slice(1).map((event) => `${event.action} · ${event.operator || '—'} · ${new Date(event.at).toLocaleString()}${event.note ? `（${event.note}）` : ''}`).join(' ｜ ')}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPreviewList(r)}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-slate-400 transition hover:bg-slate-50 hover:text-budu-600"
                >
                  <FileDown className="h-3.5 w-3.5" />
                  {t('导出表格')}
                </button>
                {isTransfer && r.status === 'pending' && canShip(r) && (
                  <>
                    <button
                      onClick={() => runTransferAction(r, 'reject')}
                      className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-rose-500 transition hover:bg-rose-50"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      {t('驳回')}
                    </button>
                    <button
                      onClick={() => runTransferAction(r, 'ship')}
                      className="inline-flex items-center gap-1 rounded-lg bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-600 transition hover:bg-blue-100"
                    >
                      <Truck className="h-3.5 w-3.5" />
                      {t('确认发货')}
                    </button>
                  </>
                )}
                {isTransfer && (r.status === 'pending' || r.status === 'in_transit') && canReceive(r) && (
                  <button
                    onClick={() => runTransferAction(r, 'receive')}
                    className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-600 transition hover:bg-emerald-100"
                  >
                    <PackageCheck className="h-3.5 w-3.5" />
                    {t('确认收货')}
                  </button>
                )}
                {!isTransfer && r.status === 'pending' && canReceivePurchase(r) && (
                  <button
                    onClick={() => receivePurchase(r)}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-emerald-500 transition hover:bg-emerald-50"
                  >
                    <Check className="h-3.5 w-3.5" />
                    {t('收货入库')}
                  </button>
                )}
                {canDelete(r) && (
                  <button
                    onClick={() => remove(r)}
                    className="rounded-lg p-2 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"
                    aria-label={t('删除')}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
          {requests.length === 0 && (
            <p className="grid place-items-center py-14 text-sm text-slate-300">
              {t(listTab === 'done' ? '暂无已处理申请' : '暂无待处理申请')}
            </p>
          )}
        </div>
      </div>

      {optionEdit && canManageOptions && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => setOptionEdit(null)} />
          <div className="relative w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-slate-800">{t('选项设置：{name}', { name: optionEdit.name })}</h3>
            <div className="mt-4 space-y-3">
              <div className="flex items-center gap-3">
                <span className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-2xl bg-gradient-to-br from-budu-50 to-grape-50 text-xl font-bold text-budu-400">
                  {optionForm.image ? (
                    <img src={optionForm.image} alt="" className="h-full w-full object-cover" />
                  ) : (
                    optionEdit.name[0]
                  )}
                </span>
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-budu-50 px-3 py-2 text-xs font-semibold text-budu-600 transition hover:bg-budu-100">
                  <UploadCloud className="h-4 w-4" />
                  {t('上传图片')}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={async (e) => {
                      const f = e.target.files && e.target.files[0]
                      e.target.value = ''
                      if (f) {
                        const data = await compressImage(f)
                        setOptionForm((s) => ({ ...s, image: data }))
                      }
                    }}
                  />
                </label>
                {optionForm.image && (
                  <button
                    onClick={() => setOptionForm((s) => ({ ...s, image: '' }))}
                    className="text-xs font-medium text-rose-400 transition hover:text-rose-500"
                  >
                    {t('移除图片')}
                  </button>
                )}
              </div>
              <div>
                <span className="mb-1.5 block text-xs font-semibold text-slate-500">{t('规格')}</span>
                <input
                  value={optionForm.spec}
                  onChange={(e) => setOptionForm((s) => ({ ...s, spec: e.target.value }))}
                  placeholder={t('例如 8颗/盒 · 约 60g')}
                  className={inputCls}
                />
              </div>
            </div>
            {error && <p className="mt-3 text-xs font-medium text-rose-500">{error}</p>}
            <div className="mt-5 flex gap-2">
              <button
                onClick={() => setOptionEdit(null)}
                className="flex-1 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-200"
              >
                {t('取消')}
              </button>
              <button
                onClick={saveOption}
                className="flex-1 rounded-xl bg-gradient-to-r from-budu-500 to-grape-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-budu-200/60 transition hover:opacity-90"
              >
                {t('保存')}
              </button>
            </div>
          </div>
        </div>
      )}

      {previewList && <InventoryListModal request={previewList} onClose={() => setPreviewList(null)} />}
    </div>
  )
}
