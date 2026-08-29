import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, RotateCcw, Trash2, X } from 'lucide-react'
import { api } from '../utils/api'
import { hasDeveloperSensitiveRecordDelete } from '../../shared/accountPermissions'

const reasonOptions = [
  ['test', '测试数据'],
  ['duplicate', '重复记录'],
  ['input_error', '录入错误'],
  ['other', '其他'],
]

function Overlay({ title, subtitle, children, actions, onClose }) {
  const [viewport, setViewport] = useState(() => ({
    height: window.visualViewport?.height || window.innerHeight,
    top: window.visualViewport?.offsetTop || 0,
  }))

  useEffect(() => {
    const scrollY = window.scrollY
    const previous = {
      bodyOverflow: document.body.style.overflow,
      bodyPosition: document.body.style.position,
      bodyTop: document.body.style.top,
      bodyWidth: document.body.style.width,
      htmlOverflow: document.documentElement.style.overflow,
    }
    const updateViewport = () =>
      setViewport({
        height: window.visualViewport?.height || window.innerHeight,
        top: window.visualViewport?.offsetTop || 0,
      })
    document.documentElement.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'
    document.body.style.position = 'fixed'
    document.body.style.top = `-${scrollY}px`
    document.body.style.width = '100%'
    window.visualViewport?.addEventListener('resize', updateViewport)
    window.visualViewport?.addEventListener('scroll', updateViewport)
    window.addEventListener('resize', updateViewport)
    return () => {
      window.visualViewport?.removeEventListener('resize', updateViewport)
      window.visualViewport?.removeEventListener('scroll', updateViewport)
      window.removeEventListener('resize', updateViewport)
      document.documentElement.style.overflow = previous.htmlOverflow
      document.body.style.overflow = previous.bodyOverflow
      document.body.style.position = previous.bodyPosition
      document.body.style.top = previous.bodyTop
      document.body.style.width = previous.bodyWidth
      window.scrollTo(0, scrollY)
    }
  }, [])

  return createPortal(
    <div data-testid="developer-safe-delete-overlay" className="fixed inset-x-0 z-[220] flex items-end justify-center overflow-hidden bg-slate-950/55 overscroll-none backdrop-blur-sm sm:items-center sm:p-4" style={{ top: `${viewport.top}px`, height: `${viewport.height}px` }} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="developer-safe-delete-title"
        data-testid="developer-safe-delete-sheet"
        className="relative flex w-full flex-col overflow-hidden rounded-t-[28px] bg-white shadow-2xl sm:max-w-lg sm:rounded-[28px]"
        style={{
          maxHeight: `calc(${viewport.height}px - max(0.5rem, env(safe-area-inset-top)))`,
        }}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-slate-100 bg-white px-5 py-4">
          <div className="min-w-0">
            <h3 id="developer-safe-delete-title" className="font-black text-slate-900">
              {title}
            </h3>
            <p className="mt-0.5 truncate text-xs text-slate-400">{subtitle}</p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose} className="ml-3 grid h-10 w-10 shrink-0 place-items-center rounded-full bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div data-testid="developer-safe-delete-scroll" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 [touch-action:pan-y]">
          {children}
        </div>
        <footer data-testid="developer-safe-delete-actions" className="grid shrink-0 grid-cols-2 gap-3 border-t border-slate-100 bg-white/95 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur sm:px-5">
          {actions}
        </footer>
      </section>
    </div>,
    document.body,
  )
}

