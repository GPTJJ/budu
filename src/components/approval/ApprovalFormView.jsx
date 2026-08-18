// 审批中心 · 发起审批表单页（企业微信风格单列表单）
// 业务逻辑与接口完全复用现有实现；仅呈现层改版
import { useMemo, useState } from 'react'
import { ArrowLeft, Send } from 'lucide-react'
import { api } from '../../utils/api'
import { allStores, storeName } from '../../utils/selectors'
import { AttachmentUploader, templateName } from './ApprovalShared'
import { EmployeeSheet, FieldRow, InputFieldRow, MonthSheet, OptionSheet, TextAreaRow } from './ApprovalSelectors'

function toMonday(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`)
  const dow = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - dow)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${dd}`
}

/** 审批流程展示（只读，数据来自模板规则 + 已选员工；不提供修改入口） */
function FlowSection({ template, formData, submitterName }) {
  const rule = template.approverRule || {}
  const ccRule = Array.isArray(template.ccRule) ? template.ccRule : []
  const approver = rule.type === 'username' ? rule.username : '老板'
  const ccPeople = []
  for (const r of ccRule) {
    if (r.type === 'role' && r.role === 'finance') ccPeople.push({ name: '财务', tag: '抄送' })
    else if (r.type === 'staffField') {
      const emp = String(formData?.[r.field] || '').split('::')[1]
      if (emp) ccPeople.push({ name: emp, tag: '抄送' })
    } else if (r.type === 'submitter') {
      ccPeople.push({ name: submitterName || '提交人', tag: '抄送' })
    }
  }
  return (
    <div>
      <p className="px-4 pb-1 pt-5 text-xs font-semibold text-slate-400">审批流程</p>
      <div className="border-b border-slate-100">
        <div className="flex min-h-[52px] items-center gap-3 px-4 py-2.5">
          <span className="w-[110px] shrink-0 text-[15px] text-slate-600">审批人</span>
          <span className="flex min-w-0 items-center gap-2">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-budu-100 text-xs font-bold text-budu-600">
              {approver.slice(0, 1)}
            </span>
            <span className="truncate text-[15px] text-slate-800">{approver}</span>
          </span>
        </div>
        <div className="flex min-h-[52px] items-center gap-3 px-4 py-2.5">
          <span className="w-[110px] shrink-0 text-[15px] text-slate-600">抄送人</span>
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {ccPeople.length === 0 && <span className="text-sm text-slate-300">无</span>}
            {ccPeople.map((p) => (
              <span key={`${p.name}-${p.tag}`} className="flex items-center gap-1.5 rounded-lg bg-slate-50 px-2 py-1">
                <span className="grid h-6 w-6 place-items-center rounded-full bg-white text-[10px] font-bold text-slate-500">
                  {p.name.slice(0, 1)}
                </span>
                <span className="text-xs font-medium text-slate-600">{p.name}</span>
              </span>
            ))}
          </span>
        </div>
      </div>
    </div>
  )
}

