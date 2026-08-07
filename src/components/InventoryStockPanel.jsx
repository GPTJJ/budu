import { useMemo, useState } from 'react'
import { PackageOpen, Search, Settings2, Store, X } from 'lucide-react'
import { allStores, storeName } from '../utils/selectors'
import { getInventory, loadUserData } from '../utils/userData'
import { inventoryQuantity } from '../utils/inventory'
import { api } from '../utils/api'
import { useI18n } from '../i18n'

const inputCls =
  'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-budu-400 focus:ring-2 focus:ring-budu-100'

function formatTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

export default function InventoryStockPanel({ currentUser, catalog = [], version, onChanged }) {
  const { t } = useI18n()
  const stores = allStores()
  const inventory = getInventory()
  const [storeFilter, setStoreFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ storeKey: stores[0]?.key || '', productName: '', quantity: '' })
  const [error, setError] = useState('')
  const isDeveloper = currentUser?.role === 'developer'
  const current = inventoryQuantity(inventory, form.storeKey, form.productName.trim())

  const rows = useMemo(() => inventory
    .filter((row) => storeFilter === 'all' || row.storeKey === storeFilter)
    .filter((row) => !search.trim() || row.productName.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => storeName(a.storeKey).localeCompare(storeName(b.storeKey), 'zh-CN') || a.productName.localeCompare(b.productName, 'zh-CN')),
  [inventory, storeFilter, search, version])

  const save = async () => {
    setError('')
    try {
      if (form.quantity === '') throw new Error('请填写盘点后的库存数量')
      await api('/v2/stock/adjust', {
        method: 'POST',
        body: JSON.stringify({
          storeKey: form.storeKey,
          items: [{ name: form.productName.trim(), quantity: Number(form.quantity) }],
        }),
      })
      await loadUserData()
      setOpen(false)
      setForm((value) => ({ ...value, productName: '', quantity: '' }))
      onChanged?.(t('库存已更新'))
    } catch (err) {
      setError(t(err.message))
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
        <div className="mr-auto">
          <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><PackageOpen className="h-4 w-4 text-budu-500" />{t('门店库存')}</h3>
          <p className="mt-0.5 text-[11px] text-slate-400">{t('发货自动扣减，收货自动增加')}</p>
        </div>
        {isDeveloper && (
          <button onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 rounded-xl bg-budu-50 px-3 py-2 text-xs font-semibold text-budu-600">
            <Settings2 className="h-3.5 w-3.5" />{t('库存调整')}
          </button>
        )}
      </div>
      <div className="grid gap-2 p-3 sm:grid-cols-[13rem_1fr]">
        <select value={storeFilter} onChange={(event) => setStoreFilter(event.target.value)} className={inputCls}>
          <option value="all">{t('全部门店')}</option>
          {stores.map((store) => <option key={store.key} value={store.key}>{store.name}</option>)}
        </select>
        <label className="relative block">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-300" />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('搜索商品')} className={`${inputCls} pl-9`} />
        </label>
      </div>
      {rows.length ? (
        <div className="max-h-72 divide-y divide-slate-50 overflow-y-auto">
          {rows.map((row) => (
            <div key={`${row.storeKey}-${row.productName}`} className="grid gap-1 px-4 py-3 sm:grid-cols-[1fr_1.4fr_0.5fr_1fr] sm:items-center">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-600"><Store className="h-3.5 w-3.5 text-budu-400" />{storeName(row.storeKey)}</span>
              <span className="text-xs text-slate-600">{row.productName}</span>
              <span className="text-base font-black text-slate-800 sm:text-right">{row.quantity}</span>
              <span className="text-[10px] text-slate-400 sm:text-right">{formatTime(row.updatedAt)}{row.updatedBy ? ` · ${row.updatedBy}` : ''}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="grid place-items-center py-10 text-xs text-slate-300">{t(isDeveloper ? '请先使用“库存调整”录入盘点数量' : '暂无库存数据')}</p>
      )}

      {open && (
        <div className="fixed inset-0 z-[90] flex items-end justify-center sm:items-center sm:p-4">
          <button className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => setOpen(false)} aria-label={t('关闭')} />
          <div className="relative w-full rounded-t-3xl bg-white p-5 shadow-2xl sm:max-w-md sm:rounded-3xl sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <div><h3 className="text-lg font-bold text-slate-800">{t('库存盘点 / 调整')}</h3><p className="mt-1 text-xs text-slate-400">{t('用于初始化库存或修正实际盘点差异')}</p></div>
              <button onClick={() => setOpen(false)} className="grid h-9 w-9 place-items-center rounded-xl bg-slate-50 text-slate-400"><X className="h-5 w-5" /></button>
            </div>
            <div className="mt-5 space-y-3">
              <select value={form.storeKey} onChange={(event) => setForm((value) => ({ ...value, storeKey: event.target.value }))} className={inputCls}>
                {stores.map((store) => <option key={store.key} value={store.key}>{store.name}</option>)}
              </select>
              <input list="inventory-stock-catalog" value={form.productName} onChange={(event) => setForm((value) => ({ ...value, productName: event.target.value }))} placeholder={t('输入或选择商品')} className={inputCls} />
              <datalist id="inventory-stock-catalog">{catalog.map((name) => <option key={name} value={name} />)}</datalist>
              <label className="block">
                <span className="mb-1 flex justify-between text-xs font-semibold text-slate-500"><span>{t('盘点后数量')}</span>{form.productName.trim() && <span className="font-normal text-slate-400">{t('当前')}：{current}</span>}</span>
                <input type="number" min="0" step="0.01" value={form.quantity} onChange={(event) => setForm((value) => ({ ...value, quantity: event.target.value }))} className={inputCls} />
              </label>
            </div>
            {error && <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs font-medium text-rose-600">{error}</p>}
            <div className="mt-5 flex gap-2"><button onClick={() => setOpen(false)} className="flex-1 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-500">{t('取消')}</button><button onClick={save} className="flex-1 rounded-xl bg-gradient-to-r from-budu-500 to-grape-500 px-4 py-2.5 text-sm font-semibold text-white">{t('保存库存')}</button></div>
          </div>
        </div>
      )}
    </div>
  )
}
