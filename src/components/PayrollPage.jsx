// 工资条板块（人员管理 → 工资条）：
// 记录查询（全部/待签收/已签收筛选 + 角标）、推送状态、查看每日明细、签收留痕、
// 开发者发放工资条；铃铛仅负责提醒（点击提醒跳转本板块）
import { useEffect, useState } from 'react'
import { ArrowLeft, BadgeDollarSign, CheckCircle2, Clock, Inbox } from 'lucide-react'
import { api } from '../utils/api'
import { t } from '../utils/text'
import { periodLabel } from '../utils/payrollSlip'
import { refreshAlerts } from '../utils/inventoryAlerts'
import PayrollSlipModal from './PayrollSlipModal'
import PayrollIssueModal from './PayrollIssueModal'

// 分 → 元（totalCents 以分存储，显示需 ÷100）
const yuan = (cents) => `¥${(Number(cents || 0) / 100).toFixed(2)}`

const POLL_MS = 8000

export default function PayrollPage({ user, onBack }) {
  const isDev = user?.role === 'developer' || user?.role === 'finance' || user?.role === 'admin' // 财务/管理员权限与开发者一致
  const allowed = Boolean(user && user.role !== 'public' && user.role !== 'cashier')
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('all') // all | pending | confirmed
  const [detail, setDetail] = useState(null)
  const [showIssue, setShowIssue] = useState(false)

  const load = () => {
    api('/v2/payroll-notices')
      .then((res) => {
        setRows(Array.isArray(res.rows) ? res.rows : [])
        // 详情打开期间状态变化时同步（如开发者代签）
        setDetail((d) => (d ? (Array.isArray(res.rows) ? res.rows.find((r) => r.id === d.id) || d : d) : d))
      })
      .catch((e) => setError(e.message))
  }

  // 挂载加载 + 与全局 8 秒数据同步保持一致
  useEffect(() => {
    if (!allowed) return undefined
    load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed])

  const countOf = (v) => (rows || []).filter((r) => v === 'all' || r.status === v).length
  const filtered = (rows || []).filter((r) => filter === 'all' || r.status === filter)

  /** 签收完成：刷新记录列表 + 即时归档铃铛未签收通知 */
  const handleConfirmed = () => {
    setDetail(null)
    load()
    refreshAlerts()
  }

  /** 发放完成：刷新记录列表 + 同步铃铛 */
  const handleIssued = () => {
    setShowIssue(false)
    load()
    refreshAlerts()
  }

  if (!allowed) {
    return (
      <div className="card grid place-items-center py-20 text-center">
        <Inbox className="h-9 w-9 text-slate-200" />
        <p className="mt-3 text-sm font-semibold text-slate-400">{t('当前账号无权查看工资条')}</p>
        <p className="mt-1.5 text-xs text-slate-300">{t('工资条仅对已授权账号开放')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
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
          <h2 className="text-xl font-bold text-slate-800">{t('工资条')}</h2>
          <p className="mt-0.5 text-[13px] text-slate-400">
            {isDev ? t('全部员工工资条（按发放时间倒序）') : t('本人工资条记录 · 点击查看每日明细')}
          </p>
        </div>
        {isDev && (
          <button
            onClick={() => setShowIssue(true)}
            className="ml-auto flex items-center gap-1.5 rounded-2xl bg-budu-500 px-4 py-2.5 text-[13px] font-semibold text-white shadow-sm transition hover:opacity-90"
          >
            <BadgeDollarSign className="h-4 w-4" />
            {t('发放工资条')}
          </button>
        )}
      </div>

      {/* 推送状态提示 */}
      <div className="rounded-2xl border border-budu-100 bg-budu-50/50 px-4 py-3 text-xs font-medium text-budu-700">
        {t('待签收的工资条会持续在右上角铃铛提醒，确认签收后自动归档')}
      </div>

      {error && <p className="rounded-xl bg-rose-50 px-4 py-2.5 text-sm text-rose-600">{error}</p>}

      {/* 状态筛选（带独立角标计数） */}
      <div className="inline-flex w-fit rounded-xl bg-white p-1 shadow-card">
        {[
          ['all', t('全部')],
          ['pending', t('待签收')],
          ['confirmed', t('已签收')],
        ].map(([v, label]) => (
          <button
            key={v}
            onClick={() => setFilter(v)}
            className={`rounded-lg px-4 py-1.5 text-[13px] font-semibold transition ${
              filter === v ? 'bg-budu-500 text-white shadow-sm' : 'text-slate-500 hover:bg-budu-50 hover:text-budu-600'
            }`}
          >
            {label}
            {(rows || []).length > 0 && v !== 'all' && countOf(v) > 0 && (
              <span
                className={`ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-bold ${
                  filter === v
                    ? 'bg-white/25 text-white'
                    : v === 'pending'
                      ? 'bg-amber-100 text-amber-600'
                      : 'bg-emerald-100 text-emerald-600'
                }`}
              >
                {countOf(v)}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* 记录列表 */}
      <div className="card overflow-hidden p-0">
        {rows === null ? (
          <p className="grid place-items-center py-16 text-xs text-slate-300">{t('加载中…')}</p>
        ) : filtered.length === 0 ? (
          <div className="grid place-items-center py-16 text-center">
            <Inbox className="h-9 w-9 text-slate-200" />
            <p className="mt-3 text-sm font-semibold text-slate-400">
              {(rows || []).length === 0
                ? isDev
                  ? t('尚未发放过工资条')
                  : t('暂无工资条记录')
                : t('该状态下暂无记录')}
            </p>
            {isDev && (rows || []).length === 0 && (
              <p className="mt-1.5 text-xs text-slate-300">{t('点击右上角「发放工资条」按周期发放')}</p>
            )}
          </div>
        ) : (
          <div className="divide-y divide-slate-50">
            {filtered.map((r) => (
              <button
                key={r.id}
                onClick={() => setDetail(r)}
                className="block w-full px-4 py-3.5 text-left transition hover:bg-budu-50/50"
              >
                <p className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-slate-700">
                  <span>{isDev ? `${r.employeeName} · ` : ''}{periodLabel(r.periodType, r.periodKey)}</span>
                  <span
                    className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                      r.status === 'confirmed' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'
                    }`}
                  >
                    {r.status === 'confirmed' ? t('已签收') : t('待签收')}
                  </span>
                  {isDev && <span className="text-[11px] font-normal text-slate-400">{r.storeKey}</span>}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  <span className="font-bold text-budu-600">{yuan(r.totalCents)}</span>
                  {r.status === 'confirmed' ? (
                    <span className="ml-2 text-[11px] text-slate-400">
                      <CheckCircle2 className="mr-0.5 inline h-3 w-3 text-emerald-500" />
                      {r.confirmedBy} {t('于')} {r.confirmedAt ? new Date(r.confirmedAt).toLocaleString('zh-CN', { hour12: false }) : ''} {t('签收')}
                    </span>
                  ) : (
                    <span className="ml-2 text-[11px] text-slate-400">
                      <Clock className="mr-0.5 inline h-3 w-3 text-amber-500" />
                      {t('待本人签收')}
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-[10px] text-slate-300">
                  {t('发放于')} {new Date(r.createdAt).toLocaleString('zh-CN', { hour12: false })}
                  {r.createdBy ? ` · ${t('由 {name} 发放', { name: r.createdBy })}` : ''}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 明细 + 签收弹窗 */}
      {detail && (
        <PayrollSlipModal notice={detail} onClose={() => setDetail(null)} onConfirmed={handleConfirmed} />
      )}

      {/* 发放弹窗（开发者） */}
      {showIssue && <PayrollIssueModal onClose={() => setShowIssue(false)} onIssued={handleIssued} />}
    </div>
  )
}
