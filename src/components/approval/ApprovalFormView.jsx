// 审批中心 · 发起审批表单页（企业微信风格单列表单）
// 业务逻辑与接口完全复用现有实现；仅呈现层改版
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Send, UserRound } from 'lucide-react'
import { api } from '../../utils/api'
import { allStores, storeName } from '../../utils/selectors'
import { AttachmentUploader, templateName } from './ApprovalShared'
import { EmployeeSheet, FieldRow, InputFieldRow, OptionSheet, TextAreaRow } from './ApprovalSelectors'
import { CcSheet } from './ApprovalSelectors'
import PayrollSlipCard from '../PayrollSlipCard'
import BuduSuccessFeedback from '../feedback/BuduSuccessFeedback'
import { periodLabel } from '../../utils/payrollSlip'
import { toPng } from 'html-to-image'

/** 审批流程展示：提交人（只读）/ 审批人（管理员）/ 抄送人（默认 + 可添加）；显示账号持有人姓名 */
function FlowSection({ template, user, extraCc, onAddCc, onRemoveCc, payrollNotices, candidates }) {
  const rule = template.approverRule || {}
  const ccRule = Array.isArray(template.ccRule) ? template.ccRule : []
  const nameOf = (uname) => {
    const c = (candidates || []).find((x) => x.username === uname)
    return c ? c.name : uname
  }
  // 审批人：规则角色对应的账号持有人姓名（如管理员张三）
  const approverNames = (() => {
    if (rule.type === 'username') return [nameOf(rule.username)]
    if (rule.type === 'role') {
      const list = (candidates || []).filter((c) => c.role === rule.role)
      if (list.length > 0) return list.map((c) => c.name)
    }
    return []
  })()
  const approver = approverNames.length > 0 ? `${rule.role === 'admin' ? '管理员' : rule.role} · ${approverNames.join('、')}` : rule.type === 'username' ? rule.username : '管理员'
  // 默认抄送人（规则）：提交人 + 财务账号（显示持有人姓名）
  const defaultCc = []
  for (const r of ccRule) {
    if (r.type === 'role' && r.role === 'finance') {
      const fin = (candidates || []).filter((c) => c.role === 'finance')
      if (fin.length > 0) fin.forEach((c) => defaultCc.push({ name: c.name, tag: '默认' }))
      else defaultCc.push({ name: '财务', tag: '默认' })
    } else if (r.type === 'submitter') {
      defaultCc.push({ name: user?.displayName || user?.username || '提交人', tag: '提交人' })
    }
  }
  return (
    <div>
      <p className="px-4 pb-1 pt-5 text-xs font-semibold text-slate-400">审批流程</p>
      <div className="border-b border-slate-100">
        {/* 提交人（只读，自动为当前账号） */}
        <div className="flex min-h-[52px] items-center gap-3 px-4 py-2.5">
          <span className="w-[110px] shrink-0 text-[15px] text-slate-600">提交人</span>
          <span className="flex min-w-0 items-center gap-2">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-slate-100 text-xs font-bold text-slate-600">
              <UserRound className="h-4 w-4" />
            </span>
            <span className="truncate text-[15px] text-slate-800">{user?.displayName || user?.username}</span>
            <span className="text-[11px] text-slate-300">（当前账号，不可更改）</span>
          </span>
        </div>
        {/* 审批人 */}
        <div className="flex min-h-[52px] items-center gap-3 px-4 py-2.5">
          <span className="w-[110px] shrink-0 text-[15px] text-slate-600">审批人</span>
          <span className="flex min-w-0 items-center gap-2">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-budu-100 text-xs font-bold text-budu-600">
              {approver.slice(0, 1)}
            </span>
            <span className="truncate text-[15px] text-slate-800">{approver}</span>
          </span>
        </div>
        {/* 抄送人：默认（提交人+财务）+ 可添加 */}
        <div className="flex min-h-[52px] items-center gap-3 px-4 py-2.5">
          <span className="w-[110px] shrink-0 text-[15px] text-slate-600">抄送人</span>
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {defaultCc.map((p) => (
              <span key={`${p.name}-${p.tag}`} className="flex items-center gap-1.5 rounded-lg bg-slate-50 px-2 py-1">
                <span className="grid h-6 w-6 place-items-center rounded-full bg-white text-[10px] font-bold text-slate-500">
                  {p.name.slice(0, 1)}
                </span>
                <span className="text-xs font-medium text-slate-600">{p.name}</span>
                <span className="rounded bg-white px-1 py-0.5 text-[9px] font-semibold text-slate-400">{p.tag}</span>
              </span>
            ))}
            {(extraCc || []).map((uname) => (
              <span key={uname} className="flex items-center gap-1.5 rounded-lg bg-budu-50 px-2 py-1">
                <span className="grid h-6 w-6 place-items-center rounded-full bg-white text-[10px] font-bold text-budu-500">
                  {nameOf(uname).slice(0, 1)}
                </span>
                <span className="text-xs font-medium text-budu-600">{nameOf(uname)}</span>
                <button
                  onClick={() => onRemoveCc?.(uname)}
                  className="rounded bg-white px-1 text-[10px] font-bold text-slate-400 transition hover:text-rose-500"
                  aria-label={`移除抄送人 ${uname}`}
                >
                  ×
                </button>
              </span>
            ))}
            <button
              onClick={onAddCc}
              className="grid h-7 w-7 place-items-center rounded-lg border border-dashed border-budu-300 text-lg font-semibold text-budu-500 transition hover:bg-budu-50"
              aria-label="添加抄送人"
            >
              +
            </button>
          </span>
        </div>
        {/* 已签收工资条提示（工资审批专用） */}
        {template.key === 'payroll' && payrollNotices && payrollNotices.length > 0 && (
          <div className="border-t border-dashed border-slate-100 px-4 py-2.5">
            <p className="text-[11px] font-medium text-emerald-600">
              该员工有 {payrollNotices.length} 份已签收工资条，选中周期后自动填充并生成图片附件
            </p>
          </div>
        )}
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
  const [extraCc, setExtraCc] = useState(() => (initial?.request?.formData?._ccUsernames || []))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [picker, setPicker] = useState(null) // { field, type: 'option'|'employee'|'month'|'cc' }
  const [payrollNotices, setPayrollNotices] = useState(null) // 已签收工资条（payroll 模板）
  const [importing, setImporting] = useState(false)
  const [slipNotice, setSlipNotice] = useState(null) // 当前导入的工资条（用于生成图片附件）
  const [candidates, setCandidates] = useState([]) // 账号姓名映射（抄送人/审批人显示）
  const [feedback, setFeedback] = useState(null)
  const [bankInfo, setBankInfo] = useState(null) // 员工档案银行卡（工资审批自动代入）
  const autoBankRef = useRef({ bankName: '', bankBranch: '', cardNumber: '' }) // 上次自动代入值（避免覆盖手动修改）
  const slipCardRef = useRef(null)

  useEffect(() => {
    api('/v2/approvals/cc-candidates')
      .then((res) => setCandidates(Array.isArray(res.rows) ? res.rows : []))
      .catch(() => setCandidates([]))
  }, [])

  const schema = template.schema || []
  const fieldOf = (key) => schema.find((f) => f.key === key)
  const setField = (key) => (value) => setFormData((s) => ({ ...s, [key]: value }))

  // 工资审批：员工变化后拉取该员工已签收工资条
  useEffect(() => {
    if (template.key !== 'payroll') return undefined
    const emp = String(formData.employee || '')
    const empName = emp.split('::')[1] || ''
    if (!empName) {
      setPayrollNotices(null)
      return undefined
    }
    let alive = true
    setPayrollNotices([])
    api(`/v2/payroll-notices?status=confirmed&employeeName=${encodeURIComponent(empName)}`)
      .then((res) => {
        if (alive) setPayrollNotices(Array.isArray(res.rows) ? res.rows : [])
      })
      .catch(() => {
        if (alive) setPayrollNotices([])
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.employee, template.key])

  // 工资审批：员工档案银行卡信息自动代入（若有）；不强制填写，可修改
  useEffect(() => {
    if (template.key !== 'payroll') return undefined
    const emp = String(formData.employee || '')
    const parts = emp.split('::')
    const storeKey = parts[0] || ''
    const empName = parts[1] || ''
    if (!empName || !storeKey) {
      setBankInfo(null)
      return undefined
    }
    let alive = true
    setBankInfo(null)
    api(`/v2/approvals/payroll-bank-info?storeKey=${encodeURIComponent(storeKey)}&employeeName=${encodeURIComponent(empName)}`)
      .then((res) => {
        if (!alive) return
        const bank = res && res.bank
        setBankInfo(bank || null)
        if (!bank) return
        const next = {
          bankName: bank.bankName || '',
          bankBranch: bank.bankBranch || '',
          cardNumber: bank.cardNumber || bank.maskedNumber || '',
        }
        setFormData((s) => {
          const merged = { ...s }
          let changed = false
          for (const key of ['bankName', 'bankBranch', 'cardNumber']) {
            // 仅当字段为空或仍是上次自动代入值时覆盖，避免覆盖手动修改
            if (!s[key] || s[key] === autoBankRef.current[key]) {
              merged[key] = next[key]
              changed = true
            }
          }
          if (changed) {
            autoBankRef.current = next
            return merged
          }
          return s
        })
      })
      .catch(() => setBankInfo(null))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.employee, template.key])

  const buildTitle = () => {
    if (template.key === 'payroll') {
      const emp = String(formData.employee || '').split('::')[1] || ''
      return `${emp || '员工'} · ${formData.periodStart || ''} ~ ${formData.periodEnd || ''} 工资`
    }
    if (template.key === 'expense') {
      return `${formData.expenseType || '费用'}报销 ${Number(formData.amount || 0)} 元`
    }
    return template.name
  }

  /** 导入工资条：填充周期起止 + 生成图片附件 */
  const importPayroll = async (notice) => {
    setImporting(true)
    setError('')
    try {
      const summary = notice.snapshot?.summary || {}
      const totalYuan = Number(summary.total || 0).toFixed(2)
      // 周期起止：月 → 1 日~月末；周 → 周一~周日；自定 → 直接取起止
      let start = ''
      let end = ''
      if (notice.periodType === 'custom') {
        const parts = String(notice.periodKey || '').split('~')
        start = parts[0] || ''
        end = parts[1] || ''
      } else if (notice.periodType === 'week') {
        const d = new Date(`${notice.periodKey}T00:00:00`)
        start = notice.periodKey
        const e = new Date(d)
        e.setDate(d.getDate() + 6)
        const m = String(e.getMonth() + 1).padStart(2, '0')
        const dd = String(e.getDate()).padStart(2, '0')
        end = `${e.getFullYear()}-${m}-${dd}`
      } else {
        const [y, m] = String(notice.periodKey).split('-').map(Number)
        start = `${notice.periodKey}-01`
        end = `${notice.periodKey}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`
      }
      setSlipNotice(notice)
      setFormData((s) => ({
        ...s,
        periodStart: start,
        periodEnd: end,
        store: notice.storeKey,
        employee: `${notice.storeKey}::${notice.employeeName}`,
        grossPay: totalYuan,
        netPay: totalYuan,
      }))
      // 等待 DOM 更新（表单 + 隐藏工资条卡片）后再截图上传
      await new Promise((r) => setTimeout(r, 400))
      if (slipCardRef.current) {
        const dataUrl = await toPng(slipCardRef.current, { pixelRatio: 2, cacheBust: true })
        const fname = `工资条-${notice.employeeName}-${periodLabel(notice.periodType, notice.periodKey)}.png`
        const res = await api('/v2/approvals/attachments', {
          method: 'POST',
          body: JSON.stringify({ name: fname, fileType: 'image/png', dataUrl }),
        })
        setAttachments((prev) => [...(prev || []).filter((a) => !a.name.startsWith('工资条-')), { ...res.attachment, dataUrl }])
      }
    } catch (e) {
      setError(e.message || '导入工资条失败')
    } finally {
      setImporting(false)
    }
  }

  /** 提交/保存草稿 */
  const save = async (submit) => {
    setBusy(true)
    setError('')
    // 前端校验周期起止
    if (template.key === 'payroll') {
      const s = String(formData.periodStart || '')
      const e = String(formData.periodEnd || '')
      if (s && e && s > e) {
        setError('周期开始不能晚于周期结束')
        setBusy(false)
        return
      }
    }
    try {
      const payload = {
        templateKey: template.key,
        formData,
        attachmentIds: attachments.map((a) => a.id),
        ccUsernames: extraCc,
        title: buildTitle(),
        submit,
      }
      const res = initial
        ? await api(`/v2/approvals/requests/${initial.request.id}`, {
            method: 'PUT',
            body: JSON.stringify({ formData, attachmentIds: payload.attachmentIds, ccUsernames: extraCc, title: payload.title }),
          })
        : await api('/v2/approvals/requests', { method: 'POST', body: JSON.stringify(payload) })
      if (submit && initial) {
        await api(`/v2/approvals/requests/${initial.request.id}/submit`, { method: 'POST' })
      }
      if (submit) {
        // 服务端真实成功后才播放卡皮巴拉动画（工资/报销审批提交）
        setFeedback(
          template.key === 'payroll'
            ? { title: t('工资审批已提交'), description: t('等待审批') }
            : { title: t('报销审批已提交'), description: t('等待审批') },
        )
      }
      onSaved?.(res.request || initial, submit)
    } catch (e) {
      setError(e.message || '保存失败')
    } finally {
      setBusy(false)
    }
  }

  /** 行点击：选择型字段打开选择器 */
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
      case 'bankCard': {
        // 银行卡信息组：银行名 / 支行名 / 卡号 独立展示；来源提示显示在最后一个字段下
        const idx = schema.indexOf(field)
        const isLastBank = !schema[idx + 1] || schema[idx + 1].type !== 'bankCard'
        const hasEmployee = Boolean(String(formData.employee || '').split('::')[1])
        return (
          <div key={field.key}>
            <InputFieldRow
              label={field.label}
              required={field.required}
              value={value}
              onChange={setField(field.key)}
              placeholder={bankInfo ? '可修改' : '自动代入自员工档案，未填写可留空'}
              maxLength={100}
            />
            {isLastBank && hasEmployee && (
              <p className="px-4 py-1.5 text-[11px] text-slate-400">
                {bankInfo
                  ? `信息来源员工档案${bankInfo.cardLast4 ? ` · 尾号 ${bankInfo.cardLast4}` : ''}${bankInfo.isPayroll ? ' · 工资卡' : ''}`
                  : '员工档案暂无银行卡信息，可手动填写（不强制）'}
              </p>
            )}
          </div>
        )
      }
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

  // 工资审批：选中员工后展示已签收工资条选择（表单字段下方）
  const empName = String(formData.employee || '').split('::')[1] || ''
  const showPayrollPicker = template.key === 'payroll' && empName && Array.isArray(payrollNotices) && payrollNotices.length > 0

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

      {/* 表单主体 */}
      <div className="mx-auto w-full max-w-[860px] bg-white">
        {schema.map((f) => renderField(f))}

        {/* 已签收工资条导入（工资审批专用） */}
        {showPayrollPicker && (
          <div className="border-b border-slate-100 px-4 py-3">
            <p className="pb-2 text-xs font-semibold text-slate-400">导入已签收工资条（自动填充并生成图片附件）</p>
            <div className="space-y-1.5">
              {payrollNotices.map((n) => (
                <button
                  key={n.id}
                  onClick={() => importPayroll(n)}
                  disabled={importing}
                  className="flex w-full items-center justify-between gap-2 rounded-lg border border-slate-100 px-3 py-2 text-left transition hover:border-budu-200 hover:bg-budu-50/40 disabled:opacity-50"
                >
                  <span className="text-xs font-semibold text-slate-700">
                    {periodLabel(n.periodType, n.periodKey)}
                  </span>
                  <span className="text-xs font-bold tabular-nums text-budu-600">¥{Number(n.totalCents || 0) / 100}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 附件 */}
        <div className="border-b border-slate-100">
          <div className="flex min-h-[52px] items-center gap-3 px-4 py-2.5">
            <span className="w-[110px] shrink-0 text-[15px] text-slate-600">附件</span>
            <div className="min-w-0 flex-1">
              <AttachmentUploader attachments={attachments} onChange={setAttachments} />
            </div>
          </div>
        </div>

        {/* 审批流程（提交人只读 + 审批人 + 抄送人可添加） */}
        <FlowSection
          template={template}
          user={user}
          extraCc={extraCc}
          candidates={candidates}
          onAddCc={() => setPicker({ field: '', type: 'cc' })}
          onRemoveCc={(name) => setExtraCc((prev) => (prev || []).filter((x) => x !== name))}
          payrollNotices={showPayrollPicker ? payrollNotices : null}
        />
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
      {picker?.type === 'cc' && (
        <CcSheet
          open
          value={extraCc}
          exclude={user?.username}
          onChange={setExtraCc}
          onClose={() => setPicker(null)}
        />
      )}

      {/* 工资条图片生成卡片（隐藏，导入时截图） */}
      {template.key === 'payroll' && slipNotice && (
        <div style={{ position: 'fixed', left: -9999, top: 0, pointerEvents: 'none' }}>
          <div ref={slipCardRef} style={{ width: 760, background: '#fff', padding: 20 }}>
            <PayrollSlipCard
              employeeName={slipNotice.employeeName}
              periodText={periodLabel(slipNotice.periodType, slipNotice.periodKey)}
              snapshot={slipNotice.snapshot}
              full
            />
          </div>
        </div>
      )}
    </div>
  )
}
