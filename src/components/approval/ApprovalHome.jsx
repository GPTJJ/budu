// 审批中心 · 首页（模板分类网格 + 顶部 Tab + 列表）
import { useMemo, useState } from 'react'
import { ChevronRight, Search } from 'lucide-react'
import { CATEGORY_LABEL, StatusBadge, fmtShortTime, templateCategory, templateIcon, templateName, yuan } from './ApprovalShared'

const TABS = [
  { key: 'launch', label: '发起申请' },
  { key: 'todo', label: '待我审批' },
  { key: 'my', label: '我发起的' },
  { key: 'cc', label: '抄送我的' },
]

export default function ApprovalHome({ user, templates, scope, onScope, rows, statusFilter, onStatusFilter, onPickTemplate, onOpenDetail }) {
  const [q, setQ] = useState('')
  const isSuper = user?.role === 'developer' || user?.role === 'finance'
  const tabs = isSuper ? [...TABS, { key: 'all', label: '全部审批' }] : TABS

  // 模板分类分组
  const categories = useMemo(() => {
    const kw = q.trim().toLowerCase()
    const list = (templates || []).filter((t) => !kw || t.name.toLowerCase().includes(kw) || t.key.toLowerCase().includes(kw))
    const groups = new Map()
    for (const t of list) {
      const cat = templateCategory(t.key)
      if (!groups.has(cat)) groups.set(cat, [])
      groups.get(cat).push(t)
    }
    return [...groups.entries()]
  }, [templates, q])

  const countOf = (s) => (rows || []).filter((r) => s === 'all' || r.status === s).length

  return (
    <div>
      {/* 顶部 Tab */}
      <div className="sticky top-0 z-30 -mx-3 border-b border-slate-100 bg-canvas px-3 pt-1 sm:-mx-5 sm:px-5 lg:-mx-8 lg:px-8">
        <div className="mx-auto flex w-full max-w-[860px] gap-1 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => onScope(t.key)}
              className={`relative min-h-11 shrink-0 px-3.5 text-[15px] font-medium transition ${
                scope === t.key ? 'text-budu-600' : 'text-slate-400 active:text-slate-600'
              }`}
            >
              {t.label}
              {t.key === 'todo' && (rows || []).length > 0 && (
                <span className={`ml-1 rounded px-1.5 py-0.5 text-[10px] font-bold ${scope === t.key ? 'bg-budu-500 text-white' : 'bg-amber-100 text-amber-600'}`}>
                  {rows.length}
                </span>
              )}
              {scope === t.key && <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-budu-500" />}
            </button>
          ))}
        </div>
      </div>

      {scope === 'launch' ? (
        /* ============ 发起申请：模板分类网格 ============ */
        <div className="mx-auto w-full max-w-[860px]">
          {/* 搜索 */}
          <div className="px-4 pb-2 pt-4">
            <div className="flex items-center gap-2 rounded-xl bg-white px-3 py-2.5 shadow-sm">
              <Search className="h-4 w-4 shrink-0 text-slate-300" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索审批模板"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-300"
              />
            </div>
          </div>
          {/* 分类网格 */}
          {categories.length === 0 ? (
            <p className="px-4 py-16 text-center text-sm text-slate-300">未找到匹配的审批模板</p>
          ) : (
            categories.map(([cat, list]) => (
              <div key={cat} className="px-4 pt-4">
                <p className="pb-2 text-xs font-semibold text-slate-400">{CATEGORY_LABEL[cat] || cat}</p>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
                  {list.map((t) => {
                    const Icon = templateIcon(t.key)
                    const meta = { payroll: 'bg-emerald-50 text-emerald-600', expense: 'bg-amber-50 text-amber-600' }[t.key] || 'bg-budu-50 text-budu-600'
                    return (
                      <button
                        key={t.key}
                        onClick={() => onPickTemplate(t)}
                        className="flex min-h-[76px] items-center gap-3 rounded-xl bg-white p-3.5 text-left shadow-sm transition active:bg-slate-50"
                      >
                        <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg ${meta}`}>
                          <Icon className="h-5 w-5" />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-[15px] font-medium text-slate-800">{t.name}</span>
                          <span className="mt-0.5 block truncate text-xs text-slate-400">{t.description}</span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        /* ============ 列表 ============ */
        <div className="mx-auto w-full max-w-[860px]">
          {(rows || []).length > 0 && (
            <div className="flex items-center justify-end px-4 pb-1 pt-3">
              <select
                value={statusFilter}
                onChange={(e) => onStatusFilter(e.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-500 outline-none focus:border-budu-400"
              >
                <option value="">全部状态</option>
                {['draft', 'pending', 'approved', 'rejected', 'withdrawn', 'archived'].map((k) => (
                  <option key={k} value={k}>
                    {{ draft: '草稿', pending: '待审批', approved: '已通过', rejected: '已驳回', withdrawn: '已撤回', archived: '已归档' }[k]}
                    {countOf(k) > 0 ? `（${countOf(k)}）` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          {rows === null ? (
            <p className="px-4 py-16 text-center text-sm text-slate-300">加载中…</p>
          ) : rows.length === 0 ? (
            <div className="px-4 py-16 text-center">
              <p className="text-sm font-medium text-slate-400">
                {scope === 'todo' ? '暂无待我审批的申请' : scope === 'my' ? '你还没有发起过申请' : scope === 'cc' ? '暂无抄送我的记录' : '暂无审批记录'}
              </p>
              {scope === 'my' && <p className="mt-1 text-xs text-slate-300">切换到「发起申请」发起工资或报销审批</p>}
            </div>
          ) : (
            <div className="divide-y divide-slate-100 px-4">
              {rows.map((r) => (
                <button
                  key={r.id}
                  onClick={() => onOpenDetail(r.id)}
                  className="flex w-full items-center gap-3 py-3 text-left active:bg-slate-50"
                >
                  <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${r.templateKey === 'payroll' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
                    {(() => {
                      const Icon = templateIcon(r.templateKey)
                      return <Icon className="h-4.5 w-4.5" />
                    })()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[15px] font-medium text-slate-800">{r.title}</span>
                    </span>
                    <span className="mt-0.5 flex items-center gap-2 text-xs text-slate-400">
                      <span className="font-semibold text-budu-600">{yuan(r.amountCents)}</span>
                      {scope !== 'my' && <span>{r.submitterName || r.submitterUsername} ·</span>}
                      <span>{fmtShortTime(r.createdAt)}</span>
                    </span>
                  </span>
                  <StatusBadge status={r.status} />
                  <ChevronRight className="h-4 w-4 shrink-0 text-slate-200" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
