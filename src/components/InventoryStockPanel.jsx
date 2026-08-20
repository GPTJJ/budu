import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, History, PackageOpen, PackagePlus, Search, Settings2, Store, X } from 'lucide-react'
import { allStores, storeName } from '../utils/selectors'
import { getInventory, loadUserData } from '../utils/userData'
import { inventoryQuantity } from '../utils/inventory'
import { api } from '../utils/api'
import { t } from '../utils/text'

const inputCls = 'input py-2.5'

const CATEGORIES = ['product', 'material', 'other']

function formatTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

function ModalShell({ title, subtitle, onClose, children }) {
  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center sm:items-center sm:p-4">
      <button className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} aria-label={t('关闭')} />
      <div className="relative max-h-[88vh] w-full overflow-y-auto rounded-t-3xl bg-white p-5 shadow-lg sm:max-w-lg sm:rounded-2xl sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold text-slate-800">{title}</h3>
            {subtitle && <p className="mt-1 text-xs text-slate-400">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-xl bg-slate-50 text-slate-400">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="mt-5">{children}</div>
      </div>
    </div>
  )
}

export default function InventoryStockPanel({ currentUser, catalog = [], version, onChanged }) {
  const stores = allStores()
  const inventory = getInventory()
  const [storeFilter, setStoreFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const [wasteOpen, setWasteOpen] = useState(false)
  const [itemOpen, setItemOpen] = useState(false)
  const [ledgerOpen, setLedgerOpen] = useState(false)
  const [ledgerType, setLedgerType] = useState('')
  const [ledgerRows, setLedgerRows] = useState([])
  const [items, setItems] = useState([])
  const [newItem, setNewItem] = useState({ name: '', unit: '', spec: '', barcode: '', category: 'product' })
  const [form, setForm] = useState({ storeKey: stores[0]?.key || '', productName: '', quantity: '', minQty: '' })
  const [wasteForm, setWasteForm] = useState({ storeKey: stores[0]?.key || '', productName: '', quantity: '', reason: '' })
  const [error, setError] = useState('')
  const canManage = Boolean(currentUser && ['developer', 'manager'].includes(currentUser.role))
  const current = inventoryQuantity(inventory, form.storeKey, form.productName.trim())

  const rows = useMemo(
    () =>
      inventory
        .filter((row) => storeFilter === 'all' || row.storeKey === storeFilter)
        .filter((row) => !search.trim() || row.productName.toLowerCase().includes(search.trim().toLowerCase()))
        .sort(
          (a, b) =>
            storeName(a.storeKey).localeCompare(storeName(b.storeKey), 'zh-CN') ||
            a.productName.localeCompare(b.productName, 'zh-CN'),
        ),
    [inventory, storeFilter, search, version],
  )

  useEffect(() => {
    if (!itemOpen) return
    api('/v2/items').then((d) => setItems(d.rows || [])).catch(() => {})
  }, [itemOpen])

  useEffect(() => {
    if (!ledgerOpen) return
    const store = storeFilter === 'all' ? '' : storeFilter
    const qs = new URLSearchParams()
    if (store) qs.set('store', store)
    if (ledgerType) qs.set('type', ledgerType)
    api(`/v2/stock/ledger?${qs.toString()}`)
      .then((d) => setLedgerRows(d.rows || []))
      .catch(() => setLedgerRows([]))
  }, [ledgerOpen, ledgerType, storeFilter, version])

  const saveAdjust = async () => {
    setError('')
    try {
      if (form.quantity === '') throw new Error('请填写盘点后的库存数量')
      await api('/v2/stock/adjust', {
        method: 'POST',
        body: JSON.stringify({
          storeKey: form.storeKey,
          items: [{ name: form.productName.trim(), quantity: Number(form.quantity), minQty: form.minQty === '' ? undefined : Number(form.minQty) }],
        }),
      })
      await loadUserData()
      setOpen(false)
      setForm((value) => ({ ...value, productName: '', quantity: '', minQty: '' }))
      onChanged?.(t('库存已更新'))
    } catch (err) {
      setError(t(err.message))
    }
  }

  const saveWaste = async () => {
    setError('')
    try {
      if (!wasteForm.productName.trim() || wasteForm.quantity === '') throw new Error('请填写货品与数量')
      await api('/v2/stock/waste', {
        method: 'POST',
        body: JSON.stringify({
          storeKey: wasteForm.storeKey,
          items: [{ name: wasteForm.productName.trim(), quantity: Number(wasteForm.quantity), reason: wasteForm.reason }],
        }),
      })
      await loadUserData()
      setWasteOpen(false)
      setWasteForm((value) => ({ ...value, productName: '', quantity: '', reason: '' }))
      onChanged?.(t('已报损并扣减库存'))
    } catch (err) {
      setError(t(err.message))
    }
  }

  const addItem = async () => {
    setError('')
    try {
      await api('/v2/items', { method: 'POST', body: JSON.stringify(newItem) })
      setNewItem({ name: '', unit: '', spec: '', barcode: '', category: 'product' })
      const d = await api('/v2/items')
      setItems(d.rows || [])
      onChanged?.(t('货品已添加'))
    } catch (err) {
      setError(t(err.message))
    }
  }

  const saveItem = async (item) => {
    setError('')
    try {
      await api(`/v2/items/${item.id}`, { method: 'PUT', body: JSON.stringify(item) })
      onChanged?.(t('货品已保存'))
    } catch (err) {
      setError(t(err.message))
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
        <div className="mr-auto">
          <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800">
            <PackageOpen className="h-4 w-4 text-budu-500" />
            {t('门店库存')}
          </h3>
          <p className="mt-0.5 text-[11px] text-slate-400">{t('发货自动扣减，收货自动增加')}</p>
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-1.5">
            <button onClick={() => setItemOpen(true)} className="inline-flex items-center gap-1.5 rounded-xl bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100">
              <PackagePlus className="h-3.5 w-3.5" />
              {t('货品档案')}
            </button>
            <button onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 rounded-xl bg-budu-50 px-3 py-2 text-xs font-semibold text-budu-600">
              <Settings2 className="h-3.5 w-3.5" />
              {t('库存调整')}
            </button>
            <button onClick={() => setWasteOpen(true)} className="inline-flex items-center gap-1.5 rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600">
              <AlertTriangle className="h-3.5 w-3.5" />
              {t('报损')}
            </button>
            <button onClick={() => setLedgerOpen(true)} className="inline-flex items-center gap-1.5 rounded-xl bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100">
              <History className="h-3.5 w-3.5" />
              {t('流水')}
            </button>
          </div>
        )}
      </div>
      <div className="grid gap-2 p-3 sm:grid-cols-[13rem_1fr]">
        <select value={storeFilter} onChange={(e) => setStoreFilter(e.target.value)} className={inputCls}>
          <option value="all">{t('全部门店')}</option>
          {stores.map((store) => (
            <option key={store.key} value={store.key}>
              {store.name}
            </option>
          ))}
        </select>
        <label className="relative block">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-300" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('搜索商品')} className={`${inputCls} pl-9`} />
        </label>
      </div>
      {rows.length ? (
        <div className="max-h-72 divide-y divide-slate-50 overflow-y-auto">
          {rows.map((row) => {
            const low = row.minQty > 0 && row.quantity <= row.minQty
            return (
              <div key={`${row.storeKey}-${row.productName}`} className={`grid gap-1 px-4 py-3 sm:grid-cols-[1fr_1.4fr_0.5fr_1fr] sm:items-center ${low ? 'bg-rose-50/50' : ''}`}>
                <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
                  <Store className="h-3.5 w-3.5 text-budu-600" />
                  {storeName(row.storeKey)}
                </span>
                <span className="flex items-center gap-1.5 text-xs text-slate-600">
                  {row.productName}
                  {low && (
                    <span className="inline-flex items-center gap-0.5 rounded-md bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold text-rose-600">
                      <AlertTriangle className="h-3 w-3" />
                      {t('库存预警')}
                    </span>
                  )}
                </span>
                <span className={`text-base font-bold sm:text-right ${low ? 'text-rose-600' : 'text-slate-800'}`}>{row.quantity}</span>
                <span className="text-[10px] text-slate-400 sm:text-right">
                  {row.minQty > 0 ? `${t('阈值 {n}', { n: row.minQty })} · ` : ''}
                  {formatTime(row.updatedAt)}
                  {row.updatedBy ? ` · ${row.updatedBy}` : ''}
                </span>
              </div>
            )
          })}
        </div>
      ) : (
        <p className="grid place-items-center py-10 text-xs text-slate-300">{t(canManage ? '请先使用“库存调整”录入盘点数量' : '暂无库存数据')}</p>
      )}

      {open && (
        <ModalShell title={t('库存盘点 / 调整')} subtitle={t('用于初始化库存或修正实际盘点差异')} onClose={() => setOpen(false)}>
          <div className="space-y-3">
            <select value={form.storeKey} onChange={(e) => setForm((v) => ({ ...v, storeKey: e.target.value }))} className={inputCls}>
              {stores.map((store) => (
                <option key={store.key} value={store.key}>
                  {store.name}
                </option>
              ))}
            </select>
            <input list="inventory-stock-catalog" value={form.productName} onChange={(e) => setForm((v) => ({ ...v, productName: e.target.value }))} placeholder={t('输入或选择商品')} className={inputCls} />
            <datalist id="inventory-stock-catalog">
              {catalog.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <label className="block">
              <span className="mb-1 flex justify-between text-xs font-semibold text-slate-500">
                <span>{t('盘点后数量')}</span>
                {form.productName.trim() && <span className="font-normal text-slate-400">{t('当前')}：{current}</span>}
              </span>
              <input type="number" min="0" step="1" value={form.quantity} onChange={(e) => setForm((v) => ({ ...v, quantity: e.target.value }))} className={inputCls} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-slate-500">{t('安全库存（低于此值预警，0=不预警）')}</span>
              <input type="number" min="0" step="1" value={form.minQty} onChange={(e) => setForm((v) => ({ ...v, minQty: e.target.value }))} placeholder="0" className={inputCls} />
            </label>
          </div>
          {error && <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs font-medium text-rose-600">{error}</p>}
          <div className="mt-5 flex gap-2">
            <button onClick={() => setOpen(false)} className="flex-1 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-500">
              {t('取消')}
            </button>
            <button onClick={saveAdjust} className="flex-1 rounded-xl bg-budu-500 px-4 py-2.5 text-sm font-semibold text-white">
              {t('保存库存')}
            </button>
          </div>
        </ModalShell>
      )}

      {wasteOpen && (
        <ModalShell title={t('报损')} subtitle={t('记录损耗并扣减库存（无需审批）')} onClose={() => setWasteOpen(false)}>
          <div className="space-y-3">
            <select value={wasteForm.storeKey} onChange={(e) => setWasteForm((v) => ({ ...v, storeKey: e.target.value }))} className={inputCls}>
              {stores.map((store) => (
                <option key={store.key} value={store.key}>
                  {store.name}
                </option>
              ))}
            </select>
            <input list="inventory-stock-catalog" value={wasteForm.productName} onChange={(e) => setWasteForm((v) => ({ ...v, productName: e.target.value }))} placeholder={t('输入或选择商品')} className={inputCls} />
            <input type="number" min="1" step="1" value={wasteForm.quantity} onChange={(e) => setWasteForm((v) => ({ ...v, quantity: e.target.value }))} placeholder={t('报损数量')} className={inputCls} />
            <input value={wasteForm.reason} onChange={(e) => setWasteForm((v) => ({ ...v, reason: e.target.value }))} placeholder={t('报损原因（选填）')} className={inputCls} />
          </div>
          {error && <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs font-medium text-rose-600">{error}</p>}
          <div className="mt-5 flex gap-2">
            <button onClick={() => setWasteOpen(false)} className="flex-1 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-500">
              {t('取消')}
            </button>
            <button onClick={saveWaste} className="flex-1 rounded-xl bg-rose-500 px-4 py-2.5 text-sm font-semibold text-white">
              {t('确认报损')}
            </button>
          </div>
        </ModalShell>
      )}

      {itemOpen && (
        <ModalShell title={t('货品档案')} subtitle={t('维护单位/规格/条码/分类')} onClose={() => setItemOpen(false)}>
          <div className="space-y-3">
            <div className="rounded-2xl bg-slate-50 p-3">
              <p className="mb-2 text-xs font-semibold text-slate-500">{t('新增货品')}</p>
              <input value={newItem.name} onChange={(e) => setNewItem((v) => ({ ...v, name: e.target.value }))} placeholder={t('名称')} className={`${inputCls} mb-2`} />
              <div className="grid grid-cols-2 gap-2">
                <input value={newItem.unit} onChange={(e) => setNewItem((v) => ({ ...v, unit: e.target.value }))} placeholder={t('单位')} className={inputCls} />
                <input value={newItem.spec} onChange={(e) => setNewItem((v) => ({ ...v, spec: e.target.value }))} placeholder={t('规格')} className={inputCls} />
                <input value={newItem.barcode} onChange={(e) => setNewItem((v) => ({ ...v, barcode: e.target.value }))} placeholder={t('条码')} className={inputCls} />
                <select value={newItem.category} onChange={(e) => setNewItem((v) => ({ ...v, category: e.target.value }))} className={inputCls}>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {t(c === 'product' ? '产品' : c === 'material' ? '物料' : '其他')}
                    </option>
                  ))}
                </select>
              </div>
              <button onClick={addItem} className="mt-2 w-full rounded-xl bg-budu-500 px-4 py-2 text-sm font-semibold text-white">
                {t('添加货品')}
              </button>
            </div>
            <div className="max-h-72 space-y-2 overflow-y-auto">
              {items.map((item) => (
                <div key={item.id} className="rounded-2xl border border-slate-100 p-3">
                  <p className="mb-2 text-xs font-bold text-slate-700">{item.name}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <input value={item.unit} onChange={(e) => setItems((list) => list.map((x) => (x.id === item.id ? { ...x, unit: e.target.value } : x)))} placeholder={t('单位')} className={inputCls} />
                    <input value={item.spec} onChange={(e) => setItems((list) => list.map((x) => (x.id === item.id ? { ...x, spec: e.target.value } : x)))} placeholder={t('规格')} className={inputCls} />
                    <input value={item.barcode} onChange={(e) => setItems((list) => list.map((x) => (x.id === item.id ? { ...x, barcode: e.target.value } : x)))} placeholder={t('条码')} className={inputCls} />
                    <select value={item.category} onChange={(e) => setItems((list) => list.map((x) => (x.id === item.id ? { ...x, category: e.target.value } : x)))} className={inputCls}>
                      {CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {t(c === 'product' ? '产品' : c === 'material' ? '物料' : '其他')}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button onClick={() => saveItem(item)} className="mt-2 rounded-lg bg-budu-50 px-3 py-1.5 text-xs font-semibold text-budu-600">
                    {t('保存')}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </ModalShell>
      )}

      {ledgerOpen && (
        <ModalShell title={t('出入库流水')} subtitle={t('按类型筛选库存变动记录')} onClose={() => setLedgerOpen(false)}>
          <select value={ledgerType} onChange={(e) => setLedgerType(e.target.value)} className={inputCls}>
            <option value="">{t('全部类型')}</option>
            <option value="transfer_in">{t('调货入库')}</option>
            <option value="transfer_out">{t('调货出库')}</option>
            <option value="purchase_in">{t('采购入库')}</option>
            <option value="waste">{t('报损')}</option>
            <option value="adjust">{t('盘点调整')}</option>
          </select>
          <div className="mt-3 max-h-72 space-y-1.5 overflow-y-auto">
            {ledgerRows.map((row) => (
              <div key={row.id} className="flex items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2 text-xs">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-slate-700">
                    {row.name} · {row.type}
                  </p>
                  <p className="text-[10px] text-slate-400">
                    {row.storeKey} · {row.operator || '—'} · {formatTime(row.createdAt)}
                  </p>
                </div>
                <span className={`shrink-0 font-bold ${row.change >= 0 ? 'text-emerald-600' : 'text-rose-500'}`}>
                  {row.change >= 0 ? '+' : ''}
                  {row.change}（{row.balance}）
                </span>
              </div>
            ))}
            {ledgerRows.length === 0 && <p className="grid place-items-center py-10 text-xs text-slate-300">{t('暂无流水')}</p>}
          </div>
        </ModalShell>
      )}
    </div>
  )
}
