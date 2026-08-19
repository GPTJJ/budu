// 审批中心 · 审批详情页（企业微信风格：信息行 + Timeline + 底部操作栏）
// 业务逻辑与接口完全复用现有实现；仅呈现层改版
import { useState } from 'react'
import { ArrowLeft, Check, CheckCircle2, ClipboardCheck, Download, RotateCcw, Send, Trash2, XCircle } from 'lucide-react'
import { api } from '../../utils/api'
import { storeName } from '../../utils/selectors'
import { ExcelPreview, PdfPreview, StatusBadge, fileIcon, fmtShortTime, templateName, yuan } from './ApprovalShared'

const ACTION_LABEL = {
  create: '创建草稿',
  submit: '提交申请',
  edit: '编辑单据',
  approve: '审批通过',
  reject: '审批驳回',
  withdraw: '撤回申请',
  archive: '归档单据',
}

/** Timeline：提交申请 → 审批 → 抄送（数据来自现有 logs/nodes/ccs） */
function Timeline({ detail }) {
  const { request, nodes, ccs, logs } = detail
  const submitLog = [...(logs || [])].reverse().find((l) => l.action === 'submit')
  const createLog = [...(logs || [])].reverse().find((l) => l.action === 'create')
  // 驳回重提后存在多个节点：优先待审批节点；否则取 actedAt 最新的审批结果
  const pendingNode = (nodes || []).find((n) => n.status === 'pending')
  const node =
    pendingNode ||
    [...(nodes || [])].sort((a, b) => String(b.actedAt || '').localeCompare(String(a.actedAt || '')))[0]
  const ccUsers = ccs || []
  const submittedAt = submitLog?.createdAt || createLog?.createdAt || request.createdAt

  const dot = (done, cls = 'bg-emerald-500') => (
    <span className={`mt-1.5 grid h-4 w-4 shrink-0 place-items-center rounded-full ${done ? cls : 'border-2 border-slate-200 bg-white'}`}>
      {done && <Check className="h-2.5 w-2.5 text-white" />}
    </span>
  )
  const line = () => <span className="ml-[7px] h-4 w-0.5 shrink-0 bg-slate-200" />

  return (
    <div>
      <p className="px-4 pb-1 pt-5 text-xs font-semibold text-slate-400">审批进度</p>
      <div className="flex flex-col border-b border-slate-100 px-4 py-3">
        {/* 提交申请 */}
        <div className="flex items-start gap-3">
          {dot(true)}
          <div className="min-w-0 flex-1 pb-1">
            <p className="text-[15px] font-medium text-slate-800">提交申请</p>
            <p className="text-xs text-slate-400">{request.submitterName || request.submitterUsername} · {fmtShortTime(submittedAt)}</p>
          </div>
        </div>
        {line()}
        {/* 审批节点 */}
        <div className="flex items-start gap-3">
          {node ? (
            dot(node.status !== 'pending', node.status === 'rejected' ? 'bg-rose-500' : 'bg-emerald-500')
          ) : (
            dot(false)
          )}
          <div className="min-w-0 flex-1 pb-1">
            <p className="text-[15px] font-medium text-slate-800">
              {node ? '管理员审批' : '审批'}
            </p>
            <p className="text-xs text-slate-400">
              {node?.approverUsername || '管理员'}
              {node ? ` · ${node.status === 'pending' ? '待处理' : node.status === 'approved' ? '已通过' : '已驳回'}` : '待处理'}
              {node?.actedAt ? ` · ${fmtShortTime(node.actedAt)}` : ''}
            </p>
            {node?.comment && <p className="mt-1 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600">{node.comment}</p>}
          </div>
        </div>
        {line()}
        {/* 抄送 */}
        <div className="flex items-start gap-3">
          {dot(ccUsers.length > 0)}
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-medium text-slate-800">抄送</p>
            <p className="text-xs text-slate-400">
              {ccUsers.length > 0
                ? ccUsers.map((c) => c.ccName || c.ccUsername).join('、') + (request.status === 'approved' ? ' · 已抄送' : '')
                : request.status === 'approved' ? '审批通过后自动抄送' : '审批通过后自动抄送'}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ApprovalDetailView({ detail, user, onBack, onChanged, onEdit }) {
  const { request, template, nodes, ccs, attachments, comments, logs } = detail
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const isSuper = user?.role === 'developer' || user?.role === 'finance' || user?.role === 'admin'
  const isSubmitter = user?.username === request.submitterUsername
  const canDecide = isSuper && request.status === 'pending'
  const schema = template.schema || []

  const act = async (action) => {
    setBusy(action)
    setError('')
    try {
      if (action === 'approve' || action === 'reject') {
        if (action === 'reject' && comment.trim().length < 2) {
          setError('驳回时必须填写审批意见')
          return
        }
        await api(`/v2/approvals/requests/${request.id}/decide`, {
          method: 'POST',
          body: JSON.stringify({ action, comment: comment.trim() }),
        })
      } else if (action === 'submit') {
        await api(`/v2/approvals/requests/${request.id}/submit`, { method: 'POST' })
      } else if (action === 'withdraw') {
        await api(`/v2/approvals/requests/${request.id}/withdraw`, { method: 'POST' })
      } else if (action === 'archive') {
        await api(`/v2/approvals/requests/${request.id}/archive`, { method: 'POST' })
      } else if (action === 'delete') {
        await api(`/v2/approvals/requests/${request.id}`, { method: 'DELETE' })
      }
      onChanged?.(action)
    } catch (e) {
      setError(e.message || '操作失败')
    } finally {
      setBusy('')
    }
  }

  const fmtValue = (field, value) => {
    if (value === '' || value === null || value === undefined) return '—'
    if (field.type === 'money') return yuan(value)
    if (field.type === 'employee') {
      const [sk, name] = String(value).split('::')
      return `${name || value}（${storeName(sk) || sk}）`
    }
    if (field.type === 'store') return storeName(value) || value
    return String(value)
  }

  const download = (a) => {
    try {
      const link = document.createElement('a')
      link.href = a.dataUrl
      link.download = a.name
      document.body.appendChild(link)
      link.click()
      link.remove()
    } catch {
      /* 忽略 */
    }
  }

  const showBottomBar = canDecide || isSubmitter || (isSuper && (request.status === 'approved' || request.status === 'rejected'))

  return (
    <div className="pb-28">
      {/* 顶部导航 */}
      <div className="mx-auto flex w-full max-w-[860px] items-center gap-2 px-2 py-2">
        <button onClick={onBack} className="grid h-10 w-10 place-items-center rounded-xl text-slate-500 active:bg-slate-100" aria-label="返回">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h2 className="text-[17px] font-semibold text-slate-800">{templateName(template.key)}</h2>
        <span className="ml-1"><StatusBadge status={request.status} /></span>
        <span className="ml-auto pr-1 text-xs text-slate-300">{request.requestNo}</span>
      </div>

      {error && (
        <p className="mx-auto mt-1 max-w-[860px] px-4 py-2.5 text-sm font-medium text-rose-600">{error}</p>
      )}

      {/* 内容主体 */}
      <div className="mx-auto w-full max-w-[860px] bg-white">
        {/* 基本信息 */}
        <div className="border-b border-slate-100">
          <div className="flex min-h-[44px] items-center gap-3 px-4 py-2">
            <span className="w-[110px] shrink-0 text-[15px] text-slate-400">申请人</span>
            <span className="text-[15px] text-slate-800">{request.submitterName || request.submitterUsername}</span>
          </div>
          <div className="flex min-h-[44px] items-center gap-3 px-4 py-2">
            <span className="w-[110px] shrink-0 text-[15px] text-slate-400">提交时间</span>
            <span className="text-[15px] text-slate-800">{fmtShortTime(request.createdAt)}</span>
          </div>
          <div className="flex min-h-[44px] items-center gap-3 px-4 py-2">
            <span className="w-[110px] shrink-0 text-[15px] text-slate-400">标题</span>
            <span className="min-w-0 flex-1 break-words text-[15px] text-slate-800">{request.title}</span>
          </div>
          <div className="flex min-h-[44px] items-center gap-3 px-4 py-2">
            <span className="w-[110px] shrink-0 text-[15px] text-slate-400">金额</span>
            <span className="text-[15px] font-semibold tabular-nums text-budu-600">{yuan(request.amountCents)}</span>
          </div>
        </div>

        {/* 表单字段 */}
        {schema.map((f) => (
          <div key={f.key} className="flex min-h-[44px] items-start gap-3 border-b border-slate-100 px-4 py-2">
            <span className="w-[110px] shrink-0 pt-1 text-[15px] text-slate-400">{f.label}</span>
            <span className="min-w-0 flex-1 break-words text-[15px] text-slate-800">{fmtValue(f, request.formData?.[f.key])}</span>
          </div>
        ))}

        {/* 附件 */}
        {attachments.length > 0 && (
          <div className="border-b border-slate-100 px-4 py-3">
            <p className="pb-2 text-xs font-semibold text-slate-400">附件（{attachments.length}）</p>
            <div className="space-y-2">
              {attachments.map((a) => (
                <div key={a.id} className="rounded-lg border border-slate-100 p-2.5">
                  <div className="flex items-center gap-2">
                    {a.fileType.startsWith('image/') && a.dataUrl ? (
                      <img src={a.dataUrl} alt="" className="h-5 w-5 rounded object-cover" />
                    ) : (
                      fileIcon(a.fileType)
                    )}
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-600">{a.name}</span>
                    <button onClick={() => download(a)} className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-budu-500 active:bg-budu-50" aria-label="下载附件">
                      <Download className="h-3.5 w-3.5" />下载
                    </button>
                  </div>
                  <div className="mt-2">
                    {a.fileType.startsWith('image/') ? (
                      <img src={a.dataUrl} alt={a.name} className="max-h-72 rounded-lg border border-slate-100 object-contain" />
                    ) : a.fileType === 'application/pdf' ? (
                      <PdfPreview dataUrl={a.dataUrl} />
                    ) : (
                      <ExcelPreview dataUrl={a.dataUrl} />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Timeline */}
        <Timeline detail={detail} />

        {/* 审批意见 */}
        {comments.length > 0 && (
          <div className="border-b border-slate-100 px-4 py-3">
            <p className="pb-2 text-xs font-semibold text-slate-400">审批意见</p>
            <div className="space-y-1.5">
              {comments.map((c) => (
                <div key={c.id} className="rounded-lg border border-slate-100 px-3 py-2 text-sm">
                  <p className="text-slate-700">{c.content}</p>
                  <p className="mt-0.5 text-[11px] text-slate-400">{c.username} · {fmtShortTime(c.createdAt)}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 操作记录 */}
        {logs.length > 0 && (
          <div className="border-b border-slate-100 px-4 py-3">
            <p className="pb-2 text-xs font-semibold text-slate-400">操作记录</p>
            <div className="space-y-1.5">
              {logs.map((l) => (
                <div key={l.id} className="flex items-start gap-2 rounded-lg bg-slate-50/70 px-3 py-2 text-xs text-slate-500">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-budu-300" />
                  <span className="min-w-0">
                    <span className="font-semibold text-slate-600">{ACTION_LABEL[l.action] || l.action}</span>
                    {l.detail && l.detail !== ACTION_LABEL[l.action] && <span> · {l.detail}</span>}
                    <span className="ml-1.5 text-slate-400">— {l.username} · {fmtShortTime(l.createdAt)}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 底部固定操作栏 */}
      {showBottomBar && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-100 bg-white/95 backdrop-blur">
          <div className="mx-auto w-full max-w-[860px] px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {canDecide && (
              <div className="space-y-2">
                <textarea
                  rows={2}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="审批意见（驳回时必填）"
                  maxLength={300}
                  className="w-full resize-none rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-budu-400"
                />
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => act('reject')}
                    disabled={Boolean(busy)}
                    className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-rose-200 bg-rose-50 text-[15px] font-semibold text-rose-600 active:opacity-80 disabled:opacity-40"
                  >
                    <XCircle className="h-4 w-4" />
                    {busy === 'reject' ? '驳回中…' : '驳回'}
                  </button>
                  <button
                    onClick={() => act('approve')}
                    disabled={Boolean(busy)}
                    className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-emerald-500 text-[15px] font-semibold text-white shadow-sm active:opacity-85 disabled:opacity-50"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    {busy === 'approve' ? '通过中…' : '同意'}
                  </button>
                </div>
              </div>
            )}
            {isSubmitter && request.status === 'draft' && (
              <div className="flex gap-3">
                <button
                  onClick={() => onEdit?.(detail)}
                  disabled={Boolean(busy)}
                  className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-slate-200 px-5 text-sm font-semibold text-slate-500 active:bg-slate-50 disabled:opacity-40"
                >
                  <ClipboardCheck className="h-4 w-4" />编辑
                </button>
                <button
                  onClick={() => act('delete')}
                  disabled={Boolean(busy)}
                  className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-slate-200 px-5 text-sm font-semibold text-rose-500 active:bg-rose-50 disabled:opacity-40"
                >
                  <Trash2 className="h-4 w-4" />删除
                </button>
                <button
                  onClick={() => act('submit')}
                  disabled={Boolean(busy)}
                  className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-budu-500 text-[15px] font-semibold text-white shadow-sm active:opacity-85 disabled:opacity-50"
                >
                  <Send className="h-4 w-4" />{busy === 'submit' ? '提交中…' : '提交'}
                </button>
              </div>
            )}
            {isSubmitter && (request.status === 'rejected' || request.status === 'pending') && (
              <div className="flex gap-3">
                {request.status === 'rejected' && (
                  <button
                    onClick={() => onEdit?.(detail)}
                    disabled={Boolean(busy)}
                    className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-slate-200 px-5 text-sm font-semibold text-slate-500 active:bg-slate-50 disabled:opacity-40"
                  >
                    <RotateCcw className="h-4 w-4" />修改后重新提交
                  </button>
                )}
                {request.status === 'pending' && (
                  <button
                    onClick={() => act('withdraw')}
                    disabled={Boolean(busy)}
                    className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-slate-200 text-sm font-semibold text-slate-500 active:bg-slate-50 disabled:opacity-40"
                  >
                    <XCircle className="h-4 w-4" />撤回申请
                  </button>
                )}
              </div>
            )}
            {isSuper && (request.status === 'approved' || request.status === 'rejected') && (
              <button
                onClick={() => act('archive')}
                disabled={Boolean(busy)}
                className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-violet-200 bg-violet-50 text-sm font-semibold text-violet-600 active:opacity-80 disabled:opacity-40"
              >
                <Check className="h-4 w-4" />归档单据
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