export default function ApprovalFormView({ template, initial, user, onBack, onSaved }) {
  const isEdit = Boolean(initial)
  const stores = allStores()
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
  // 选择器状态
  const [picker, setPicker] = useState(null) // { field, type: 'option'|'employee'|'month' }

  const schema = template.schema || []
  const fieldOf = (key) => schema.find((f) => f.key === key)
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

  /** 提交/保存草稿（与现有逻辑一致：POST 新建 / PUT+submit 编辑） */
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
        ? await api(`/v2/approvals/requests/${initial.request.id}`, {
            method: 'PUT',
            body: JSON.stringify({ formData, attachmentIds: payload.attachmentIds, title: payload.title }),
          })
        : await api('/v2/approvals/requests', { method: 'POST', body: JSON.stringify(payload) })
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

  /** 行点击：选择型字段打开选择器；日期字段触发原生控件 */
  const handleRowClick = (field) => {
    if (field.type === 'month') setPicker({ field: field.key, type: 'month' })
    else if (field.type === 'store') setPicker({ field: field.key, type: 'option', options: stores.map((s) => ({ value: s.key, label: s.name })) })
    else if (field.type === 'employee') setPicker({ field: field.key, type: 'employee' })
    else if (field.type === 'select') setPicker({ field: field.key, type: 'option', options: (field.options || []).map((o) => ({ value: o, label: o })) })
  }

  /** 字段行渲染 */
  const renderField = (field) => {
    const value = formData[field.key]
    const display = (v) => {
      if (field.type === 'store') return storeName(v) || ''
      if (field.type === 'employee') return String(v || '').split('::')[1] || ''
      if (field.type === 'money') return v
      return v
    }
    switch (field.type) {
      case 'month':
      case 'store':
      case 'employee':
      case 'select':
        return (
          <FieldRow
            key={field.key}
            label={field.label}
            required={field.required}
            value={display(value)}
            placeholder={field.type === 'month' ? '请选择' : field.type === 'store' ? '请选择门店' : field.type === 'employee' ? '请选择员工' : '请选择'}
            onClick={() => handleRowClick(field)}
          />
        )
      case 'date':
        return (
          <div key={field.key} className="relative border-b border-slate-100">
            <div className="flex min-h-[52px] w-full items-center gap-3 px-4 py-2.5">
              <span className="w-[110px] shrink-0 text-[15px] text-slate-600">
                {field.label}
                {field.required && <span className="ml-0.5 text-rose-500">*</span>}
              </span>
              <span className={`min-w-0 flex-1 truncate text-[15px] ${value ? 'text-slate-800' : 'text-slate-300'}`}>
                {value || '请选择日期'}
              </span>
              <input
                type="date"
                value={value || ''}
                onChange={(e) => e.target.value && setField(field.key)(e.target.value)}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                aria-label={field.label}
              />
            </div>
          </div>
        )
      case 'money':
        return (
          <InputFieldRow
            key={field.key}
            label={field.label}
            required={field.required}
            value={value}
            onChange={setField(field.key)}
            placeholder="请输入"
            type="number"
          />
        )
      case 'textarea':
        return (
          <TextAreaRow
            key={field.key}
            label={field.label}
            required={field.required}
            value={value}
            onChange={setField(field.key)}
            placeholder="请输入"
            maxLength={field.maxLength || 500}
          />
        )
      default:
        return (
          <InputFieldRow
            key={field.key}
            label={field.label}
            required={field.required}
            value={value}
            onChange={setField(field.key)}
            placeholder="请输入"
            maxLength={field.maxLength || 200}
          />
        )
    }
  }

  return (
    <div className="pb-24">
      {/* 顶部导航 */}
      <div className="mx-auto flex w-full max-w-[860px] items-center gap-2 px-2 py-2">
        <button onClick={onBack} className="grid h-10 w-10 place-items-center rounded-xl text-slate-500 active:bg-slate-100" aria-label="返回">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h2 className="text-[17px] font-semibold text-slate-800">
          {isEdit ? `编辑${template.name}申请` : template.name}
        </h2>
      </div>

      {error && (
        <p className="mx-auto mt-1 max-w-[860px] px-4 py-2.5 text-sm font-medium text-rose-600">
          {error}
        </p>
      )}

      {/* 表单主体（单列表单，1px 分隔） */}
      <div className="mx-auto w-full max-w-[860px] bg-white">
        {schema.map((f) => renderField(f))}
        {/* 附件 */}
        <div className="border-b border-slate-100">
          <div className="flex min-h-[52px] items-center gap-3 px-4 py-2.5">
            <span className="w-[110px] shrink-0 text-[15px] text-slate-600">附件</span>
            <div className="min-w-0 flex-1">
              <AttachmentUploader attachments={attachments} onChange={setAttachments} />
            </div>
          </div>
        </div>
        {/* 审批流程（只读） */}
        <FlowSection template={template} formData={formData} submitterName={user?.username} />
      </div>

      {/* 底部固定提交栏 */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-100 bg-white/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[860px] items-center gap-3 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <button
            onClick={() => save(false)}
            disabled={busy}
            className="min-h-11 shrink-0 rounded-xl border border-slate-200 px-5 text-sm font-semibold text-slate-500 active:bg-slate-50 disabled:opacity-40"
          >
            {busy ? '保存中…' : '保存草稿'}
          </button>
          <button
            onClick={() => save(true)}
            disabled={busy}
            className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-budu-500 text-[15px] font-semibold text-white shadow-sm transition active:opacity-85 disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
            {busy ? '提交中…' : isEdit && initial?.request?.status === 'rejected' ? '重新提交审批' : '提交'}
          </button>
        </div>
      </div>

      {/* 选择器 */}
      {picker?.type === 'option' && (
        <OptionSheet
          open
          title={fieldOf(picker.field)?.label || '选择'}
          options={picker.options}
          value={formData[picker.field]}
          onChange={setField(picker.field)}
          onClose={() => setPicker(null)}
        />
      )}
      {picker?.type === 'employee' && (
        <EmployeeSheet
          open
          title={fieldOf(picker.field)?.label || '选择员工'}
          value={formData[picker.field]}
          onChange={setField(picker.field)}
          onClose={() => setPicker(null)}
        />
      )}
      {picker?.type === 'month' && (
        <MonthSheet
          open
          value={formData[picker.field]}
          onChange={setField(picker.field)}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  )
}
