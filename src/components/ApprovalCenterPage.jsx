// 审批中心（通用审批引擎）：
// 待我审批 / 我发起的 / 抄送我的 / 全部审批 四页签；工资审批 + 报销审批
// 提交 → 老板审批 → 抄送（财务/员工/提交人）；附件图片/PDF/Excel 永久保存并在线预览
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ClipboardCheck,
  Download,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Inbox,
  Paperclip,
  Plus,
  RotateCcw,
  Send,
  Trash2,
  Upload,
  X,
  XCircle,
} from 'lucide-react'
import * as XLSX from 'xlsx'
import { api } from '../utils/api'
import { useI18n } from '../i18n'
import { allStores, employeeList, storeName } from '../utils/selectors'
import { refreshAlerts } from '../utils/inventoryAlerts'

const POLL_MS = 8000
const MAX_ATTACH = 8 * 1024 * 1024

const yuan = (cents) => `¥${Number(cents || 0).toFixed(2)}`
const fmtTime = (v) => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—')

const STATUS_META = {
  draft: { label: '草稿', cls: 'bg-slate-100 text-slate-500' },
  pending: { label: '待审批', cls: 'bg-amber-50 text-amber-600' },
  approved: { label: '已通过', cls: 'bg-emerald-50 text-emerald-600' },
  rejected: { label: '已驳回', cls: 'bg-rose-50 text-rose-600' },
  withdrawn: { label: '已撤回', cls: 'bg-slate-100 text-slate-400' },
  archived: { label: '已归档', cls: 'bg-violet-50 text-violet-600' },
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { label: status, cls: 'bg-slate-100 text-slate-500' }
  return <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${meta.cls}`}>{meta.label}</span>
}

const ACTION_LABEL = {
  create: '创建草稿',
  submit: '提交审批',
  edit: '编辑单据',
  approve: '审批通过',
  reject: '审批驳回',
  withdraw: '撤回申请',
  archive: '归档单据',
}

/** 图片压缩（最长边 2000px JPEG，控制 ≤8MB） */
function compressImageFile(file, maxSize = 2000, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height))
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        canvas.getContext('2d').drawImage(img, 0, 0, w, h)
        const dataUrl = canvas.toDataURL('image/jpeg', quality)
        const baseName = String(file.name || 'image').replace(/\.[^.]+$/, '') || 'image'
        resolve({ dataUrl, fileName: `${baseName}.jpg`, mime: 'image/jpeg' })
      }
      img.onerror = () => reject(new Error('图片读取失败'))
      img.src = reader.result
    }
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ dataUrl: reader.result, fileName: file.name, mime: file.type })
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

/** Excel 在线预览：解析首个 sheet 前 50 行 */
function ExcelPreview({ dataUrl }) {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    try {
      const b64 = String(dataUrl || '').split(',')[1]
      const wb = XLSX.read(b64, { type: 'base64' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
      setRows(data.slice(0, 50))
    } catch {
      setError('该表格暂无法预览，请下载查看')
    }
  }, [dataUrl])
  if (error) return <p className="py-6 text-center text-xs text-slate-300">{error}</p>
  if (!rows) return <p className="py-6 text-center text-xs text-slate-300">预览加载中…</p>
  if (rows.length === 0) return <p className="py-6 text-center text-xs text-slate-300">表格内容为空</p>
  return (
    <div className="max-h-72 overflow-auto rounded-xl border border-slate-100">
      <table className="w-full min-w-[480px] text-left text-xs">
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className={i === 0 ? 'bg-budu-50/50 font-semibold text-slate-600' : 'border-t border-slate-50'}>
              {(Array.isArray(row) ? row : []).slice(0, 12).map((cell, j) => (
                <td key={j} className="max-w-[200px] truncate px-2.5 py-1.5">{String(cell ?? '')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length >= 50 && <p className="border-t border-slate-50 px-3 py-2 text-[10px] text-slate-300">仅预览前 50 行，完整内容请下载查看</p>}
    </div>
  )
}

/** PDF 在线预览（blob URL） */
function PdfPreview({ dataUrl }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    try {
      const bin = atob(String(dataUrl || '').split(',')[1] || '')
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
      const blob = new Blob([bytes], { type: 'application/pdf' })
      setUrl(URL.createObjectURL(blob))
    } catch {
      setUrl('')
    }
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataUrl])
  if (!url) return <p className="py-6 text-center text-xs text-slate-300">PDF 暂无法预览，请下载查看</p>
  return <iframe src={url} title="PDF 预览" className="h-72 w-full rounded-xl border border-slate-100" />
}

/** 附件区：上传（表单用）/ 展示与预览（详情用） */
function AttachmentUploader({ attachments, onChange }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef(null)

  const handleFiles = async (fileList) => {
    setError('')
    for (const file of Array.from(fileList || []).slice(0, 5)) {
      if (file.size > MAX_ATTACH) {
        setError(`「${file.name}」超过 8MB，请压缩后上传`)
        continue
      }
      setBusy(true)
      try {
        const isImage = /^image\//.test(file.type)
        const { dataUrl, fileName, mime } = isImage
          ? await compressImageFile(file)
          : await readFileAsDataUrl(file)
        if (dataUrl.length > MAX_ATTACH * 1.5) {
          setError(`「${fileName}」超过 8MB，请压缩后上传`)
          continue
        }
        const res = await api('/v2/approvals/attachments', {
          method: 'POST',
          body: JSON.stringify({ name: fileName, fileType: mime, dataUrl }),
        })
        onChange([...(attachments || []), res.attachment])
      } catch (e) {
        setError(e.message || '上传失败')
      } finally {
        setBusy(false)
      }
    }
    if (inputRef.current) inputRef.current.value = ''
  }

  const remove = (id) => {
    onChange((attachments || []).filter((a) => a.id !== id))
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {(attachments || []).map((a) => (
          <span key={a.id} className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-slate-50 px-2.5 py-1.5 text-[11px] font-semibold text-slate-600">
            {a.fileType.startsWith('image/') ? <ImageIcon className="h-3.5 w-3.5 text-budu-500" /> : a.fileType === 'application/pdf' ? <FileText className="h-3.5 w-3.5 text-rose-500" /> : <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-500" />}
            <span className="max-w-[180px] truncate">{a.name}</span>
            <button onClick={() => remove(a.id)} className="text-slate-300 transition hover:text-rose-500" aria-label="移除附件">
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        ))}
        <button
          onClick={() => inputRef.current?.click()}
          disabled={busy || (attachments || []).length >= 10}
          className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-slate-300 px-3 py-1.5 text-[11px] font-semibold text-slate-400 transition hover:border-budu-400 hover:text-budu-500 disabled:opacity-40"
        >
          {busy ? <Upload className="h-3.5 w-3.5 animate-pulse" /> : <Paperclip className="h-3.5 w-3.5" />}
          {busy ? '上传中…' : '添加附件（图片/PDF/Excel ≤8MB）'}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/*,.pdf,.xls,.xlsx"
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>
      {error && <p className="mt-1.5 text-[11px] font-medium text-rose-500">{error}</p>}
    </div>
  )
}

/** 表单字段按模板 schema 渲染 */
function FormField({ field, value, onChange, stores, employees }) {
  const { t } = useI18n()
  const label = field.label
  const base = 'rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-budu-400 w-full'
  switch (field.type) {
    case 'month':
      return (
        <div>
          <label className="mb-1.5 block text-xs font-semibold text-slate-500">{label}</label>
          <input type="month" value={value || ''} onChange={(e) => onChange(e.target.value)} className={base} />
        </div>
      )
    case 'store':
      return (
        <div>
          <label className="mb-1.5 block text-xs font-semibold text-slate-500">{label}</label>
          <select value={value || ''} onChange={(e) => onChange(e.target.value)} className={base}>
            <option value="">请选择门店</option>
            {stores.map((s) => (
              <option key={s.key} value={s.key}>{s.name}</option>
            ))}
          </select>
        </div>
      )
    case 'employee':
      return (
        <div>
          <label className="mb-1.5 block text-xs font-semibold text-slate-500">{label}</label>
          <select value={value || ''} onChange={(e) => onChange(e.target.value)} className={base}>
            <option value="">请选择员工</option>
            {employees.map((e) => (
              <option key={`${e.storeKey}::${e.name}`} value={`${e.storeKey}::${e.name}`}>
                {e.name}（{storeName(e.storeKey) || e.storeKey}）
              </option>
            ))}
          </select>
        </div>
      )
    case 'money':
      return (
        <div>
          <label className="mb-1.5 block text-xs font-semibold text-slate-500">{label}</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder="0.00"
            className={base}
          />
        </div>
      )
    case 'date':
      return (
        <div>
          <label className="mb-1.5 block text-xs font-semibold text-slate-500">{label}</label>
          <input type="date" value={value || ''} onChange={(e) => onChange(e.target.value)} className={base} />
        </div>
      )
    case 'select':
      return (
        <div>
          <label className="mb-1.5 block text-xs font-semibold text-slate-500">{label}</label>
          <select value={value || ''} onChange={(e) => onChange(e.target.value)} className={base}>
            <option value="">请选择</option>
            {(field.options || []).map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        </div>
      )
    case 'textarea':
      return (
        <div>
          <label className="mb-1.5 block text-xs font-semibold text-slate-500">{label}</label>
          <textarea
            rows={3}
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder || ''}
            maxLength={field.maxLength || 500}
            className={base}
          />
        </div>
      )
    default:
      return (
        <div>
          <label className="mb-1.5 block text-xs font-semibold text-slate-500">{label}</label>
          <input value={value || ''} onChange={(e) => onChange(e.target.value)} className={base} />
        </div>
      )
  }
}

/** 新建申请：模板选择 */
function TemplatePickerModal({ templates, onPick, onClose }) {
  return createPortal(
    <div className="fixed inset-0 z-[96] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-lg">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-lg font-bold text-slate-800">新建审批申请</h3>
            <p className="mt-1 text-xs text-slate-400">选择申请类型，提交后由老板审批</p>
          </div>
          <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-xl bg-slate-50 text-slate-400 transition hover:bg-slate-100" aria-label="关闭">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="mt-4 grid gap-3">
          {templates.map((t) => (
            <button
              key={t.key}
              onClick={() => onPick(t)}
              className="flex items-center gap-3 rounded-2xl border border-slate-100 bg-white p-4 text-left transition hover:border-budu-300 hover:bg-budu-50/40"
            >
              <div className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl ${t.key === 'payroll' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
                {t.key === 'payroll' ? <FileSpreadsheet className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-800">{t.name}</p>
                <p className="mt-0.5 line-clamp-2 text-xs text-slate-400">{t.description}</p>
              </div>
              <ChevronRightIcon className="ml-auto h-4 w-4 shrink-0 text-slate-300" />
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function ChevronRightIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

/** 新建/编辑表单弹窗 */
function ApprovalFormModal({ template, initial, onClose, onSaved }) {
  const { t } = useI18n()
  const stores = allStores()
  const employees = useMemo(() => employeeList('all', null), [])
  const [formData, setFormData] = useState(() => {
    const out = {}
    const saved = initial?.request?.formData || {}
    for (const f of template.schema || []) {
      const v = saved[f.key]
      if (f.type === 'money' && typeof v === 'number') out[f.key] = String((v / 100).toFixed(2))
      else out[f.key] = v !== undefined && v !== null ? String(v) : ''
    }
    return out
  })
  const [attachments, setAttachments] = useState(initial?.attachments || [])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const setField = (key) => (value) => setFormData((s) => ({ ...s, [key]: value }))

  const buildTitle = () => {
    if (template.key === 'payroll') {
      const emp = String(formData.employee || '').split('::')[1] || ''
      return `${emp || '员工'} · ${formData.salaryMonth || ''} 工资`
    }
    if (template.key === 'expense') {
      return `${formData.expenseType || '费用'}报销 ${Number(formData.amount || 0)} 元`
    }
    return template.name
  }

  const save = async (submit) => {
    setBusy(true)
    setError('')
    try {
      const payload = {
        templateKey: template.key,
        formData,
        attachmentIds: attachments.map((a) => a.id),
        title: buildTitle(),
        submit,
      }
      const res = initial
        ? await api(`/v2/approvals/requests/${initial.request.id}`, { method: 'PUT', body: JSON.stringify({ formData, attachmentIds: payload.attachmentIds, title: payload.title }) })
        : await api('/v2/approvals/requests', { method: 'POST', body: JSON.stringify(payload) })
      // 编辑草稿/驳回单后提交：draft 或 rejected 均可 submit
      if (submit && initial) {
        await api(`/v2/approvals/requests/${initial.request.id}/submit`, { method: 'POST' })
      }
      onSaved?.(res.request || initial, submit)
    } catch (e) {
      setError(e.message || '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[96] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-6 shadow-lg">
        <div className="flex flex-wrap items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-2xl bg-budu-50 text-budu-600">
            <ClipboardCheck className="h-6 w-6" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-slate-800">{initial ? `编辑${template.name}申请` : `新建${template.name}申请`}</h3>
            <p className="mt-0.5 text-xs text-slate-400">提交后由老板审批，通过后抄送财务{template.key === 'payroll' ? '与该员工' : '与提交人'}</p>
          </div>
          <button onClick={onClose} className="ml-auto grid h-9 w-9 place-items-center rounded-xl bg-slate-50 text-slate-400 transition hover:bg-slate-100" aria-label="关闭">
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && <p className="mt-3 rounded-xl bg-rose-50 px-4 py-2.5 text-sm text-rose-600">{error}</p>}

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {(template.schema || []).map((f) => (
            <div key={f.key} className={f.type === 'textarea' ? 'sm:col-span-2' : ''}>
              <FormField field={f} value={formData[f.key]} onChange={setField(f.key)} stores={stores} employees={employees} />
            </div>
          ))}
        </div>

        <div className="mt-4">
          <p className="mb-1.5 text-xs font-semibold text-slate-500">附件（{attachments.length}/10）</p>
          <AttachmentUploader attachments={attachments} onChange={setAttachments} />
        </div>

        <div className="mt-5 flex flex-col gap-2.5 border-t border-slate-100 pt-4 sm:flex-row">
          <button
            onClick={() => save(false)}
            disabled={busy}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-50 disabled:opacity-40"
          >
            {busy ? '保存中…' : '保存草稿'}
          </button>
          <button
            onClick={() => save(true)}
            disabled={busy}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-budu-500 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:opacity-90 disabled:opacity-40"
          >
            <Send className="h-4 w-4" />
            {busy ? '提交中…' : initial?.request?.status === 'rejected' ? '重新提交审批' : '提交审批'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** 只读字段展示 */
function ReadonlyField({ label, value, money, highlight }) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2.5">
      <p className="text-[11px] text-slate-400">{label}</p>
      <p className={`mt-0.5 break-words text-sm font-bold tabular-nums ${highlight ? 'text-budu-600' : 'text-slate-700'}`}>
        {value === '' || value === null || value === undefined ? '—' : value}
      </p>
    </div>
  )
}

/** 详情弹窗：表单只读 + 附件预览 + 审批/撤回/归档操作 + 意见 + 日志 */
function ApprovalDetailModal({ detail, user, onClose, onChanged, onEdit }) {
  const { t } = useI18n()
  const { request, template, nodes, ccs, attachments, comments, logs } = detail
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const isDev = user?.role === 'developer'
  const isSubmitter = user?.username === request.submitterUsername

  const act = async (action, extra = {}) => {
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

  return createPortal(
    <div className="fixed inset-0 z-[96] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-lg">
        {/* 头部 */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-2xl bg-budu-50 text-budu-600">
            <ClipboardCheck className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-bold text-slate-800">{request.title}</h3>
              <StatusBadge status={request.status} />
            </div>
            <p className="mt-0.5 text-xs text-slate-400">
              {template.name} · {request.requestNo} · {t('由 {name} 提交', { name: request.submitterName || request.submitterUsername })} · {fmtTime(request.createdAt)}
            </p>
          </div>
          <button onClick={onClose} className="ml-auto grid h-9 w-9 place-items-center rounded-xl bg-slate-50 text-slate-400 transition hover:bg-slate-100" aria-label="关闭">
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && <p className="mt-3 rounded-xl bg-rose-50 px-4 py-2.5 text-sm text-rose-600">{error}</p>}

        {/* 表单字段只读 */}
        <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
          {(template.schema || []).map((f) => (
            <div key={f.key} className={f.type === 'textarea' ? 'sm:col-span-2' : ''}>
              <ReadonlyField
                label={f.label}
                value={fmtValue(f, request.formData?.[f.key])}
                highlight={f.amount === true}
              />
            </div>
          ))}
          <div className="sm:col-span-2">
            <ReadonlyField label="金额合计" value={yuan(request.amountCents)} highlight />
          </div>
        </div>

        {/* 附件 */}
        {attachments.length > 0 && (
          <div className="mt-4">
            <p className="mb-1.5 text-xs font-semibold text-slate-500">附件（{attachments.length}）</p>
            <div className="space-y-2">
              {attachments.map((a) => (
                <div key={a.id} className="rounded-xl border border-slate-100 p-3">
                  <div className="flex items-center gap-2">
                    {a.fileType.startsWith('image/') ? <ImageIcon className="h-4 w-4 text-budu-500" /> : a.fileType === 'application/pdf' ? <FileText className="h-4 w-4 text-rose-500" /> : <FileSpreadsheet className="h-4 w-4 text-emerald-500" />}
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-600">{a.name}</span>
                    <button onClick={() => download(a)} className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-budu-500 transition hover:bg-budu-50" aria-label="下载附件">
                      <Download className="h-3.5 w-3.5" />下载
                    </button>
                  </div>
                  <div className="mt-2">
                    {a.fileType.startsWith('image/') ? (
                      <img src={a.dataUrl} alt={a.name} className="max-h-72 rounded-xl border border-slate-100 object-contain" />
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

        {/* 审批操作区 */}
        {request.status === 'pending' && isDev && (
          <div className="mt-4 rounded-2xl border border-amber-100 bg-amber-50/50 p-4">
            <p className="text-xs font-bold text-slate-600">审批操作</p>
            <textarea
              rows={2}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="审批意见（驳回时必填）"
              maxLength={300}
              className="input mt-2 w-full"
            />
            <div className="mt-2.5 grid grid-cols-2 gap-2.5">
              <button
                onClick={() => act('reject')}
                disabled={Boolean(busy)}
                className="flex items-center justify-center gap-1.5 rounded-xl bg-rose-500 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-rose-600 disabled:opacity-40"
              >
                <XCircle className="h-4 w-4" />
                {busy === 'reject' ? '驳回中…' : '驳回'}
              </button>
              <button
                onClick={() => act('approve')}
                disabled={Boolean(busy)}
                className="flex items-center justify-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-600 disabled:opacity-40"
              >
                <CheckCircle2 className="h-4 w-4" />
                {busy === 'approve' ? '通过中…' : '通过'}
              </button>
            </div>
          </div>
        )}

        {/* 提交人操作区 */}
        {isSubmitter && (
          <div className="mt-4 flex flex-wrap gap-2">
            {(request.status === 'draft' || request.status === 'rejected') && onEdit && (
              <button onClick={() => onEdit(detail)} disabled={Boolean(busy)} className="flex items-center gap-1.5 rounded-xl border border-slate-200 px-3.5 py-2 text-xs font-semibold text-slate-500 transition hover:bg-slate-50 disabled:opacity-40">
                <ClipboardCheck className="h-3.5 w-3.5" />{request.status === 'rejected' ? '修改后重新提交' : '编辑草稿'}
              </button>
            )}
            {request.status === 'draft' && (
              <>
                <button onClick={() => act('delete')} disabled={Boolean(busy)} className="flex items-center gap-1.5 rounded-xl border border-slate-200 px-3.5 py-2 text-xs font-semibold text-slate-500 transition hover:bg-rose-50 hover:text-rose-500 disabled:opacity-40">
                  <Trash2 className="h-3.5 w-3.5" />删除草稿
                </button>
                <button onClick={() => act('submit')} disabled={Boolean(busy)} className="flex items-center gap-1.5 rounded-xl bg-budu-500 px-3.5 py-2 text-xs font-bold text-white shadow-sm transition hover:opacity-90 disabled:opacity-40">
                  <Send className="h-3.5 w-3.5" />提交审批
                </button>
              </>
            )}
            {request.status === 'pending' && (
              <button onClick={() => act('withdraw')} disabled={Boolean(busy)} className="flex items-center gap-1.5 rounded-xl border border-slate-200 px-3.5 py-2 text-xs font-semibold text-slate-500 transition hover:bg-slate-50 disabled:opacity-40">
                <XCircle className="h-3.5 w-3.5" />撤回申请
              </button>
            )}
          </div>
        )}

        {/* 归档（开发者） */}
        {isDev && (request.status === 'approved' || request.status === 'rejected') && (
          <div className="mt-3">
            <button onClick={() => act('archive')} disabled={Boolean(busy)} className="flex items-center gap-1.5 rounded-xl border border-violet-200 bg-violet-50 px-3.5 py-2 text-xs font-bold text-violet-600 transition hover:bg-violet-100 disabled:opacity-40">
              <Check className="h-3.5 w-3.5" />归档单据
            </button>
          </div>
        )}

        {/* 审批节点 */}
        {nodes.length > 0 && (
          <div className="mt-4">
            <p className="mb-1.5 text-xs font-semibold text-slate-500">审批流程</p>
            <div className="space-y-1.5">
              {nodes.map((n) => (
                <div key={n.id} className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 text-xs">
                  <span className={`grid h-5 w-5 place-items-center rounded-full ${n.status === 'approved' ? 'bg-emerald-500 text-white' : n.status === 'rejected' ? 'bg-rose-500 text-white' : 'bg-amber-100 text-amber-600'}`}>
                    {n.status === 'approved' ? <Check className="h-3 w-3" /> : n.status === 'rejected' ? <X className="h-3 w-3" /> : <Clock2Icon />}
                  </span>
                  <span className="font-semibold text-slate-600">审批人：{n.approverUsername}</span>
                  <span className="ml-auto text-[11px] text-slate-400">
                    {n.status === 'pending' ? '待审批' : n.status === 'approved' ? `已通过${n.actedAt ? ` · ${fmtTime(n.actedAt)}` : ''}` : `已驳回${n.actedAt ? ` · ${fmtTime(n.actedAt)}` : ''}`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 抄送 */}
        {ccs.length > 0 && (
          <div className="mt-4">
            <p className="mb-1.5 text-xs font-semibold text-slate-500">抄送（{ccs.length}）</p>
            <div className="flex flex-wrap gap-1.5">
              {ccs.map((c) => (
                <span key={c.id} className="inline-flex items-center gap-1.5 rounded-lg bg-budu-50 px-2.5 py-1 text-[11px] font-semibold text-budu-600">
                  {c.ccName || c.ccUsername}
                  {c.readAt && <span className="text-[9px] font-normal text-budu-400">已读 {fmtTime(c.readAt)}</span>}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* 审批意见 */}
        {comments.length > 0 && (
          <div className="mt-4">
            <p className="mb-1.5 text-xs font-semibold text-slate-500">审批意见</p>
            <div className="space-y-1.5">
              {comments.map((c) => (
                <div key={c.id} className="rounded-xl border border-slate-100 px-3 py-2 text-xs">
                  <p className="text-slate-600">{c.content}</p>
                  <p className="mt-0.5 text-[10px] text-slate-300">{c.username} · {fmtTime(c.createdAt)}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 操作日志时间线 */}
        {logs.length > 0 && (
          <div className="mt-4">
            <p className="mb-1.5 text-xs font-semibold text-slate-500">操作记录</p>
            <div className="space-y-1.5">
              {logs.map((l) => (
                <div key={l.id} className="flex items-start gap-2 rounded-xl bg-slate-50/70 px-3 py-2 text-[11px] text-slate-500">
                  <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-budu-300" />
                  <span>
                    <span className="font-semibold text-slate-600">{ACTION_LABEL[l.action] || l.action}</span>
                    {l.detail && l.detail !== ACTION_LABEL[l.action] && <span> · {l.detail}</span>}
                    <span className="ml-1.5 text-slate-300">— {l.username} · {fmtTime(l.createdAt)}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

function Clock2Icon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  )
}

/** 审批中心主页面 */
export default function ApprovalCenterPage({ user, onBack }) {
  const { t } = useI18n()
  const allowed = Boolean(user && user.role !== 'public' && user.role !== 'cashier')
  const isDev = user?.role === 'developer'
  const canSeeAll = isDev || user?.role === 'finance'

  const [templates, setTemplates] = useState([])
  const [scope, setScope] = useState('todo')
  const [statusFilter, setStatusFilter] = useState('')
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [formTemplate, setFormTemplate] = useState(null)
  const [editTarget, setEditTarget] = useState(null)
  const [detail, setDetail] = useState(null)
  const [tick, setTick] = useState(0)

  const scopes = [
    { key: 'todo', label: '待我审批' },
    { key: 'my', label: '我发起的' },
    { key: 'cc', label: '抄送我的' },
    ...(canSeeAll ? [{ key: 'all', label: '全部审批' }] : []),
  ]

  const load = async () => {
    try {
      const qs = `scope=${scope}${statusFilter ? `&status=${statusFilter}` : ''}`
      const res = await api(`/v2/approvals/requests?${qs}`)
      setRows(Array.isArray(res.rows) ? res.rows : [])
      // 详情打开时同步状态
      setDetail((d) => (d ? { ...d, request: Array.isArray(res.rows) ? res.rows.find((r) => r.id === d.request.id) || d.request : d.request } : d))
    } catch (e) {
      setError(e.message || '加载失败')
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
    if (allowed && tick > 0) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick])

  const countOf = (s) => (rows || []).filter((r) => s === 'all' || r.status === s).length

  const openDetail = async (id) => {
    try {
      const res = await api(`/v2/approvals/requests/${id}`)
      setDetail(res)
    } catch (e) {
      setError(e.message || '加载详情失败')
    }
  }

  const handleChanged = () => {
    setDetail(null)
    load()
    refreshAlerts()
  }

  /** 编辑草稿/驳回重提：打开表单弹窗（带 initial） */
  const handleEdit = (d) => {
    setDetail(null)
    setEditTarget(d)
    setFormTemplate({
      key: d.template.key,
      name: d.template.name,
      description: d.template.description,
      schema: d.template.schema,
    })
  }

  const handleSaved = (request, submitted) => {
    setFormTemplate(null)
    setEditTarget(null)
    setPickerOpen(false)
    load()
    if (submitted) refreshAlerts()
    if (request?.id && submitted) openDetail(request.id)
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
    <div className="space-y-5">
      {/* 头部 */}
      <div className="flex flex-wrap items-center gap-4">
        <button onClick={onBack} className="flex items-center gap-1.5 rounded-2xl bg-white px-3.5 py-2.5 text-sm font-medium text-slate-500 shadow-card transition hover:text-budu-600">
          <ArrowLeft className="h-4 w-4" />
          {t('返回首页')}
        </button>
        <div>
          <h2 className="text-xl font-bold text-slate-800">{t('审批中心')}</h2>
          <p className="mt-0.5 text-[13px] text-slate-400">{t('工资与报销审批 · 提交 → 老板审批 → 抄送财务')}</p>
        </div>
        <button
          onClick={() => setPickerOpen(true)}
          className="ml-auto flex items-center gap-1.5 rounded-2xl bg-budu-500 px-4 py-2.5 text-[13px] font-semibold text-white shadow-sm transition hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          {t('新建申请')}
        </button>
      </div>

      {error && <p className="rounded-xl bg-rose-50 px-4 py-2.5 text-sm text-rose-600">{error}</p>}

      {/* 页签 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex flex-wrap gap-1.5 rounded-2xl bg-white p-1.5 shadow-card">
          {scopes.map((s) => (
            <button
              key={s.key}
              onClick={() => setScope(s.key)}
              className={`rounded-xl px-4 py-1.5 text-[13px] font-semibold transition ${
                scope === s.key ? 'bg-budu-500 text-white shadow-md' : 'text-slate-500 hover:bg-budu-50 hover:text-budu-600'
              }`}
            >
              {t(s.label)}
              {s.key === 'todo' && (rows || []).length > 0 && (
                <span className={`ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-bold ${scope === s.key ? 'bg-white/25 text-white' : 'bg-amber-100 text-amber-600'}`}>
                  {rows.length}
                </span>
              )}
            </button>
          ))}
        </div>
        {rows !== null && rows.length > 0 && (
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="ml-auto rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-500 outline-none focus:border-budu-400">
            <option value="">全部状态</option>
            {Object.entries(STATUS_META).map(([k, m]) => (
              <option key={k} value={k}>{m.label}{countOf(k) > 0 ? `（${countOf(k)}）` : ''}</option>
            ))}
          </select>
        )}
      </div>

      {/* 列表 */}
      <div className="card overflow-hidden p-0">
        {rows === null ? (
          <p className="grid place-items-center py-16 text-xs text-slate-300">{t('加载中…')}</p>
        ) : rows.length === 0 ? (
          <div className="grid place-items-center py-16 text-center">
            <Inbox className="h-9 w-9 text-slate-200" />
            <p className="mt-3 text-sm font-semibold text-slate-400">
              {scope === 'todo' ? '暂无待我审批的申请' : scope === 'my' ? '你还没有发起过申请' : scope === 'cc' ? '暂无抄送我的记录' : '暂无审批记录'}
            </p>
            {scope === 'my' && (
              <p className="mt-1.5 text-xs text-slate-300">{t('点击右上角「新建申请」发起工资或报销审批')}</p>
            )}
          </div>
        ) : (
          <div className="divide-y divide-slate-50">
            {rows.map((r) => (
              <button key={r.id} onClick={() => openDetail(r.id)} className="block w-full px-4 py-3.5 text-left transition hover:bg-budu-50/50">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${r.templateKey === 'payroll' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
                    {r.templateName}
                  </span>
                  <span className="text-[13px] font-semibold text-slate-700">{r.title}</span>
                  <StatusBadge status={r.status} />
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  <span className="font-bold text-budu-600">{yuan(r.amountCents)}</span>
                  <span className="ml-2 text-[11px] text-slate-400">
                    {scope !== 'my' && `${r.submitterName || r.submitterUsername} · `}
                    {r.requestNo} · {fmtTime(r.createdAt)}
                  </span>
                </p>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 模板选择 */}
      {pickerOpen && (
        <TemplatePickerModal
          templates={templates}
          onPick={(tpl) => {
            setPickerOpen(false)
            setFormTemplate(tpl)
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {/* 新建/编辑表单 */}
      {formTemplate && (
        <ApprovalFormModal
          template={formTemplate}
          initial={editTarget || undefined}
          onClose={() => {
            setFormTemplate(null)
            setEditTarget(null)
          }}
          onSaved={handleSaved}
        />
      )}

      {/* 详情 */}
      {detail && (
        <ApprovalDetailModal
          detail={detail}
          user={user}
          onClose={() => setDetail(null)}
          onChanged={handleChanged}
          onEdit={handleEdit}
        />
      )}
    </div>
  )
}
