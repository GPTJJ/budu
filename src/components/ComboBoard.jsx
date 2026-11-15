import { useCallback, useEffect, useState } from 'react'
import { Pencil, RefreshCw, Boxes } from 'lucide-react'
import { api } from '../utils/api'
import { formatCents } from '../utils/pos'

/**
 * 商品 → 组合商品
 *
 * 组合商品（如 ¥299 Balls 礼盒）的口味范围与槽位在商品编辑弹窗里维护；
 * 这里做集中视图，方便核对每个组合的口味数量、价格与上架状态。
 */

export default function ComboBoard({ onGo }) {
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api('/v2/online-catalog/products')
      setProducts((res.products || []).filter((product) => product.combo))
    } catch (err) {
      setError(err.message || '加载组合商品失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <div>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[11px] leading-relaxed text-slate-500">口味范围与槽位在「商品 → 编辑」的组合设置里维护；保存后会自动重建该组合的全部 SKU 映射。</p>
        <button type="button" onClick={load} className="inline-flex h-9 items-center justify-center gap-1 rounded-xl border border-slate-200 px-3 text-sm text-slate-600 hover:bg-slate-50 sm:h-8">
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

      {error ? <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700">{error}</div> : null}

      {loading ? (
        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-14 text-center text-xs text-slate-400">加载中…</div>
      ) : !products.length ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-6 py-14 text-center">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-slate-100 text-slate-400"><Boxes size={20} /></div>
          <div className="text-sm text-slate-600">还没有组合商品</div>
          <p className="mx-auto mt-1 max-w-md text-[11px] text-slate-400">在商品编辑弹窗里打开「组合商品设置」，选择口味范围与每盒口味数后保存即可。</p>
        </div>
      ) : (
        <div className="space-y-2">
          {products.map((product) => {
            const combo = product.combo || {}
            const slots = Number(combo.slots) || 0
            const flavorCount = Array.isArray(combo.flavorIds) ? combo.flavorIds.length : 0
            const cover = (product.mediaDisplay && product.mediaDisplay.cover) || (product.media && product.media.cover) || ''
            return (
              <div key={product.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3">
                <div className="h-16 w-[88px] shrink-0 overflow-hidden rounded-lg bg-slate-100">
                  {cover ? <img src={cover} alt="" className="h-full w-full object-cover" /> : null}
                </div>
                <div className="min-w-[180px] flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-semibold text-slate-800">{product.title}</span>
                    <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">{product.mpId}</span>
                    <span className={`rounded-md px-1.5 py-0.5 text-[10px] ${product.status === 'ON' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                      {product.status === 'ON' ? '已上架' : '已下架'}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] text-slate-500">
                    每盒选 {slots} 款 · 可选口味 {flavorCount} 种 · {combo.repeat ? '允许重复' : '不可重复'} · 单盒价 {combo.unitPriceCent ? formatCents(combo.unitPriceCent) : '按线上价'}
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-400">线上售价 {formatCents(product.priceCents)} · 排序 {product.sortOrder}</div>
                </div>
                <div className="ml-auto flex items-center gap-1">
                  <button type="button" onClick={() => onGo && onGo('products', 'products')} className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-2.5 text-xs text-slate-600 hover:bg-slate-50">
                    <Pencil size={12} /> 去商品页编辑
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="mt-3 rounded-xl border border-budu-100 bg-budu-50/60 px-4 py-2 text-[11px] leading-relaxed text-budu-700">
        发布组合商品前会校验：所有可选口味必须处于上架状态，否则发布会返回 409 并保持原文档不变。
      </div>
    </div>
  )
}
