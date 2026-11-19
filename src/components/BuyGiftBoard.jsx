import { useCallback, useEffect, useMemo, useState } from 'react'
import { Gift, Plus, Trash2 } from 'lucide-react'
import { api } from '../utils/api'

/**
 * 买赠活动（营销）
 *
 * 配置写入 CloudBase `promotions/buy_gift`，小程序下单时由云函数读取同一份文档，
 * 因此保存即生效，没有「发布」步骤。
 *
 * 口径：
 *  - 触发按分类累计件数，或按指定商品累计；
 *  - 每单只触发满足条件的最高档一次，不按倍数叠加；
 *  - 赠品以 0 元行进入订单，参与发货/退款，不折现。
 */

const inputClass = 'w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-budu-400'
const yuan = (cent) => (Number(cent || 0) / 100).toFixed(2).replace(/\.00$/, '')

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-slate-600">{label}</span>
        {hint ? <span className="text-[11px] text-slate-400">{hint}</span> : null}
      </div>
      {children}
    </label>
  )
}

const pad = (n) => String(n).padStart(2, '0')
function toLocalInput(ms) {
  if (!ms) return ''
  const d = new Date(Number(ms))
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function fromLocalInput(value) {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

export default function BuyGiftBoard() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [products, setProducts] = useState([])
  const [categories, setCategories] = useState([])
  const [form, setForm] = useState({
    active: false,
    triggerType: 'category',
    triggerCategory: '',
    triggerProductIds: [],
    tiers: [],
    startAt: '',
    endAt: '',
  })
  const [productFilter, setProductFilter] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api('/v2/online-catalog/buy-gift')
      const config = res?.config || {}
      setProducts(Array.isArray(res?.products) ? res.products : [])
      setCategories(Array.isArray(res?.categories) ? res.categories : [])
      setForm({
        active: !!config.active,
        triggerType: config.triggerType === 'products' ? 'products' : 'category',
        triggerCategory: config.triggerCategory || '',
        triggerProductIds: Array.isArray(config.triggerProductIds) ? config.triggerProductIds.map(String) : [],
        tiers: Array.isArray(config.tiers) && config.tiers.length
          ? config.tiers.map((t) => ({
            minQty: String(t.minQty ?? ''),
            giftProductId: String(t.giftProductId || ''),
            giftQty: String(t.giftQty ?? 1),
            label: String(t.label || ''),
          }))
          : [{ minQty: '2', giftProductId: '', giftQty: '1', label: '' }],
        startAt: toLocalInput(config.startAt),
        endAt: toLocalInput(config.endAt),
      })
    } catch (err) {
      setError(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const productMap = useMemo(() => {
    const map = new Map()
    for (const p of products) map.set(p.id, p)
    return map
  }, [products])

  const filteredProducts = useMemo(() => {
    const keyword = productFilter.trim()
    return products.filter((p) => !keyword || p.name.includes(keyword) || p.category.includes(keyword))
  }, [products, productFilter])

  const toggleTriggerProduct = (id) => {
    setForm((prev) => {
      const exists = prev.triggerProductIds.includes(id)
      return {
        ...prev,
        triggerProductIds: exists ? prev.triggerProductIds.filter((x) => x !== id) : [...prev.triggerProductIds, id],
      }
    })
  }

  const updateTier = (index, patch) => {
    setForm((prev) => ({
      ...prev,
      tiers: prev.tiers.map((tier, i) => (i === index ? { ...tier, ...patch } : tier)),
    }))
  }

  const addTier = () => {
    setForm((prev) => ({ ...prev, tiers: [...prev.tiers, { minQty: '', giftProductId: '', giftQty: '1', label: '' }] }))
  }

  const removeTier = (index) => {
    setForm((prev) => ({ ...prev, tiers: prev.tiers.filter((_, i) => i !== index) }))
  }

  const save = async () => {
    if (saving) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const payload = {
        active: form.active,
        triggerType: form.triggerType,
        triggerCategory: form.triggerCategory,
        triggerProductIds: form.triggerProductIds,
        startAt: fromLocalInput(form.startAt),
        endAt: fromLocalInput(form.endAt),
        tiers: form.tiers.map((tier) => ({
          minQty: Number(tier.minQty),
          giftProductId: tier.giftProductId,
          giftQty: Number(tier.giftQty) || 1,
          label: tier.label,
        })),
      }
      const res = await api('/v2/online-catalog/buy-gift', { method: 'PUT', body: JSON.stringify(payload) })
      if (!res?.ok) throw new Error(res?.message || '保存失败')
      setNotice('已保存，小程序下单立即按新规则计算')
      await load()
    } catch (err) {
      setError(err.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const triggerText = form.triggerType === 'products'
    ? `指定 ${form.triggerProductIds.length} 个商品`
    : (form.triggerCategory || '未选择分类')

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-800">
            <Gift className="h-4 w-4 text-budu-500" /> 买赠活动
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            买满指定件数自动送赠品，赠品 0 元进入订单。保存即生效，每单只触发最高档一次。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
            启用活动
          </label>
          <button type="button" onClick={save} disabled={saving || loading} className="rounded-xl bg-budu-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>

      {error ? <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-600">{error}</div> : null}
      {notice ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{notice}</div> : null}

      {loading ? (
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-400">加载中…</div>
      ) : (
        <>
          <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="触发方式">
                <select className={inputClass} value={form.triggerType} onChange={(e) => setForm({ ...form, triggerType: e.target.value })}>
                  <option value="category">按商品分类（同分类不同口味可混算）</option>
                  <option value="products">按指定商品</option>
                </select>
              </Field>

              {form.triggerType === 'category' ? (
                <Field label="触发分类">
                  <select className={inputClass} value={form.triggerCategory} onChange={(e) => setForm({ ...form, triggerCategory: e.target.value })}>
                    <option value="">请选择</option>
                    {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </Field>
              ) : (
                <Field label="已选触发商品" hint={`${form.triggerProductIds.length} 个`}>
                  <div className="rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-500">
                    {form.triggerProductIds.length
                      ? form.triggerProductIds.map((id) => productMap.get(id)?.name).filter(Boolean).join('、')
                      : '在下方列表勾选'}
                  </div>
                </Field>
              )}

              <Field label="开始时间" hint="留空 = 立即">
                <input type="datetime-local" className={inputClass} value={form.startAt} onChange={(e) => setForm({ ...form, startAt: e.target.value })} />
              </Field>
              <Field label="结束时间" hint="留空 = 长期">
                <input type="datetime-local" className={inputClass} value={form.endAt} onChange={(e) => setForm({ ...form, endAt: e.target.value })} />
              </Field>
            </div>

            {form.triggerType === 'products' ? (
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="text-xs font-medium text-slate-600">选择触发商品</div>
                  <input className="w-52 rounded-lg border border-slate-200 px-2 py-1 text-xs" placeholder="搜商品名/分类" value={productFilter} onChange={(e) => setProductFilter(e.target.value)} />
                </div>
                <div className="max-h-56 overflow-y-auto rounded-xl border border-slate-100 divide-y divide-slate-50">
                  {filteredProducts.map((p) => (
                    <label key={p.id} className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-xs hover:bg-slate-50">
                      <span className="flex items-center gap-2">
                        <input type="checkbox" checked={form.triggerProductIds.includes(p.id)} onChange={() => toggleTriggerProduct(p.id)} />
                        <span className="text-slate-700">{p.name}</span>
                        <span className="text-slate-400">{p.category}</span>
                      </span>
                      <span className="text-slate-400">{p.priceCent ? `¥${yuan(p.priceCent)}` : ''}</span>
                    </label>
                  ))}
                  {!filteredProducts.length ? <div className="px-3 py-6 text-center text-xs text-slate-400">没有匹配商品</div> : null}
                </div>
              </div>
            ) : null}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <div>
                <div className="text-sm font-semibold text-slate-800">档位与赠品</div>
                <div className="text-[11px] text-slate-400">按满件数升序，每单只取最高档；同一件数不能重复</div>
              </div>
              <button type="button" onClick={addTier} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600">
                <Plus className="h-3.5 w-3.5" /> 加一档
              </button>
            </div>

            <div className="space-y-3 p-4">
              {form.tiers.map((tier, index) => (
                <div key={index} className="grid items-end gap-2 rounded-xl bg-slate-50 p-3 md:grid-cols-[110px_1fr_90px_1fr_40px]">
                  <Field label="满件数">
                    <input className={inputClass} inputMode="numeric" value={tier.minQty} onChange={(e) => updateTier(index, { minQty: e.target.value })} placeholder="2" />
                  </Field>
                  <Field label="赠品">
                    <select className={inputClass} value={tier.giftProductId} onChange={(e) => updateTier(index, { giftProductId: e.target.value })}>
                      <option value="">请选择</option>
                      {products.filter((p) => p.status !== 'off').map((p) => (
                        <option key={p.id} value={p.id}>{p.name}（{p.category}）</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="数量">
                    <input className={inputClass} inputMode="numeric" value={tier.giftQty} onChange={(e) => updateTier(index, { giftQty: e.target.value })} />
                  </Field>
                  <Field label="展示文案" hint="顾客可见">
                    <input className={inputClass} value={tier.label} onChange={(e) => updateTier(index, { label: e.target.value })} placeholder="买 2 盒送 1 盒巧克力豆" />
                  </Field>
                  <button type="button" onClick={() => removeTier(index)} className="mb-1 inline-flex h-9 items-center justify-center rounded-lg border border-slate-200 text-slate-400 hover:text-rose-500">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
              {!form.tiers.length ? <div className="rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center text-xs text-slate-400">还没有档位</div> : null}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-500">
            <div className="mb-1 text-[11px] text-slate-400">效果预览</div>
            {form.active ? (
              <div className="space-y-1">
                <div>触发：{triggerText}</div>
                {form.tiers.filter((t) => t.giftProductId && t.minQty).map((tier, i) => (
                  <div key={i}>
                    买满 <b className="text-slate-700">{tier.minQty}</b> 件 → 送 <b className="text-slate-700">{productMap.get(tier.giftProductId)?.name || '未选择'}</b> ×{tier.giftQty || 1}
                    {tier.label ? <span className="text-slate-400">（{tier.label}）</span> : null}
                  </div>
                ))}
              </div>
            ) : <div className="text-slate-400">活动未启用，小程序不会赠品</div>}
          </div>
        </>
      )}
    </div>
  )
}
