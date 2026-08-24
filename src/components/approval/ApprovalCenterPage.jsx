// 审批中心入口：视图路由（首页 / 发起表单 / 详情）
// 数据加载、权限、通知刷新逻辑与现有实现保持一致，仅呈现层改版
import { useEffect, useState } from 'react'
import { ArrowLeft, Inbox } from 'lucide-react'
import { api } from '../../utils/api'
import { t } from '../../utils/text'
import { refreshAlerts } from '../../utils/inventoryAlerts'
import ApprovalHome from './ApprovalHome'
import ApprovalFormView from './ApprovalFormView'
import ApprovalDetailView from './ApprovalDetailView'

const POLL_MS = 8000

export default function ApprovalCenterPage({ user, onBack }) {
  const allowed = Boolean(user && user.role !== 'public' && user.role !== 'cashier')

  const [view, setView] = useState('home') // home | form | detail
  const [formTemplate, setFormTemplate] = useState(null)
  const [editTarget, setEditTarget] = useState(null)
  const [detail, setDetail] = useState(null)
  const [templates, setTemplates] = useState([])
  // 铃铛通知跳转时按通知类型打开对应列表页（一次性）
  const [scope, setScope] = useState(() => {
    try {
      const s = sessionStorage.getItem('budu-approval-scope')
      sessionStorage.removeItem('budu-approval-scope')
      return s || 'launch'
    } catch {
      return 'launch'
    }
  })
  const [statusFilter, setStatusFilter] = useState('')
  const [rows, setRows] = useState(null)
  const [tick, setTick] = useState(0)

  const load = async () => {
    if (scope === 'launch') return
    try {
      const qs = `scope=${scope}${statusFilter ? `&status=${statusFilter}` : ''}`
      const res = await api(`/v2/approvals/requests?${qs}`)
      setRows(Array.isArray(res.rows) ? res.rows : [])
    } catch {
      setRows([])
    }
  }

  useEffect(() => {
    if (!allowed) return undefined
    api('/v2/approvals/templates')
      .then((res) => setTemplates(Array.isArray(res.rows) ? res.rows : []))
      .catch(() => {})
    load()
    const id = setInterval(() => setTick((v) => v + 1), POLL_MS)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, scope, statusFilter])

  useEffect(() => {
    if (allowed && tick > 0 && scope !== 'launch') load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick])

  const openDetail = async (id) => {
    try {
      const res = await api(`/v2/approvals/requests/${id}`)
      setDetail(res)
      setView('detail')
    } catch {
      /* 忽略 */
    }
  }

  const handleChanged = () => {
    refreshAlerts()
    setDetail(null)
    setView('home')
    load()
  }

  const handleEdit = (d) => {
    setDetail(null)
    setEditTarget(d)
    setFormTemplate({
      key: d.template.key,
      name: d.template.name,
      description: d.template.description,
      schema: d.template.schema,
      approverRule: d.template.approverRule,
      ccRule: d.template.ccRule,
    })
    setView('form')
  }

  const handleSaved = (request, submitted) => {
    setFormTemplate(null)
    setEditTarget(null)
    load()
    if (submitted) {
      refreshAlerts()
      if (request?.id) openDetail(request.id)
      else setView('home')
    } else {
      setView('home')
    }
  }

  if (!allowed) {
    return (
      <div className="card grid place-items-center py-20 text-center">
        <Inbox className="h-9 w-9 text-slate-200" />
        <p className="mt-3 text-sm font-semibold text-slate-400">{t('当前账号无权使用审批中心')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* 顶部（首页视图） */}
      {view === 'home' && (
        <div className="flex flex-wrap items-center gap-4">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 rounded-2xl bg-white px-3.5 py-2.5 text-sm font-medium text-slate-500 shadow-card transition hover:text-budu-600"
          >
            <ArrowLeft className="h-4 w-4" />
            {t('返回首页')}
          </button>
          <div>
            <h2 className="text-xl font-bold text-slate-800">{t('审批中心')}</h2>
          </div>
        </div>
      )}

      {view === 'home' && (
        <ApprovalHome
          user={user}
          templates={templates}
          scope={scope}
          onScope={(s) => {
            setScope(s)
            setRows(null)
          }}
          rows={rows}
          statusFilter={statusFilter}
          onStatusFilter={(v) => setStatusFilter(v)}
          onPickTemplate={(tpl) => {
            setFormTemplate(tpl)
            setEditTarget(null)
            setView('form')
          }}
          onOpenDetail={openDetail}
          onDeleted={() => {
            setRows(null)
            load()
          }}
        />
      )}

      {view === 'form' && formTemplate && (
        <ApprovalFormView
          template={formTemplate}
          initial={editTarget || undefined}
          user={user}
          onBack={() => {
            setFormTemplate(null)
            setEditTarget(null)
            setView('home')
          }}
          onSaved={handleSaved}
        />
      )}

      {view === 'detail' && detail && (
        <ApprovalDetailView
          detail={detail}
          user={user}
          onBack={() => {
            setDetail(null)
            setView('home')
          }}
          onChanged={handleChanged}
          onEdit={handleEdit}
        />
      )}
    </div>
  )
}
