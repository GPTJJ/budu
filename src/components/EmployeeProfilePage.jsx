// 员工档案（Employee Master Profile）：列表 + 详情
//
// 安全约定（与后端一致）：
// - 身份证号/银行卡号默认只显示掩码；完整号码须通过「查看完整号码」二次确认（角色白名单 + 审计）
// - 完整号码只在内存中短暂展示，绝不写入 localStorage / URL / console
// - 历史（调薪/调店/调岗/状态）只追加；离职 ≠ 删除
// - 空字段一律展示「暂未填写」
import { useCallback, useEffect, useState } from 'react'
import {
  ArrowLeft,
  Banknote,
  Briefcase,
  CalendarDays,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  FileText,
  History,
  IdCard,
  Landmark,
  Lock,
  Paperclip,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  UserRound,
  Users,
  X,
} from 'lucide-react'
import { api } from '../utils/api'
import BuduSuccessFeedback from './feedback/BuduSuccessFeedback'
import { storeName, allStores } from '../utils/selectors'
import { hasModuleAccess, MODULE_KEYS } from '../../shared/accountPermissions'

const MASKED = '****'
const EMPTY = '暂未填写'

const STATUS_META = {
  ACTIVE: { label: '在职', cls: 'bg-emerald-50 text-emerald-600' },
  PROBATION: { label: '试用期', cls: 'bg-sky-50 text-sky-600' },
  LEAVE: { label: '停薪留职', cls: 'bg-amber-50 text-amber-600' },
  SUSPENDED: { label: '停职', cls: 'bg-orange-50 text-orange-600' },
  RESIGNED: { label: '已离职', cls: 'bg-slate-100 text-slate-500' },
}

const EMPLOYMENT_TYPES = [
  { value: 'fulltime', label: '全职' },
  { value: 'parttime', label: '兼职' },
  { value: 'intern', label: '实习' },
  { value: 'temporary', label: '临时' },
]

const CONTRACT_TYPES = [
  { value: 'labor', label: '劳动合同' },
  { value: 'labor_dispatch', label: '劳务派遣' },
  { value: 'parttime', label: '非全日制' },
  { value: 'intern', label: '实习协议' },
  { value: 'other', label: '其他' },
]

const DOC_TYPES = [
  { value: 'id_card', label: '身份证复印件' },
  { value: 'bank_card', label: '银行卡复印件' },
  { value: 'contract', label: '劳动合同' },
  { value: 'resume', label: '简历' },
  { value: 'certificate', label: '证书' },
  { value: 'resignation', label: '离职材料' },
  { value: 'other', label: '其他' },
]

