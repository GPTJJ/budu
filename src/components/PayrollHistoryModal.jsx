// 工资条记录：查询本人（员工/店长）或全量（开发者）的历史工资条，点击查看明细
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { BadgeDollarSign, CheckCircle2, Clock, X } from 'lucide-react'
import { api } from '../utils/api'
import { periodLabel } from '../utils/payrollSlip'
import PayrollSlipModal from './PayrollSlipModal'

const yuan = (cents) => `¥${Number(cents || 0).toFixed(2)}`

export default function PayrollHistoryModal({ user, onClose }) {
  const isDev = user?.role === 'developer'
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('all') // all | pending | confirmed
  const [detail, setDetail] = useState(null)

  useEffect(() => {
    api('/v2/payroll-notices')
      .then((res) => setRows(Array.isArray(res.rows) ? res.rows : []))
      .catch((e) => setError(e.message))
  }, [])

  const filtered = (rows || []).filter((r) => filter === 'all' || r.status === filter)

  const refresh = () => {
    api('/v2/payroll-notices')
      .then((res) => {
        const list = Array.isArray(res.rows) ? res.rows : []
        setRows(list)
        // 详情已签收时同步状态
        setDetail((d) => (d ? list.find((r) => r.id === d.id) || d : d))
      })
      .catch(() => {})
  }

  return createPortal(
    <div className="fixed inset-0 z-[96] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white p-6 shadow-lg">
        <div className="flex flex-wrap items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-2xl bg-budu-50 text-budu-600">
            <BadgeDollarSign className="h-6 w-6" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-slate-800">工资条记录</h3>
            <p className="mt-0.5 text-xs text-slate-400">
              {isDev ? '全部员工工资条（按发放时间倒序）' : '本人工资条记录 · 点击查看每日明细'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="ml-auto grid h-9 w-9 place-items-center rounded-xl bg-slate-50 text-slate-400 transition hover:bg-slate-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && <p className="mt-3 rounded-xl bg-rose-50 px-4 py-2.5 text-sm text-rose-600">{error}</p>}

        {/* 状态筛选 */}
        <div className="mt-4 inline-flex w-fit rounded-xl bg-slate-100 p-1">
          {[
            ['all', '全部'],
            ['pending', '待签收'],
            ['confirmed', '已签收'],
          ].map(([v, label]) => (
            <button
              key={v}
              onClick={() => setFilter(v)}
              className={`rounded-lg px-4 py-1.5 text-[13px] font-semibold transition ${
                filter === v ? 'bg-white text-budu-600 shadow-sm' : 'text-slate-500'
              }`}
            >
              {label}
              {v === 'pending' && filtered.length > 0 && (
                <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] font-bold text-amber-600">{filtered.length}</span>
              )}
            </button>
          ))}
        </div>

        {/* 记录列表 */}
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-xl border border-slate-100">
          {rows === null ? (
            <p className="grid place-items-center py-14 text-xs text-slate-300">加载中…</p>
          ) : filtered.length === 0 ? (
            <p className="grid place-items-center py-14 text-xs text-slate-300">
              {rows.length === 0 ? (isDev ? '尚未发放过工资条' : '暂无工资条记录') : '该状态下暂无记录'}
            </p>
          ) : (
            filtered.map((r) => (
              <button
                key={r.id}
                onClick={() => setDetail(r)}
                className="block w-full border-b border-slate-50 px-4 py-3 text-left transition hover:bg-budu-50/50"
              >
                <p className="flex items-center gap-2 text-[13px] font-semibold text-slate-700">
                  <span>{isDev ? `${r.employeeName} · ` : ''}{periodLabel(r.periodType, r.periodKey)}</span>
                  <span
                    className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                      r.status === 'confirmed' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'
                    }`}
                  >
                    {r.status === 'confirmed' ? '已签收' : '待签收'}
                  </span>
                  {isDev && <span className="text-[11px] font-normal text-slate-400">{r.storeKey}</span>}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  <span className="font-bold text-budu-600">{yuan(r.totalCents)}</span>
                  {r.status === 'confirmed' ? (
                    <span className="ml-2 text-[11px] text-slate-400">
                      <CheckCircle2 className="mr-0.5 inline h-3 w-3 text-emerald-500" />
                      {r.confirmedBy} 于 {r.confirmedAt ? new Date(r.confirmedAt).toLocaleString('zh-CN', { hour12: false }) : ''} 签收
                    </span>
                  ) : (
                    <span className="ml-2 text-[11px] text-slate-400">
                      <Clock className="mr-0.5 inline h-3 w-3 text-amber-500" />
                      待本人签收
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-[10px] text-slate-300">
                  发放于 {new Date(r.createdAt).toLocaleString('zh-CN', { hour12: false })}
                  {r.createdBy ? ` · 由 ${r.createdBy} 发放` : ''}
                </p>
              </button>
            ))
          )}
        </div>
      </div>

      {detail && (
        <PayrollSlipModal
          notice={detail}
          onClose={() => setDetail(null)}
          onConfirmed={() => {
            setDetail(null)
            refresh()
          }}
        />
      )}
    </div>,
    document.body,
  )
}
