import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, Send, AlertTriangle } from 'lucide-react'
import { api } from '../utils/api'

/**
 * 设置 → 发布记录
 *
 * 汇总两类「发布」的当前状态：
 *  - 商品档案：每个商品的最近一次发布结果（成功时间 / 失败原因 / 从未发布）
 *  - 首页轮播：整包发布的版本、时间与脏状态
 * 只读页面；重新发布请到商品页 / 营销页操作。
 */

function fmtTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const STATE_STYLE = {
  PUBLISHED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  FAILED: 'bg-rose-50 text-rose-700 border-rose-200',
  UNPUBLISHED: 'bg-slate-100 text-slate-500 border-slate-200',
  PENDING: 'bg-amber-50 text-amber-700 border-amber-200',
}

const STATE_LABEL = { PUBLISHED: '已发布', FAILED: '失败', UNPUBLISHED: '未发布' }
const stateLabel = (value) => STATE_LABEL[value] || '未发布'

export default function PublishRecordBoard({ onGo }) {
  const [products, setProducts] = useState([])
  const [publish, setPublish] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      // 设置模块专用接口：只读发布状态，不需要商品/轮播的写权限
      const res = await api('/v2/online-catalog/publish-records')
      setProducts(res.products || [])
      setPublish(res.banner || null)
    } catch (err) {
      setError(err.message || '加载发布记录失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const summary = useMemo(() => {
    const counts = { PUBLISHED: 0, FAILED: 0, UNPUBLISHED: 0 }
    for (const product of products) {
      const key = product.publishState || 'UNPUBLISHED'
      counts[key] = (counts[key] || 0) + 1
    }
    return counts
  }, [products])

  const rows = useMemo(() => {
    const order = { FAILED: 0, UNPUBLISHED: 1, PUBLISHED: 2 }
    return [...products].sort((a, b) => {
      const diff = (order[a.publishState || 'UNPUBLISHED'] ?? 3) - (order[b.publishState || 'UNPUBLISHED'] ?? 3)
      if (diff !== 0) return diff
      return new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0)
    })
  }, [products])

  const bannerStatus = (() => {
    if (!publish) return { label: '加载中', cls: STATE_STYLE.UNPUBLISHED }
    if (publish.state === 'FAILED') return { label: '同步失败', cls: STATE_STYLE.FAILED }
    if (!publish.publishedAt) return { label: '尚未发布', cls: STATE_STYLE.UNPUBLISHED }
    if (publish.dirty) return { label: '有改动未同步', cls: STATE_STYLE.PENDING }
    return { label: '已同步', cls: STATE_STYLE.PUBLISHED }
  })()

  return (
    <div>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[11px] leading-relaxed text-slate-500">只读汇总：商品档案与首页轮播的最近一次发布结果。要重新发布请到对应页面操作。</p>
        <button type="button" onClick={load} className="inline-flex h-9 items-center justify-center gap-1 rounded-xl border border-slate-200 px-3 text-sm text-slate-600 hover:bg-slate-50 sm:h-8">
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

      {error ? <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700">{error}</div> : null}

      <div className="mb-3 grid grid-cols-3 gap-2.5 lg:gap-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-3 lg:p-4">
          <div className="text-[10px] text-slate-500 lg:text-[11px]">商品已发布</div>
          <div className="mt-1 text-lg font-semibold text-emerald-700 lg:text-2xl">{summary.PUBLISHED || 0}</div>
          <div className="mt-1 text-[10px] text-slate-400 lg:text-[11px]">共 {products.length} 个商品档案</div>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-3 lg:p-4">
          <div className="text-[10px] text-slate-500 lg:text-[11px]">发布失败</div>
          <div className={`mt-1 text-lg font-semibold lg:text-2xl ${summary.FAILED ? 'text-rose-600' : 'text-slate-800'}`}>{summary.FAILED || 0}</div>
          <div className="mt-1 text-[10px] text-slate-400 lg:text-[11px]">失败原因见下表</div>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-3 lg:p-4">
          <div className="text-[10px] text-slate-500 lg:text-[11px]">从未发布</div>
          <div className="mt-1 text-lg font-semibold text-slate-800 lg:text-2xl">{summary.UNPUBLISHED || 0}</div>
          <div className="mt-1 text-[10px] text-slate-400 lg:text-[11px]">尚未同步到小程序目录</div>
        </div>
      </div>

      <div className="mb-3 rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 text-sm font-semibold text-slate-700"><Send size={14} /> 首页轮播</span>
          <span className={`rounded-full border px-2 py-0.5 text-[11px] ${bannerStatus.cls}`}>{bannerStatus.label}</span>
          <span className="text-[11px] text-slate-400">线上版本 {publish?.version || 0} · {fmtTime(publish?.publishedAt)}</span>
          <button type="button" onClick={() => onGo && onGo('marketing', 'marketing-banner')} className="ml-auto text-xs text-budu-600">去轮播管理</button>
        </div>
        {publish?.lastError ? (
          <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-rose-50 px-3 py-2 text-[11px] text-rose-700">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />{publish.lastError}
          </div>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[760px]">
            <thead>
              <tr className="border-b border-slate-100 bg-[#FEFDFC] text-left text-[11px] text-slate-500">
                <th className="px-4 py-2.5 font-medium">商品</th>
                <th className="w-[100px] px-3 py-2.5 font-medium">状态</th>
                <th className="w-[150px] px-3 py-2.5 font-medium">最近发布</th>
                <th className="px-4 py-2.5 font-medium">说明</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={4}><div className="px-4 py-14 text-center text-xs text-slate-400">加载中…</div></td></tr>
              ) : !rows.length ? (
                <tr><td colSpan={4}><div className="px-4 py-14 text-center text-xs text-slate-400">还没有商品档案</div></td></tr>
              ) : rows.map((product) => (
                <tr key={product.mpId} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3">
                    <div className="text-sm font-medium text-slate-700">{product.title}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-slate-400">{product.mpId}</div>
                  </td>
                  <td className="px-3 py-3">
                    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] ${STATE_STYLE[product.publishState] || STATE_STYLE.UNPUBLISHED}`}>
                      {stateLabel(product.publishState)}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-[11px] text-slate-400">{fmtTime(product.publishedAt)}</td>
                  <td className="max-w-[360px] truncate px-4 py-3 text-[11px] text-slate-500" title={product.lastError || ''}>{product.lastError || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="divide-y divide-slate-100 md:hidden">
          {loading ? (
            <div className="px-4 py-14 text-center text-xs text-slate-400">加载中…</div>
          ) : !rows.length ? (
            <div className="px-4 py-14 text-center text-xs text-slate-400">还没有商品档案</div>
          ) : rows.map((product) => (
            <div key={product.mpId} className="px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700">{product.title}</span>
                <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${STATE_STYLE[product.publishState] || STATE_STYLE.UNPUBLISHED}`}>
                  {stateLabel(product.publishState)}
                </span>
              </div>
              <div className="mt-1 text-[11px] text-slate-400">{product.mpId} · {fmtTime(product.publishedAt)}</div>
              {product.lastError ? <div className="mt-1 text-[11px] text-rose-600">{product.lastError}</div> : null}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2.5 text-[11px] text-slate-400">
          <span>共 {products.length} 个商品</span>
          <span>失败优先展示</span>
        </div>
      </div>
    </div>
  )
}