function fmtDate(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fmtDateTime(value) {
  if (!value) return ''
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function Field({ label, value, mono = false }) {
  const has = value !== undefined && value !== null && String(value).trim() !== ''
  return (
    <div>
      <p className="text-[11px] text-slate-400">{label}</p>
      <p className={`mt-0.5 break-all text-[13px] font-semibold text-slate-700 ${mono ? 'font-mono tabular-nums' : ''}`}>
        {has ? value : <span className="font-normal text-slate-300">{EMPTY}</span>}
      </p>
    </div>
  )
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { label: status || '未知', cls: 'bg-slate-100 text-slate-500' }
  return <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${meta.cls}`}>{meta.label}</span>
}

function SectionCard({ title, extra, children }) {
  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[15px] font-bold text-slate-800">{title}</h3>
        <div className="ml-auto flex items-center gap-2">{extra}</div>
      </div>
      <div className="mt-4">{children}</div>
    </div>
  )
}

function ConfirmDialog({ title, message, confirmText = '确认', danger = false, onConfirm, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-[98] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-start gap-3">
          <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${danger ? 'bg-rose-50 text-rose-500' : 'bg-budu-50 text-budu-600'}`}>
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-bold text-slate-800">{title}</h3>
            {message && <p className="mt-1 text-xs leading-relaxed text-slate-500">{message}</p>}
            {children}
          </div>
        </div>
        <div className="mt-5 flex gap-2.5">
          <button onClick={onClose} className="flex-1 rounded-xl bg-slate-100 py-2.5 text-sm font-semibold text-slate-600 transition hover:bg-slate-200">
            取消
          </button>
          <button
            onClick={onConfirm}
            className={`flex-1 rounded-xl py-2.5 text-sm font-bold text-white shadow-sm transition hover:opacity-90 ${
              danger ? 'bg-rose-500' : 'bg-budu-500'
            }`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

function InlineInput({ label, value, onChange, placeholder = '', type = 'text', className = '', required = false }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-[11px] font-semibold text-slate-500">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        className="input w-full"
      />
    </label>
  )
}

function InlineSelect({ label, value, onChange, options, className = '', placeholder = '' }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-[11px] font-semibold text-slate-500">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="input w-full">
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  )
}

/** 敏感号码展示区：掩码 ↔ 完整号码（完整号码须二次确认 reveal，仅在内存中） */
function SensitiveNumber({
  masked,
  revealed,
  onReveal,
  canReveal,
  revealTitle,
  revealMessage,
  revealLabel = '查看完整号码',
  details = null,
  status = null,
  variant = 'default',
}) {
  const [confirming, setConfirming] = useState(false)
  const [showFull, setShowFull] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleReveal = async () => {
    try {
      await onReveal()
      setShowFull(true)
      setConfirming(false)
    } catch (e) {
      setConfirming(false)
      alert(e.message)
    }
  }

  const copyFull = () => {
    if (!revealed) return
    navigator.clipboard?.writeText(revealed).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  const display = showFull && revealed ? revealed : masked || MASKED

  const visibilityControl = !showFull && canReveal ? (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="flex min-h-9 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-budu-50 px-2.5 py-1.5 text-[11px] font-bold text-budu-600 transition hover:bg-budu-100"
    >
      <Eye className="h-3.5 w-3.5" /> {revealLabel}
    </button>
  ) : showFull ? (
    <button
      type="button"
      onClick={() => setShowFull(false)}
      className="flex min-h-9 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-slate-500 transition hover:bg-slate-200"
    >
      <EyeOff className="h-3.5 w-3.5" /> 隐藏
    </button>
  ) : null

  const auditNotice = (
    <span
      data-testid={variant === 'bank' ? 'bank-card-audit-notice' : undefined}
      className="flex min-w-0 items-start gap-1 text-[10px] leading-4 text-slate-300"
    >
      <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0" />
      <span>查看将记录审计日志</span>
    </span>
  )

  const numberDisplay = (
    <div
      data-testid={variant === 'bank' ? 'bank-card-number-row' : undefined}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2"
    >
      <span
        data-testid={variant === 'bank' ? 'bank-card-number' : undefined}
        className={`min-w-0 break-words font-mono text-[13px] font-bold leading-5 tracking-wide text-slate-800 [overflow-wrap:anywhere] ${showFull ? 'text-budu-700' : ''}`}
      >
        {display}
      </span>
      {showFull && revealed && (
        <button
          type="button"
          data-testid={variant === 'bank' ? 'bank-card-copy' : undefined}
          onClick={copyFull}
          className="flex min-h-9 min-w-14 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-500 transition hover:bg-slate-200"
        >
          <Copy className="h-3 w-3" /> {copied ? '已复制' : '复制'}
        </button>
      )}
    </div>
  )

  return (
    <div className={variant === 'bank' ? 'min-w-0' : ''}>
      {variant === 'bank' ? (
        <div className="grid min-w-0 grid-cols-1 gap-y-3 sm:grid-cols-[minmax(0,1.35fr)_minmax(7rem,0.65fr)] sm:gap-x-6">
          {numberDisplay}
          {details}
          <div data-testid="bank-card-actions" className="flex min-w-0 flex-wrap items-center gap-2 sm:col-span-2">
            {visibilityControl}
            {!canReveal && masked && (
              <span className="flex min-w-0 items-center gap-1 text-[11px] leading-4 text-slate-400">
                <Lock className="h-3 w-3 shrink-0" /> 无查看完整号码权限
              </span>
            )}
            {status}
          </div>
          <div className="min-w-0 sm:col-span-2">{auditNotice}</div>
        </div>
      ) : (
        <>
          {numberDisplay}
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
            {visibilityControl}
            {!canReveal && masked && (
              <span className="flex min-w-0 items-center gap-1 text-[11px] leading-4 text-slate-400">
                <Lock className="h-3 w-3 shrink-0" /> 无查看完整号码权限
              </span>
            )}
            {auditNotice}
          </div>
        </>
      )}
      {confirming && (
        <ConfirmDialog
          title={revealTitle}
          message={revealMessage}
          confirmText="确认查看"
          onConfirm={handleReveal}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  )
}

// ---------------- 主页面 ----------------

export default function EmployeeProfilePage({ user, onBack, initialQuery = '', initialId = '' }) {
  const canEdit = ['developer', 'admin', 'finance'].includes(user?.role)
  const canRevealIdentity = ['developer', 'admin'].includes(user?.role)
  const canRevealBank = ['developer', 'admin', 'finance'].includes(user?.role)
  const hasModule = hasModuleAccess(user, MODULE_KEYS.EMPLOYEE_PROFILE)

  const [rows, setRows] = useState(null)
  const [q, setQ] = useState(initialQuery)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedId, setSelectedId] = useState(initialId || '')
  // 跳转直达详情只触发一次：返回列表后不再因 initialQuery 自动跳回
  const [autoOpened, setAutoOpened] = useState(Boolean(initialId))

  const loadList = useCallback(async (query = q) => {
    setLoading(true)
    setError('')
    try {
      const data = await api(`/v2/employees${query ? `?q=${encodeURIComponent(query)}` : ''}`)
      setRows(data.rows || [])
    } catch (e) {
      setError(e.message)
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [q])

  useEffect(() => {
    if (!hasModule) return
    // Gate 7：已带稳定 Employee.id 时无需搜索，直接渲染对应档案；否则保持姓名/编号搜索
    if (initialId) {
      setSelectedId(initialId)
      setAutoOpened(true)
      return undefined
    }
    loadList(initialQuery)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasModule])

  // 初始查询（从人员管理/工资条跳转）命中唯一员工时直接进入详情；
  // 仅首次生效，且进入详情后清空搜索词，返回列表时展示全部员工
  useEffect(() => {
    if (autoOpened || !initialQuery || !rows || rows.length !== 1 || selectedId) return
    setSelectedId(rows[0].id)
    setAutoOpened(true)
    setQ('')
  }, [autoOpened, initialQuery, rows, selectedId])

  const handleSearch = (e) => {
    e.preventDefault()
    loadList(q)
  }

  const goBack = () => {
    if (selectedId) {
      setSelectedId('')
      loadList(q)
    } else {
      onBack?.()
    }
  }

  if (!hasModule) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <div className="card grid place-items-center py-20 text-center">
          <p className="text-sm text-slate-400">无权限访问员工档案</p>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <button onClick={goBack} className="grid h-9 w-9 place-items-center rounded-xl bg-white text-slate-500 shadow-card transition hover:text-budu-600">
          <ArrowLeft className="h-4.5 w-4.5" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold text-slate-800">员工档案</h2>
          <p className="text-xs text-slate-400">
            {selectedId ? '档案详情 · 敏感字段加密存储，查看完整号码将记录审计' : '唯一员工主档 · 身份/银行卡加密保护'}
          </p>
        </div>
      </div>

      {error && <p className="mb-4 rounded-xl bg-rose-50 px-4 py-2.5 text-sm text-rose-600">{error}</p>}

      {selectedId ? (
        <EmployeeDetail
          key={selectedId}
          employeeId={selectedId}
          user={user}
          canEdit={canEdit}
          canRevealIdentity={canRevealIdentity}
          canRevealBank={canRevealBank}
          onBackToList={() => {
            setSelectedId('')
            loadList(q)
          }}
        />
      ) : (
        <EmployeeList
          rows={rows}
          loading={loading}
          q={q}
          setQ={setQ}
          onSearch={handleSearch}
          onSelect={setSelectedId}
          canEdit={canEdit}
          onRefetch={() => loadList(q)}
        />
      )}
    </div>
  )
}

// ---------------- 列表 ----------------

function EmployeeList({ rows, loading, q, setQ, onSearch, onSelect, canEdit, onRefetch }) {
  return (
    <>
      <form onSubmit={onSearch} className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-300" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索姓名 / 员工编号 / 手机号"
            className="input w-full pl-9"
          />
        </div>
        <button type="submit" className="rounded-xl bg-budu-500 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:opacity-90">
          搜索
        </button>
        {canEdit && (
          <button
            type="button"
            onClick={onRefetch}
            className="rounded-xl bg-white px-3 py-2.5 text-sm font-semibold text-slate-500 shadow-card transition hover:text-budu-600"
            title="从现有员工名单回填档案（重复执行自动跳过已建档员工）"
          >
            回填档案
          </button>
        )}
      </form>

      <div className="mt-5">
        {loading && !rows ? (
          <div className="card grid place-items-center py-16 text-sm text-slate-300">加载中…</div>
        ) : !rows || rows.length === 0 ? (
          <div className="card grid place-items-center py-16 text-center">
            <Users className="mb-2 h-8 w-8 text-slate-200" />
            <p className="text-sm text-slate-400">{q ? '未找到匹配的员工' : '暂无员工档案'}</p>
            {!q && canEdit && (
              <p className="mt-1 text-xs text-slate-300">点击右上角「回填档案」从现有员工名单生成主档</p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((r) => (
              <button
                key={r.id}
                onClick={() => onSelect(r.id)}
                className="card group relative cursor-pointer p-4 text-left transition duration-300 hover:-translate-y-0.5 hover:shadow-card-hover"
              >
                <div className="flex items-center gap-3">
                  <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-budu-50 text-base font-bold text-budu-600">
                    {r.name[0]}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 truncate text-[15px] font-bold text-slate-800">
                      {r.name}
                      <StatusBadge status={r.status} />
                    </p>
                    <p className="mt-0.5 truncate text-xs text-slate-400">
                      {r.employeeNo} · {storeName(r.currentStoreKey)}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-slate-200 transition group-hover:text-budu-400" />
                </div>
                <div className="mt-3 flex items-center gap-3 border-t border-slate-50 pt-2.5 text-[11px] text-slate-400">
                  {r.position && <span>{r.position}</span>}
                  {r.employmentType && (
                    <span className="rounded-md bg-slate-50 px-1.5 py-0.5 font-bold text-slate-500">
                      {EMPLOYMENT_TYPES.find((x) => x.value === r.employmentType)?.label || r.employmentType}
                    </span>
                  )}
                  {r.phone && <span className="ml-auto font-mono text-slate-300">{r.phone}</span>}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

// ---------------- 详情 ----------------

function EmployeeDetail({ employeeId, user, canEdit, canRevealIdentity, canRevealBank, onBackToList }) {
  const [employee, setEmployee] = useState(null)
  const [tab, setTab] = useState('basic')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const [feedback, setFeedback] = useState(null)

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await api(`/v2/employees/${employeeId}/profile`)
      setEmployee(data.employee)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [employeeId])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  const notify = (msg) => {
    // DA 后统一成功反馈：员工资料保存成功 → 卡皮巴拉动画
    setSaved(msg)
    setTimeout(() => setSaved(''), 2500)
    // 保留具体操作语义（如“已离职（履历已记录）”），避免统一动效把关键结果吞掉。
    setFeedback({ title: msg, description: '员工资料已更新' })
  }

  if (loading && !employee) {
    return <div className="card grid place-items-center py-20 text-sm text-slate-300">加载中…</div>
  }
  if (!employee) {
    return (
      <div className="card grid place-items-center py-20 text-center">
        <p className="text-sm text-slate-400">{error || '员工不存在'}</p>
        <button onClick={onBackToList} className="mt-3 text-xs font-bold text-budu-600">返回列表</button>
      </div>
    )
  }

  const tabs = [
    { key: 'basic', label: '基本信息', icon: UserRound },
    { key: 'employment', label: '任职信息', icon: Briefcase },
    { key: 'identity', label: '身份信息', icon: IdCard },
    { key: 'bank', label: '银行卡', icon: Landmark },
    { key: 'contract', label: '合同', icon: FileText },
    { key: 'timeline', label: '履历时间线', icon: History },
    { key: 'summary', label: '工资考勤', icon: Banknote },
    { key: 'documents', label: '附件', icon: Paperclip },
  ]

  return (
    <div>
      {feedback && (
        <BuduSuccessFeedback
          open={!!feedback}
          title={feedback.title}
          description={feedback.description}
          onClose={() => setFeedback(null)}
        />
      )}

      {/* 头部信息 */}
      <div className="card flex flex-wrap items-center gap-4 p-5">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-budu-50 text-xl font-bold text-budu-600">
          {employee.name[0]}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-bold text-slate-800">{employee.name}</h3>
            <StatusBadge status={employee.status} />
            {employee.employmentType && (
              <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">
                {EMPLOYMENT_TYPES.find((x) => x.value === employee.employmentType)?.label || employee.employmentType}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-slate-400">
            {employee.employeeNo}
            {employee.position ? ` · ${employee.position}` : ''}
            {employee.level ? ` · ${employee.level}` : ''}
            {employee.currentStoreKey ? ` · ${storeName(employee.currentStoreKey)}` : ''}
            {employee.hireDate ? ` · 入职 ${fmtDate(employee.hireDate)}` : ''}
          </p>
        </div>
        <button
          onClick={onBackToList}
          className="rounded-xl bg-slate-50 px-3 py-2 text-xs font-bold text-slate-500 transition hover:bg-slate-100"
        >
          返回列表
        </button>
      </div>

      {/* Tab 导航 */}
      <div className="mt-4 flex gap-1.5 overflow-x-auto pb-1">
        {tabs.map((t) => {
          const Icon = t.icon
          const active = tab === t.key
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold transition ${
                active ? 'bg-budu-500 text-white shadow-sm' : 'bg-white text-slate-500 shadow-card hover:text-budu-600'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          )
        })}
      </div>

      {error && <p className="mt-3 rounded-xl bg-rose-50 px-4 py-2.5 text-sm text-rose-600">{error}</p>}

      <div className="mt-4 space-y-4">
        {tab === 'basic' && (
          <BasicTab
            employee={employee}
            canEdit={canEdit}
            onSaved={(msg) => {
              notify(msg)
              loadAll()
            }}
            onError={setError}
          />
        )}
        {tab === 'employment' && (
          <EmploymentTab
            employee={employee}
            canEdit={canEdit}
            onSaved={(msg) => {
              notify(msg)
              loadAll()
            }}
            onError={setError}
          />
        )}
        {tab === 'identity' && (
          <IdentityTab employeeId={employeeId} canEdit={canEdit} canReveal={canRevealIdentity} />
        )}
        {tab === 'bank' && (
          <BankTab employeeId={employeeId} employeeName={employee.name} canEdit={canEdit} canReveal={canRevealBank} />
        )}
        {tab === 'contract' && <ContractTab employeeId={employeeId} canEdit={canEdit} />}
        {tab === 'timeline' && <TimelineTab employeeId={employeeId} />}
        {tab === 'summary' && <SummaryTab employeeId={employeeId} />}
        {tab === 'documents' && <DocumentsTab employeeId={employeeId} canEdit={canEdit} />}
      </div>
    </div>
  )
}

// ---------------- 基本信息 ----------------

function BasicTab({ employee, canEdit, onSaved, onError }) {
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({})
  const [saving, setSaving] = useState(false)
  const p = employee.profile || {}

  const startEdit = () => {
    setForm({
      gender: p.gender || '',
      birthDate: fmtDate(p.birthDate),
      phone: p.phone || '',
      backupPhone: p.backupPhone || '',
      email: p.email || '',
      wechat: p.wechat || '',
      nationality: p.nationality || '',
      city: p.city || '',
      address: p.address || '',
      emergencyName: p.emergency?.name || '',
      emergencyRelation: p.emergency?.relation || '',
      emergencyPhone: p.emergency?.phone || '',
    })
    setEditing(true)
  }

  const save = async () => {
    setSaving(true)
    try {
      await api(`/v2/employees/${employee.id}/profile`, {
        method: 'PUT',
        body: JSON.stringify({
          ...form,
          birthDate: form.birthDate || null,
          backupPhone: form.backupPhone,
        }),
      })
      setEditing(false)
      onSaved('基本资料已保存')
    } catch (e) {
      onError(e.message)
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <SectionCard
        title="编辑基本资料"
        extra={
          <>
            <button onClick={() => setEditing(false)} className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-bold text-slate-500 transition hover:bg-slate-200">
              取消
            </button>
            <button onClick={save} disabled={saving} className="rounded-xl bg-budu-500 px-3 py-2 text-xs font-bold text-white shadow-sm transition hover:opacity-90 disabled:opacity-50">
              {saving ? '保存中…' : '保存'}
            </button>
          </>
        }
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <InlineSelect
            label="性别"
            value={form.gender}
            onChange={(v) => setForm((s) => ({ ...s, gender: v }))}
            options={[{ value: '男', label: '男' }, { value: '女', label: '女' }, { value: '其他', label: '其他' }]}
            placeholder="未填写"
          />
          <InlineInput label="出生日期" type="date" value={form.birthDate} onChange={(v) => setForm((s) => ({ ...s, birthDate: v }))} />
          <InlineInput label="手机号" value={form.phone} onChange={(v) => setForm((s) => ({ ...s, phone: v }))} placeholder="11 位手机号" />
          <InlineInput label="备用手机" value={form.backupPhone} onChange={(v) => setForm((s) => ({ ...s, backupPhone: v }))} />
          <InlineInput label="邮箱" type="email" value={form.email} onChange={(v) => setForm((s) => ({ ...s, email: v }))} />
          <InlineInput label="微信" value={form.wechat} onChange={(v) => setForm((s) => ({ ...s, wechat: v }))} />
          <InlineInput label="民族" value={form.nationality} onChange={(v) => setForm((s) => ({ ...s, nationality: v }))} />
          <InlineInput label="城市" value={form.city} onChange={(v) => setForm((s) => ({ ...s, city: v }))} />
          <InlineInput label="通讯地址" value={form.address} onChange={(v) => setForm((s) => ({ ...s, address: v }))} className="sm:col-span-2" />
        </div>
        <div className="mt-4 rounded-xl bg-slate-50 p-3.5">
          <p className="text-[11px] font-bold text-slate-500">紧急联系人</p>
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <InlineInput label="姓名" value={form.emergencyName} onChange={(v) => setForm((s) => ({ ...s, emergencyName: v }))} />
            <InlineInput label="关系" value={form.emergencyRelation} onChange={(v) => setForm((s) => ({ ...s, emergencyRelation: v }))} />
            <InlineInput label="电话" value={form.emergencyPhone} onChange={(v) => setForm((s) => ({ ...s, emergencyPhone: v }))} />
          </div>
        </div>
      </SectionCard>
    )
  }

  return (
    <SectionCard
      title="基本信息"
      extra={
        canEdit && (
          <button onClick={startEdit} className="rounded-xl bg-budu-50 px-3 py-2 text-xs font-bold text-budu-600 transition hover:bg-budu-100">
            编辑
          </button>
        )
      }
    >
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <Field label="性别" value={p.gender} />
        <Field label="出生日期" value={fmtDate(p.birthDate)} />
        <Field label="手机号" value={p.phone} mono />
        <Field label="备用手机" value={p.backupPhone} mono />
        <Field label="邮箱" value={p.email} />
        <Field label="微信" value={p.wechat} />
        <Field label="民族" value={p.nationality} />
        <Field label="城市" value={p.city} />
        <Field label="通讯地址" value={p.address} />
      </div>
      <div className="mt-4 rounded-xl bg-slate-50 p-3.5">
        <p className="text-[11px] font-bold text-slate-500">紧急联系人</p>
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Field label="姓名" value={p.emergency?.name} />
          <Field label="关系" value={p.emergency?.relation} />
          <Field label="电话" value={p.emergency?.phone} mono />
        </div>
      </div>
    </SectionCard>
  )
}

// ---------------- 任职信息 ----------------

function EmploymentTab({ employee, canEdit, onSaved, onError }) {
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({})
  const [saving, setSaving] = useState(false)

  const startEdit = () => {
    setForm({
      currentStoreKey: employee.currentStoreKey || '',
      position: employee.position || '',
      level: employee.level || '',
      employmentType: employee.employmentType || 'fulltime',
      hireDate: fmtDate(employee.hireDate),
      effectiveDate: fmtDate(new Date()),
      reason: '',
    })
    setEditing(true)
  }

  const save = async () => {
    setSaving(true)
    try {
      await api(`/v2/employees/${employee.id}/employment`, {
        method: 'PUT',
        body: JSON.stringify({
          ...form,
          hireDate: form.hireDate || null,
          effectiveDate: form.effectiveDate || null,
        }),
      })
      setEditing(false)
      onSaved('任职信息已保存（变更已记入履历）')
    } catch (e) {
      onError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <SectionCard
      title="任职信息"
      extra={
        canEdit && !editing && (
          <button onClick={startEdit} className="rounded-xl bg-budu-50 px-3 py-2 text-xs font-bold text-budu-600 transition hover:bg-budu-100">
            编辑（变更自动记入履历）
          </button>
        )
      }
    >
      {editing ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <InlineSelect
            label="所属门店"
            value={form.currentStoreKey}
            onChange={(v) => setForm((s) => ({ ...s, currentStoreKey: v }))}
            options={allStores().map((s) => ({ value: s.key, label: s.name }))}
            placeholder="选择门店"
          />
          <InlineSelect
            label="用工类型"
            value={form.employmentType}
            onChange={(v) => setForm((s) => ({ ...s, employmentType: v }))}
            options={EMPLOYMENT_TYPES}
          />
          <InlineInput label="岗位" value={form.position} onChange={(v) => setForm((s) => ({ ...s, position: v }))} placeholder="如：店员 / 店长" />
          <InlineInput label="职级" value={form.level} onChange={(v) => setForm((s) => ({ ...s, level: v }))} placeholder="如：初级 / 资深" />
          <InlineInput label="入职日期" type="date" value={form.hireDate} onChange={(v) => setForm((s) => ({ ...s, hireDate: v }))} />
          <InlineInput label="变更生效日期" type="date" value={form.effectiveDate} onChange={(v) => setForm((s) => ({ ...s, effectiveDate: v }))} />
          <InlineInput
            label="变更原因（将记入履历）"
            value={form.reason}
            onChange={(v) => setForm((s) => ({ ...s, reason: v }))}
            placeholder="如：调入 XX 店 / 晋升"
            className="sm:col-span-2"
          />
          <div className="flex gap-2.5 sm:col-span-2">
            <button onClick={() => setEditing(false)} className="rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-bold text-slate-500 transition hover:bg-slate-200">
              取消
            </button>
            <button onClick={save} disabled={saving} className="rounded-xl bg-budu-500 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:opacity-90 disabled:opacity-50">
              {saving ? '保存中…' : '保存并记入履历'}
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Field label="员工编号" value={employee.employeeNo} mono />
          <Field label="所属门店" value={storeName(employee.currentStoreKey)} />
          <Field label="用工类型" value={EMPLOYMENT_TYPES.find((x) => x.value === employee.employmentType)?.label || employee.employmentType} />
          <Field label="岗位" value={employee.position} />
          <Field label="职级" value={employee.level} />
          <Field label="入职日期" value={fmtDate(employee.hireDate)} />
        </div>
      )}

      {/* 在职状态操作 */}
      <div className="mt-5 border-t border-slate-100 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[11px] font-bold text-slate-500">在职状态</p>
          <StatusBadge status={employee.status} />
          {canEdit && (
            <div className="ml-auto flex flex-wrap gap-1.5">
              {employee.status === 'RESIGNED' ? (
                <StatusActionButton
                  action="REHIRE"
                  label="返聘"
                  confirmTitle="确认返聘该员工？"
                  confirmMessage="返聘将把在职状态恢复为「在职」并记入履历，不创建新档案。"
                  employeeId={employee.id}
                  onDone={onSaved}
                  onError={onError}
                />
              ) : (
                <>
                  {employee.status === 'PROBATION' && (
                    <StatusActionButton
                      action="PROBATION_PASS"
                      label="转正"
                      confirmTitle="确认转正？"
                      confirmMessage="转正后将把状态更新为「在职」并记入履历。"
                      employeeId={employee.id}
                      onDone={onSaved}
                      onError={onError}
                    />
                  )}
                  <StatusActionButton
                    action="RESIGN"
                    label="离职"
                    danger
                    confirmTitle="确认办理离职？"
                    confirmMessage="离职 ≠ 删除：档案与全部历史保留，仅标记为「已离职」。请如实填写离职信息。"
                    employeeId={employee.id}
                    onDone={onSaved}
                    onError={onError}
                  />
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </SectionCard>
  )
}

function StatusActionButton({ action, label, danger = false, confirmTitle, confirmMessage, employeeId, onDone, onError }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ effectiveDate: fmtDate(new Date()) })
  const [saving, setSaving] = useState(false)

  const isResign = action === 'RESIGN'

  const submit = async () => {
    setSaving(true)
    try {
      await api(`/v2/employees/${employeeId}/status-change`, {
        method: 'POST',
        body: JSON.stringify({ action, ...form }),
      })
      setOpen(false)
      onDone?.(`已${label}（履历已记录）`)
    } catch (e) {
      onError?.(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={`rounded-xl px-3 py-2 text-xs font-bold shadow-sm transition hover:opacity-90 ${
          danger ? 'bg-rose-50 text-rose-600 hover:bg-rose-100' : 'bg-budu-50 text-budu-600 hover:bg-budu-100'
        }`}
      >
        {label}
      </button>
      {open && (
        <ConfirmDialog
          title={confirmTitle}
          message={confirmMessage}
          confirmText={saving ? '提交中…' : `确认${label}`}
          danger={danger}
          onConfirm={submit}
          onClose={() => setOpen(false)}
        >
          {isResign && (
            <div className="mt-3 space-y-2.5">
              <InlineInput label="离职生效日期" type="date" value={form.effectiveDate} onChange={(v) => setForm((s) => ({ ...s, effectiveDate: v }))} />
              <InlineInput label="离职类型" value={form.resignType || ''} onChange={(v) => setForm((s) => ({ ...s, resignType: v }))} placeholder="主动 / 协商 / 辞退" />
              <InlineInput label="离职原因" value={form.resignReason || ''} onChange={(v) => setForm((s) => ({ ...s, resignReason: v }))} placeholder="选填，将记入履历" />
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-500">
                <input type="checkbox" checked={form.salarySettled === true} onChange={(e) => setForm((s) => ({ ...s, salarySettled: e.target.checked }))} />
                薪资已结清
              </label>
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-500">
                <input type="checkbox" checked={form.propertyReturned === true} onChange={(e) => setForm((s) => ({ ...s, propertyReturned: e.target.checked }))} />
                物品已归还
              </label>
            </div>
          )}
        </ConfirmDialog>
      )}
    </>
  )
}

// ---------------- 身份信息 ----------------

function IdentityTab({ employeeId, canEdit, canReveal }) {
  const [data, setData] = useState(null)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [revealed, setRevealed] = useState('')

  const load = useCallback(async () => {
    try {
      setData(await api(`/v2/employees/${employeeId}/identity`))
    } catch (e) {
      setError(e.message)
    }
  }, [employeeId])

  useEffect(() => {
    load()
  }, [load])

  const reveal = async () => {
    const r = await api(`/v2/employees/${employeeId}/identity/reveal`, { method: 'POST' })
    setRevealed(r.idNumber)
  }

  const startEdit = () => {
    setForm({
      idType: data?.idType || 'identity',
      idNumber: '',
      idExpiryDate: fmtDate(data?.idExpiryDate),
      idPermanent: data?.idPermanent || false,
    })
    setEditing(true)
  }

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      await api(`/v2/employees/${employeeId}/identity`, {
        method: 'PUT',
        body: JSON.stringify({
          ...form,
          idNumber: form.idNumber.trim(),
          idExpiryDate: form.idPermanent ? null : form.idExpiryDate || null,
        }),
      })
      setEditing(false)
      setRevealed('')
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <SectionCard
      title="身份信息"
      extra={
        canEdit && !editing && (
          <button onClick={startEdit} className="rounded-xl bg-budu-50 px-3 py-2 text-xs font-bold text-budu-600 transition hover:bg-budu-100">
            编辑
          </button>
        )
      }
    >
      {error && <p className="mb-3 rounded-xl bg-rose-50 px-4 py-2.5 text-sm text-rose-600">{error}</p>}

      {editing ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <InlineSelect
            label="证件类型"
            value={form.idType}
            onChange={(v) => setForm((s) => ({ ...s, idType: v }))}
            options={[{ value: 'identity', label: '身份证' }, { value: 'passport', label: '护照' }, { value: 'other', label: '其他' }]}
          />
          <InlineInput
            label={form.idType === 'identity' ? '身份证号码（18 位）' : '证件号码'}
            value={form.idNumber}
            onChange={(v) => setForm((s) => ({ ...s, idNumber: v }))}
            placeholder="留空则不修改已保存号码"
            mono
          />
          {form.idType === 'identity' && (
            <>
              <InlineInput label="证件有效期至" type="date" value={form.idExpiryDate} onChange={(v) => setForm((s) => ({ ...s, idExpiryDate: v }))} />
              <label className="flex items-end gap-2 pb-2.5 text-xs font-semibold text-slate-500">
                <input type="checkbox" checked={form.idPermanent === true} onChange={(e) => setForm((s) => ({ ...s, idPermanent: e.target.checked, idExpiryDate: '' }))} />
                长期有效
              </label>
            </>
          )}
          <div className="flex gap-2.5 sm:col-span-2">
            <button onClick={() => setEditing(false)} className="rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-bold text-slate-500 transition hover:bg-slate-200">
              取消
            </button>
            <button onClick={save} disabled={saving} className="rounded-xl bg-budu-500 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:opacity-90 disabled:opacity-50">
              {saving ? '保存中…' : '保存（加密存储）'}
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <p className="text-[11px] text-slate-400">证件类型</p>
            <p className="mt-0.5 text-[13px] font-semibold text-slate-700">
              {{ identity: '身份证', passport: '护照', other: '其他' }[data?.idType] || '身份证'}
            </p>
          </div>
          <div>
            <p className="text-[11px] text-slate-400">证件号码（加密存储）</p>
            <div className="mt-1">
              <SensitiveNumber
                masked={data?.idMasked}
                revealed={revealed}
                onReveal={reveal}
                canReveal={canReveal}
                revealTitle="查看完整身份证号码"
                revealMessage="此操作将解密显示完整身份证号码，并记录一条审计日志（操作人/时间）。请确认仅用于必要场景。"
              />
            </div>
          </div>
          <div>
            <p className="text-[11px] text-slate-400">证件有效期至</p>
            <p className="mt-0.5 text-[13px] font-semibold text-slate-700">
              {data?.idPermanent ? '长期有效' : fmtDate(data?.idExpiryDate) || <span className="font-normal text-slate-300">{EMPTY}</span>}
            </p>
          </div>
        </div>
      )}
    </SectionCard>
  )
}

// ---------------- 银行卡 ----------------

function BankTab({ employeeId, employeeName, canEdit, canReveal }) {
  const [data, setData] = useState({ bank: [] })
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [revealed, setRevealed] = useState('')
  const [revealTarget, setRevealTarget] = useState(null)

  const load = useCallback(async () => {
    try {
      setData(await api(`/v2/employees/${employeeId}/bank-account`))
    } catch (e) {
      setError(e.message)
    }
  }, [employeeId])

  useEffect(() => {
    load()
  }, [load])

  const reveal = async () => {
    const r = await api(`/v2/employees/${employeeId}/bank-account/reveal`, { method: 'POST' })
    setRevealed(r.cardNumber)
  }

  const startEdit = () => {
    const first = data.bank[0] || {}
    setForm({
      id: first.id || '',
      bankName: first.bankName || '',
      accountName: first.accountName || employeeName,
      cardNumber: '',
      bankBranch: first.bankBranch || '',
      isPayroll: true,
    })
    setEditing(true)
  }

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      await api(`/v2/employees/${employeeId}/bank-account`, {
        method: 'PUT',
        body: JSON.stringify({ ...form, cardNumber: form.cardNumber.trim() }),
      })
      setEditing(false)
      setRevealed('')
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <SectionCard
      title="工资银行卡"
      extra={
        canEdit && !editing && (
          <button type="button" onClick={startEdit} className="shrink-0 whitespace-nowrap rounded-xl bg-budu-50 px-3 py-2 text-xs font-bold text-budu-600 transition hover:bg-budu-100">
            {data.bank.length ? '更新' : '登记银行卡'}
          </button>
        )
      }
    >
      {error && <p className="mb-3 rounded-xl bg-rose-50 px-4 py-2.5 text-sm text-rose-600">{error}</p>}

      {editing ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <InlineInput label="开户银行" value={form.bankName} onChange={(v) => setForm((s) => ({ ...s, bankName: v }))} placeholder="如：中国工商银行" />
          <InlineInput label="持卡人姓名" value={form.accountName} onChange={(v) => setForm((s) => ({ ...s, accountName: v }))} />
          <InlineInput label="银行卡号" value={form.cardNumber} onChange={(v) => setForm((s) => ({ ...s, cardNumber: v }))} placeholder="8-25 位卡号" mono />
          <InlineInput label="开户支行" value={form.bankBranch} onChange={(v) => setForm((s) => ({ ...s, bankBranch: v }))} placeholder="选填" />
          <label className="flex items-center gap-2 pb-2.5 text-xs font-semibold text-slate-500">
            <input type="checkbox" checked={form.isPayroll === true} onChange={(e) => setForm((s) => ({ ...s, isPayroll: e.target.checked }))} />
            设为工资卡
          </label>
          <div className="flex flex-col gap-2.5 sm:flex-row">
            <button type="button" onClick={() => setEditing(false)} className="w-full whitespace-nowrap rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-bold text-slate-500 transition hover:bg-slate-200 sm:w-auto">
              取消
            </button>
            <button type="button" onClick={save} disabled={saving} className="w-full whitespace-nowrap rounded-xl bg-budu-500 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:opacity-90 disabled:opacity-50 sm:w-auto">
              {saving ? '保存中…' : '保存（加密存储）'}
            </button>
          </div>
        </div>
      ) : data.bank.length === 0 ? (
        <div className="grid place-items-center py-8 text-center">
          <Landmark className="mb-2 h-8 w-8 text-slate-200" />
          <p className="text-sm text-slate-400">{EMPTY}</p>
          {canEdit && <p className="mt-1 text-xs text-slate-300">点击右上角「登记银行卡」录入（卡号加密存储）</p>}
        </div>
      ) : (
        <div className="space-y-3">
          {data.bank.map((b) => (
            <div key={b.id} data-testid="bank-card" className="grid min-w-0 grid-cols-1 gap-4 rounded-xl bg-slate-50 p-4 lg:grid-cols-[minmax(10rem,0.55fr)_minmax(0,1.45fr)] lg:gap-x-6">
              <div className="min-w-0">
                <p className="text-[11px] text-slate-400">开户银行</p>
                <p data-testid="bank-card-bank-name" className="mt-0.5 min-w-0 break-words text-[13px] font-bold leading-5 text-slate-700 [overflow-wrap:anywhere]">{b.bankName || EMPTY}</p>
              </div>
              <div className="min-w-0">
                <p className="text-[11px] text-slate-400">卡号（加密存储）</p>
                <div className="mt-1">
                  <SensitiveNumber
                    masked={b.maskedNumber}
                    revealed={revealed}
                    onReveal={reveal}
                    canReveal={canReveal}
                    revealTitle="查看完整银行卡号"
                    revealMessage="此操作将解密显示完整银行卡号，并记录一条审计日志。请确认仅用于必要场景。"
                    variant="bank"
                    details={(
                      <div data-testid="bank-card-holder" className="min-w-0">
                        <p className="text-[11px] text-slate-400">持卡人</p>
                        <p className="mt-0.5 min-w-0 break-words text-[13px] font-semibold leading-5 text-slate-700 [overflow-wrap:anywhere]">{b.accountName || EMPTY}</p>
                      </div>
                    )}
                    status={b.isPayroll ? (
                      <span data-testid="bank-card-payroll-badge" className="shrink-0 whitespace-nowrap rounded-md bg-budu-50 px-2 py-1 text-[10px] font-bold text-budu-600">工资卡</span>
                    ) : null}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  )
}

// ---------------- 合同 ----------------

function ContractTab({ employeeId, canEdit }) {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({})
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      setRows((await api(`/v2/employees/${employeeId}/contracts`)).rows)
    } catch (e) {
      setError(e.message)
    }
  }, [employeeId])

  useEffect(() => {
    load()
  }, [load])

  const add = async () => {
    setSaving(true)
    setError('')
    try {
      await api(`/v2/employees/${employeeId}/contracts`, {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          signDate: form.signDate || null,
          startDate: form.startDate || null,
          endDate: form.isIndefinite ? null : form.endDate || null,
          probationMonths: Number(form.probationMonths) || 0,
        }),
      })
      setAdding(false)
      setForm({})
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const terminate = async (id) => {
    if (!window.confirm('确认终止该合同？记录将保留并标记为「已终止」。')) return
    try {
      await api(`/v2/employees/${employeeId}/contracts/${id}`, { method: 'DELETE' })
      await load()
    } catch (e) {
      setError(e.message)
    }
  }

  const statusMeta = {
    active: { label: '有效', cls: 'bg-emerald-50 text-emerald-600' },
    expiring: { label: '即将到期', cls: 'bg-amber-50 text-amber-600' },
    expired: { label: '已到期', cls: 'bg-slate-100 text-slate-500' },
    terminated: { label: '已终止', cls: 'bg-rose-50 text-rose-500' },
  }

  return (
    <SectionCard title="劳动合同">
      {error && <p className="mb-3 rounded-xl bg-rose-50 px-4 py-2.5 text-sm text-rose-600">{error}</p>}

      {adding ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <InlineSelect
            label="合同类型"
            value={form.contractType || 'labor'}
            onChange={(v) => setForm((s) => ({ ...s, contractType: v }))}
            options={CONTRACT_TYPES}
          />
          <InlineInput label="合同编号" value={form.contractNo || ''} onChange={(v) => setForm((s) => ({ ...s, contractNo: v }))} />
          <InlineInput label="签订日期" type="date" value={form.signDate || ''} onChange={(v) => setForm((s) => ({ ...s, signDate: v }))} />
          <InlineInput label="合同开始日期" type="date" value={form.startDate || ''} onChange={(v) => setForm((s) => ({ ...s, startDate: v }))} />
          <InlineInput
            label="合同结束日期"
            type="date"
            value={form.endDate || ''}
            onChange={(v) => setForm((s) => ({ ...s, endDate: v }))}
          />
          <InlineInput
            label="试用期（月）"
            type="number"
            value={form.probationMonths ?? ''}
            onChange={(v) => setForm((s) => ({ ...s, probationMonths: v }))}
          />
          <label className="flex items-center gap-2 pb-2.5 text-xs font-semibold text-slate-500 sm:col-span-2">
            <input type="checkbox" checked={form.isIndefinite === true} onChange={(e) => setForm((s) => ({ ...s, isIndefinite: e.target.checked }))} />
            无固定期限合同
          </label>
          <div className="flex gap-2.5 sm:col-span-2">
            <button onClick={() => setAdding(false)} className="rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-bold text-slate-500 transition hover:bg-slate-200">
              取消
            </button>
            <button onClick={add} disabled={saving} className="rounded-xl bg-budu-500 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:opacity-90 disabled:opacity-50">
              {saving ? '保存中…' : '保存合同'}
            </button>
          </div>
        </div>
      ) : rows === null ? (
        <div className="grid place-items-center py-10 text-sm text-slate-300">加载中…</div>
      ) : rows.length === 0 ? (
        <div className="grid place-items-center py-8 text-center">
          <FileText className="mb-2 h-8 w-8 text-slate-200" />
          <p className="text-sm text-slate-400">{EMPTY}</p>
          {canEdit && <p className="mt-1 text-xs text-slate-300">点击右上角「新增合同」登记</p>}
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((c) => {
            const meta = statusMeta[c.status] || statusMeta.active
            return (
              <div key={c.id} className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl bg-slate-50 p-4">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-[13px] font-bold text-slate-700">
                    {CONTRACT_TYPES.find((x) => x.value === c.contractType)?.label || c.contractType}
                    <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${meta.cls}`}>{meta.label}</span>
                    {c.isIndefinite && <span className="rounded-md bg-budu-50 px-1.5 py-0.5 text-[10px] font-bold text-budu-600">无固定期限</span>}
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    编号 {c.contractNo || EMPTY}
                    {c.signDate ? ` · 签订 ${fmtDate(c.signDate)}` : ''}
                    {c.startDate ? ` · ${fmtDate(c.startDate)}` : ''}
                    {c.endDate ? ` 至 ${fmtDate(c.endDate)}` : ''}
                    {c.probationMonths ? ` · 试用 ${c.probationMonths} 个月` : ''}
                  </p>
                </div>
                {canEdit && c.status !== 'terminated' && (
                  <button
                    onClick={() => terminate(c.id)}
                    className="flex items-center gap-1 rounded-lg bg-rose-50 px-2.5 py-1.5 text-[11px] font-bold text-rose-500 transition hover:bg-rose-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> 终止
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {canEdit && !adding && (
        <button
          onClick={() => setAdding(true)}
          className="mt-4 flex items-center gap-1.5 rounded-xl bg-budu-50 px-3.5 py-2.5 text-xs font-bold text-budu-600 transition hover:bg-budu-100"
        >
          <Plus className="h-4 w-4" /> 新增合同
        </button>
      )}
    </SectionCard>
  )
}

// ---------------- 履历时间线 ----------------

const TIMELINE_META = {
  hire: { label: '入职', cls: 'bg-emerald-50 text-emerald-600', icon: CalendarDays },
  salary: { label: '薪资调整', cls: 'bg-budu-50 text-budu-600', icon: Banknote },
  store: { label: '门店调动', cls: 'bg-violet-50 text-violet-600', icon: Briefcase },
  position: { label: '岗位/职级调整', cls: 'bg-sky-50 text-sky-600', icon: UserRound },
  status: { label: '状态变更', cls: 'bg-amber-50 text-amber-600', icon: History },
}

function TimelineTab({ employeeId }) {
  const [items, setItems] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api(`/v2/employees/${employeeId}/timeline`)
      .then((d) => setItems(d.timeline))
      .catch((e) => setError(e.message))
  }, [employeeId])

  return (
    <SectionCard title="人事履历（只追加，不删除）">
      {error && <p className="mb-3 rounded-xl bg-rose-50 px-4 py-2.5 text-sm text-rose-600">{error}</p>}
      {items === null ? (
        <div className="grid place-items-center py-10 text-sm text-slate-300">加载中…</div>
      ) : items.length === 0 ? (
        <div className="grid place-items-center py-8 text-center">
          <History className="mb-2 h-8 w-8 text-slate-200" />
          <p className="text-sm text-slate-400">{EMPTY}</p>
        </div>
      ) : (
        <ol className="relative ml-2 space-y-5 border-l-2 border-slate-100 pl-5">
          {items.map((it, i) => {
            const meta = TIMELINE_META[it.type] || TIMELINE_META.status
            const Icon = meta.icon
            return (
              <li key={i} className="relative">
                <span className={`absolute -left-[31px] grid h-5 w-5 place-items-center rounded-full ${meta.cls}`}>
                  <Icon className="h-3 w-3" />
                </span>
                <p className="flex flex-wrap items-center gap-2 text-[13px] font-bold text-slate-700">
                  {it.title}
                  <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${meta.cls}`}>{meta.label}</span>
                  <span className="text-[11px] font-normal text-slate-400">{fmtDateTime(it.date)}</span>
                </p>
                <p className="mt-0.5 text-xs text-slate-500">{it.detail}</p>
                {it.operator && <p className="mt-0.5 text-[10px] text-slate-300">操作人：{it.operator}</p>}
              </li>
            )
          })}
        </ol>
      )}
    </SectionCard>
  )
}

// ---------------- 工资考勤摘要 ----------------

function SummaryTab({ employeeId }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api(`/v2/employees/${employeeId}/summary`)
      .then(setData)
      .catch((e) => setError(e.message))
  }, [employeeId])

  return (
    <SectionCard title="工资与考勤（只读，来自现有工资条/考勤数据）">
      {error && <p className="mb-3 rounded-xl bg-rose-50 px-4 py-2.5 text-sm text-rose-600">{error}</p>}
      {data === null ? (
        <div className="grid place-items-center py-10 text-sm text-slate-300">加载中…</div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-xl bg-slate-50 p-4">
            <p className="text-[11px] font-bold text-slate-500">考勤（近 60 条记录）</p>
            <p className="mt-2 text-2xl font-black tabular-nums text-budu-600">{data.attendance.days} 天</p>
            <p className="text-xs text-slate-400">累计 {data.attendance.totalHours} 小时</p>
          </div>
          <div className="rounded-xl bg-slate-50 p-4">
            <p className="text-[11px] font-bold text-slate-500">工资条（最近 6 期）</p>
            {data.payroll.length === 0 ? (
              <p className="mt-3 text-sm text-slate-300">{EMPTY}</p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {data.payroll.map((p) => (
                  <li key={p.id} className="flex items-center justify-between text-xs">
                    <span className="text-slate-500">{p.periodKey}</span>
                    <span className="flex items-center gap-2">
                      <span className="font-bold tabular-nums text-slate-700">¥{(Number(p.totalCents) / 100).toFixed(2)}</span>
                      <span className={`rounded px-1 py-0.5 text-[9px] font-bold ${p.status === 'confirmed' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
                        {p.status === 'confirmed' ? '已签收' : '待签收'}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  )
}

// ---------------- 附件 ----------------

function formatSize(bytes) {
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function DocumentsTab({ employeeId, canEdit }) {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)

  const load = useCallback(async () => {
    try {
      setRows((await api(`/v2/employees/${employeeId}/documents`)).rows)
    } catch (e) {
      setError(e.message)
    }
  }, [employeeId])

  useEffect(() => {
    load()
  }, [load])

  const upload = async (file, isSensitive) => {
    setUploading(true)
    setError('')
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
        reader.onerror = () => reject(new Error('读取文件失败'))
        reader.readAsDataURL(file)
      })
      await api(`/v2/employees/${employeeId}/documents`, {
        method: 'POST',
        body: JSON.stringify({
          data,
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          documentType: docTypeOf(file.name),
          isSensitive,
        }),
      })
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setUploading(false)
    }
  }

  const docTypeOf = (name) => {
    const n = String(name || '').toLowerCase()
    if (n.includes('身份证') || n.includes('id')) return 'id_card'
    if (n.includes('银行') || n.includes('卡')) return 'bank_card'
    if (n.includes('合同')) return 'contract'
    if (n.includes('简历')) return 'resume'
    if (n.includes('证书')) return 'certificate'
    if (n.includes('离职')) return 'resignation'
    return 'other'
  }

  const view = async (doc) => {
    try {
      const res = await fetch(`/api/v2/employees/${employeeId}/documents/${doc.id}/content`, { credentials: 'same-origin' })
      if (!res.ok) {
        const d = await res.json().catch(() => null)
        throw new Error((d && d.error) || '读取失败')
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank')
      setTimeout(() => URL.revokeObjectURL(url), 60000)
    } catch (e) {
      alert(e.message)
    }
  }

  const remove = async (doc) => {
    if (!window.confirm(`确认删除附件「${doc.fileName}」？记录将保留，仅清除文件内容。`)) return
    try {
      await api(`/v2/employees/${employeeId}/documents/${doc.id}`, { method: 'DELETE' })
      await load()
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <SectionCard title="附件档案">
      {error && <p className="mb-3 rounded-xl bg-rose-50 px-4 py-2.5 text-sm text-rose-600">{error}</p>}

      {canEdit && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl bg-budu-50/50 p-3">
          <label className="flex cursor-pointer items-center gap-1.5 rounded-xl bg-budu-500 px-3 py-2 text-xs font-bold text-white shadow-sm transition hover:opacity-90">
            <Upload className="h-3.5 w-3.5" />
            {uploading ? '上传中…' : '上传附件（≤4MB）'}
            <input
              type="file"
              className="hidden"
              disabled={uploading}
              onChange={(e) => {
                const f = e.target.files && e.target.files[0]
                if (f) upload(f, false)
                e.target.value = ''
              }}
            />
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 rounded-xl bg-rose-500 px-3 py-2 text-xs font-bold text-white shadow-sm transition hover:opacity-90">
            <Lock className="h-3.5 w-3.5" />
            {uploading ? '上传中…' : '上传敏感附件（仅管理可见）'}
            <input
              type="file"
              className="hidden"
              disabled={uploading}
              onChange={(e) => {
                const f = e.target.files && e.target.files[0]
                if (f) upload(f, true)
                e.target.value = ''
              }}
            />
          </label>
          <p className="text-[10px] text-slate-400">敏感附件（如身份证/银行卡复印件）内容仅开发者/管理员/财务可读取</p>
        </div>
      )}

      {rows === null ? (
        <div className="grid place-items-center py-10 text-sm text-slate-300">加载中…</div>
      ) : rows.length === 0 ? (
        <div className="grid place-items-center py-8 text-center">
          <Paperclip className="mb-2 h-8 w-8 text-slate-200" />
          <p className="text-sm text-slate-400">{EMPTY}</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {rows.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-slate-50 p-3.5">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white text-slate-400 shadow-sm">
                <FileText className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 truncate text-[13px] font-bold text-slate-700">
                  {d.fileName}
                  {d.isSensitive && (
                    <span className="flex items-center gap-0.5 rounded-md bg-rose-50 px-1.5 py-0.5 text-[9px] font-bold text-rose-500">
                      <Lock className="h-2.5 w-2.5" /> 敏感
                    </span>
                  )}
                  <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold text-slate-400">
                    {DOC_TYPES.find((x) => x.value === d.documentType)?.label || d.documentType}
                  </span>
                </p>
                <p className="mt-0.5 text-[11px] text-slate-400">
                  {formatSize(d.fileSize)} · {d.uploadedBy} · {fmtDateTime(d.createdAt)}
                </p>
              </div>
              <button
                onClick={() => view(d)}
                className="flex items-center gap-1 rounded-lg bg-white px-2.5 py-1.5 text-[11px] font-bold text-slate-500 shadow-sm transition hover:text-budu-600"
              >
                <Eye className="h-3.5 w-3.5" /> 查看
              </button>
              {canEdit && (
                <button
                  onClick={() => remove(d)}
                  className="flex items-center gap-1 rounded-lg bg-rose-50 px-2.5 py-1.5 text-[11px] font-bold text-rose-500 transition hover:bg-rose-100"
                >
                  <Trash2 className="h-3.5 w-3.5" /> 删除
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  )
}