export function DeveloperSafeDeleteButton({ user, type, record, onDeleted, className = '' }) {
  const [open, setOpen] = useState(false)
  const [reasonCode, setReasonCode] = useState('')
  const [reasonText, setReasonText] = useState('')
  const [secondPassword, setSecondPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!hasDeveloperSensitiveRecordDelete(user)) return null
  const highRisk = ['shipped', 'done', 'received'].includes(record?.status) || Number(record?.receivedAmountCents || 0) > 0
  const submit = async () => {
    if (!reasonCode || (reasonCode === 'other' && !reasonText.trim()) || !secondPassword) return setError('请完整填写删除原因和二级密码')
    setBusy(true)
    setError('')
    try {
      await api(`/v2/developer-sensitive-records/${type}/${record.id}/delete`, {
        method: 'POST',
        body: JSON.stringify({ reasonCode, reasonText, secondPassword }),
      })
      setOpen(false)
      setSecondPassword('')
      await onDeleted?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={`inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl bg-rose-50 px-3 text-xs font-bold text-rose-600 ${className}`}>
        <Trash2 className="h-4 w-4" />
        安全删除
      </button>
      {open && (
        <Overlay
          title="开发者安全删除"
          subtitle={`记录 ID：${record.id}`}
          onClose={() => !busy && setOpen(false)}
          actions={
            <>
              <button type="button" disabled={busy} onClick={() => setOpen(false)} className="min-h-12 rounded-xl bg-slate-100 text-sm font-bold text-slate-600 disabled:opacity-40">
                取消
              </button>
              <button type="button" disabled={busy || !reasonCode || !secondPassword} onClick={submit} className="min-h-12 rounded-xl bg-rose-600 px-3 text-sm font-black text-white disabled:opacity-40">
                {busy ? '验证并删除中…' : '确认删除'}
              </button>
            </>
          }
        >
          <div className="space-y-4">
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="font-bold text-slate-800">{record.title || record.orderNo || record.companyName || record.recipient || record.id}</p>
              <p className="mt-1 text-xs text-slate-500">{record.subtitle || `状态：${record.status || '—'}`}</p>
            </div>
            <div className={`rounded-2xl p-4 text-sm ${highRisk ? 'bg-rose-100 text-rose-800' : 'bg-amber-50 text-amber-800'}`}>
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                <p>
                  <strong>{highRisk ? '高风险业务记录' : '敏感操作'}</strong>
                  <br />
                  删除后将从正常列表、统计、导出和后续操作中隐藏，但原记录及子记录不会被物理删除，可在开发者工具中恢复。
                </p>
              </div>
            </div>
            <fieldset>
              <legend className="mb-2 text-xs font-bold text-slate-500">删除原因</legend>
              <div className="grid grid-cols-2 gap-2">
                {reasonOptions.map(([value, label]) => (
                  <label key={value} className={`rounded-xl border p-3 text-sm font-bold ${reasonCode === value ? 'border-rose-400 bg-rose-50 text-rose-700' : 'border-slate-200 text-slate-600'}`}>
                    <input type="radio" className="sr-only" name={`delete-reason-${record.id}`} value={value} checked={reasonCode === value} onChange={() => setReasonCode(value)} />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
            {reasonCode === 'other' && (
              <label className="block text-xs font-bold text-slate-500">
                其他原因
                <textarea aria-label="其他删除原因" className="input mt-1 min-h-20 w-full resize-y" maxLength={200} value={reasonText} onChange={(e) => setReasonText(e.target.value)} />
              </label>
            )}
            <label className="block text-xs font-bold text-slate-500">
              二级密码
              <input
                aria-label="安全删除二级密码"
                type="password"
                autoComplete="off"
                className="input mt-1 w-full"
                value={secondPassword}
                onChange={(e) => setSecondPassword(e.target.value)}
                onFocus={(event) =>
                  window.setTimeout(
                    () =>
                      event.currentTarget.scrollIntoView({
                        block: 'center',
                        behavior: 'smooth',
                      }),
                    120,
                  )
                }
              />
            </label>
            {error && <p className="text-sm font-bold text-rose-600">{error}</p>}
          </div>
        </Overlay>
      )}
    </>
  )
}

export function DeletedRecordsCenter({ user }) {
  const [rows, setRows] = useState([])
  const [filters, setFilters] = useState({
    type: '',
    start: '',
    end: '',
    deletedBy: '',
    reason: '',
  })
  const [detail, setDetail] = useState(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = async () => {
    const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString()
    try {
      const result = await api(`/v2/developer-sensitive-records?${query}`)
      setRows(result.rows || [])
    } catch (err) {
      setError(err.message)
    }
  }
  useEffect(() => {
    if (hasDeveloperSensitiveRecordDelete(user)) load()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  if (!hasDeveloperSensitiveRecordDelete(user)) return null
  const restore = async () => {
    if (!password) return setError('请输入二级密码')
    setBusy(true)
    setError('')
    try {
      await api(`/v2/developer-sensitive-records/${detail.type}/${detail.id}/restore`, { method: 'POST', body: JSON.stringify({ secondPassword: password }) })
      setDetail(null)
      setPassword('')
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="card p-4 sm:p-6" data-testid="deleted-records-center">
      <div className="flex items-center gap-3">
        <div className="grid h-11 w-11 place-items-center rounded-2xl bg-rose-600 text-white">
          <Trash2 className="h-5 w-5" />
        </div>
        <div>
          <h3 className="font-bold text-slate-800">开发者工具 · 已删除记录</h3>
          <p className="text-xs text-slate-400">仅开发者可查看、审计及恢复</p>
        </div>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-5">
        <select aria-label="记录类型" className="input" value={filters.type} onChange={(e) => setFilters((s) => ({ ...s, type: e.target.value }))}>
          <option value="">全部类型</option>
          <option value="mailing">门店邮寄</option>
          <option value="invoice">开发票</option>
          <option value="transfer">库存调拨</option>
          <option value="purchase">采购申请</option>
          <option value="partnerSupply">合作商供货</option>
        </select>
        <input aria-label="删除开始日期" type="date" className="input" value={filters.start} onChange={(e) => setFilters((s) => ({ ...s, start: e.target.value }))} />
        <input aria-label="删除结束日期" type="date" className="input" value={filters.end} onChange={(e) => setFilters((s) => ({ ...s, end: e.target.value }))} />
        <input aria-label="删除人筛选" className="input" placeholder="删除人 User.id" value={filters.deletedBy} onChange={(e) => setFilters((s) => ({ ...s, deletedBy: e.target.value }))} />
        <input aria-label="删除原因筛选" className="input" placeholder="原因关键词" value={filters.reason} onChange={(e) => setFilters((s) => ({ ...s, reason: e.target.value }))} />
      </div>
      <button type="button" onClick={load} className="mt-2 min-h-10 rounded-xl bg-slate-800 px-4 text-xs font-bold text-white">
        筛选
      </button>
      {error && <p className="mt-3 text-sm font-bold text-rose-600">{error}</p>}
      <div className="mt-4 space-y-2">
        {rows.map((row) => (
          <button
            type="button"
            key={`${row.type}-${row.id}`}
            onClick={async () => {
              try {
                const result = await api(`/v2/developer-sensitive-records/${row.type}/${row.id}`)
                setDetail(result)
              } catch (err) {
                setError(err.message)
              }
            }}
            className="flex w-full items-start justify-between gap-3 rounded-2xl bg-slate-50 p-3 text-left"
          >
            <span className="min-w-0">
              <strong className="block truncate text-sm text-slate-800">
                {row.typeLabel} · {row.title}
              </strong>
              <span className="mt-1 block text-xs text-slate-500">
                {row.deleteReason} · {new Date(row.deletedAt).toLocaleString('zh-CN')}
              </span>
            </span>
            <span className="shrink-0 text-xs font-bold text-budu-600">详情</span>
          </button>
        ))}
        {!rows.length && <p className="py-6 text-center text-sm text-slate-400">暂无已删除记录</p>}
      </div>
      {detail && (
        <Overlay
          title="已删除记录详情"
          subtitle={`${detail.record.typeLabel} · ${detail.record.id}`}
          onClose={() => !busy && setDetail(null)}
          actions={
            <>
              <button type="button" disabled={busy} onClick={() => setDetail(null)} className="min-h-12 rounded-xl bg-slate-100 text-sm font-bold text-slate-600 disabled:opacity-40">
                取消
              </button>
              <button type="button" onClick={restore} disabled={busy || !password} className="btn-primary min-h-12">
                <RotateCcw className="h-4 w-4" />
                {busy ? '恢复中…' : '恢复原记录'}
              </button>
            </>
          }
        >
          <div className="space-y-4">
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="font-bold">{detail.record.title}</p>
              <p className="mt-2 text-xs text-slate-500">{detail.record.subtitle}</p>
              <p className="mt-2 text-xs text-rose-600">{detail.record.deleteReason}</p>
            </div>
            <div className="rounded-2xl border p-3 text-xs text-slate-500">
              {detail.audits.map((audit) => (
                <p key={audit.id}>
                  {audit.action === 'DELETE' ? '删除' : '恢复'} · {audit.actorUsername} · {new Date(audit.createdAt).toLocaleString('zh-CN')}
                </p>
              ))}
            </div>
            <label className="block text-xs font-bold text-slate-500">
              二级密码
              <input
                aria-label="恢复二级密码"
                type="password"
                autoComplete="off"
                className="input mt-1 w-full"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onFocus={(event) =>
                  window.setTimeout(
                    () =>
                      event.currentTarget.scrollIntoView({
                        block: 'center',
                        behavior: 'smooth',
                      }),
                    120,
                  )
                }
              />
            </label>
          </div>
        </Overlay>
      )}
    </div>
  )
}
