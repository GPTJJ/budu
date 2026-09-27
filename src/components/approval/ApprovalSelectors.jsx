// 审批中心选择器（Bottom Sheet 风格，纯前端 UI）
// 选项 / 员工（带搜索）/ 月份；日期复用原生 input[type=date]
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronRight, Search } from 'lucide-react'
import { employeeList, storeName } from '../../utils/selectors'
import { api } from '../../utils/api'
import { onUserDataUpdated } from '../../utils/userData'
import { OverlayHeader, OverlayPanel, OverlayScrollRegion, OverlayViewport } from '../overlay/OverlayPrimitives'

/** 通用底部弹出容器：半透明遮罩 + 取消/确定 + 安全区 */
export function BottomSheet({ open, title, onClose, onConfirm, confirmDisabled, children }) {
  if (!open) return null
  return createPortal(
    <OverlayViewport className="fixed inset-0 z-[98]">
      <div className="budu-overlay-backdrop absolute inset-0 bg-slate-900/40" onClick={onClose} aria-hidden="true" />
      <OverlayPanel role="dialog" aria-modal="true" aria-label={title} className="sheet-up absolute inset-x-0 bottom-0 mx-auto flex max-h-[calc(100dvh-env(safe-area-inset-top))] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white shadow-lg">
        <OverlayHeader className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <button onClick={onClose} className="min-h-11 px-2 text-sm text-slate-400 active:opacity-60">
            取消
          </button>
          <p className="text-sm font-semibold text-slate-800">{title}</p>
          <button
            onClick={onConfirm}
            disabled={confirmDisabled}
            className="min-h-11 px-2 text-sm font-semibold text-budu-600 active:opacity-60 disabled:opacity-40"
          >
            确定
          </button>
        </OverlayHeader>
        <OverlayScrollRegion className="max-h-[58dvh] pb-[env(safe-area-inset-bottom)]">{children}</OverlayScrollRegion>
      </OverlayPanel>
    </OverlayViewport>,
    document.body,
  )
}

/** 选项行（选中高亮） */
function OptionRow({ label, sub, selected, onSelect }) {
  return (
    <button
      onClick={onSelect}
      className="flex min-h-12 w-full items-center gap-3 px-5 text-left active:bg-slate-50"
    >
      <span className={`min-w-0 flex-1 truncate text-[15px] ${selected ? 'font-semibold text-budu-600' : 'text-slate-700'}`}>
        {label}
      </span>
      {sub && <span className="shrink-0 text-xs text-slate-400">{sub}</span>}
      {selected && <Check className="h-4 w-4 shrink-0 text-budu-500" />}
    </button>
  )
}

/** 选项选择器（确定生效，取消不修改） */
export function OptionSheet({ open, title, options, value, onChange, onClose }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => {
    if (open) setDraft(value)
  }, [open, value])
  return (
    <BottomSheet
      open={open}
      title={title}
      onClose={onClose}
      onConfirm={() => {
        onChange(draft)
        onClose()
      }}
    >
      <div className="divide-y divide-slate-50 py-1">
        {options.map((opt) => (
          <OptionRow key={opt.value} label={opt.label} selected={draft === opt.value} onSelect={() => setDraft(opt.value)} />
        ))}
      </div>
    </BottomSheet>
  )
}

/** 员工选择器：搜索（姓名/门店）+ 首字母头像 */
export function EmployeeSheet({ open, title, value, onChange, onClose }) {
  const [draft, setDraft] = useState(value)
  const [q, setQ] = useState('')
  const [dataVersion, setDataVersion] = useState(0)
  useEffect(
    () => onUserDataUpdated(() => setDataVersion((current) => current + 1)),
    [],
  )
  const employees = useMemo(() => employeeList('all', null), [dataVersion])
  useEffect(() => {
    if (open) {
      setDraft(value)
      setQ('')
    }
  }, [open, value])
  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase()
    if (!kw) return employees
    return employees.filter(
      (e) => e.name.toLowerCase().includes(kw) || (storeName(e.storeKey) || '').toLowerCase().includes(kw),
    )
  }, [employees, q])
  return (
    <BottomSheet
      open={open}
      title={title || '选择员工'}
      onClose={onClose}
      onConfirm={() => {
        onChange(draft)
        onClose()
      }}
      confirmDisabled={!draft}
    >
      <div className="border-b border-slate-100 px-4 py-2.5">
        <div className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索员工姓名 / 门店"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-300"
          />
        </div>
      </div>
      <div className="py-1">
        {filtered.length === 0 ? (
          <p className="py-10 text-center text-xs text-slate-300">未找到匹配员工</p>
        ) : (
          filtered.map((e) => {
            const key = `${e.storeKey}::${e.name}`
            const selected = draft === key
            return (
              <button
                key={key}
                onClick={() => setDraft(key)}
                className="flex min-h-12 w-full items-center gap-3 px-5 text-left active:bg-slate-50"
              >
                <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-bold ${selected ? 'bg-budu-500 text-white' : 'bg-slate-100 text-slate-500'}`}>
                  {e.name.slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-[15px] ${selected ? 'font-semibold text-budu-600' : 'text-slate-700'}`}>{e.name}</span>
                  <span className="block text-xs text-slate-400">{storeName(e.storeKey) || e.storeKey} · {e.type === 'fulltime' ? '全职' : '兼职'}</span>
                </span>
                {selected && <Check className="h-4 w-4 shrink-0 text-budu-500" />}
              </button>
            )
          })
        )}
      </div>
    </BottomSheet>
  )
}

/** 月份选择器（YYYY-MM） */
export function MonthSheet({ open, value, onChange, onClose }) {
  const [draft, setDraft] = useState(value)
  const months = useMemo(() => {
    const now = new Date()
    const list = []
    for (let y = now.getFullYear() - 1; y <= now.getFullYear() + 1; y += 1) {
      for (let m = 1; m <= 12; m += 1) {
        list.push({ value: `${y}-${String(m).padStart(2, '0')}`, label: `${y}年${m}月` })
      }
    }
    return list
  }, [])
  useEffect(() => {
    if (open) setDraft(value)
  }, [open, value])
  return (
    <BottomSheet
      open={open}
      title="选择月份"
      onClose={onClose}
      onConfirm={() => {
        onChange(draft)
        onClose()
      }}
      confirmDisabled={!draft}
    >
      <div className="grid grid-cols-3 gap-1 p-3">
        {months.map((m) => (
          <button
            key={m.value}
            onClick={() => setDraft(m.value)}
            className={`min-h-11 rounded-lg text-sm transition ${draft === m.value ? 'bg-budu-500 font-semibold text-white' : 'text-slate-600 active:bg-slate-100'}`}
          >
            {m.label}
          </button>
        ))}
      </div>
    </BottomSheet>
  )
}

/** 表单字段行（企业微信风格：名称 * | 值 > | 1px 分隔） */
export function FieldRow({ label, required, value, placeholder = '请选择', onClick, right, input, error }) {
  return (
    <div className="border-b border-slate-100">
      <button
        type="button"
        onClick={onClick}
        className="flex min-h-[52px] w-full items-center gap-3 px-4 py-2.5 text-left active:bg-slate-50"
      >
        <span className="w-[110px] shrink-0 text-[15px] text-slate-600">
          {label}
          {required && <span className="ml-0.5 text-rose-500">*</span>}
        </span>
        <span className="min-w-0 flex-1">
          {input || (
            <span className={`block truncate text-[15px] ${value ? 'text-slate-800' : 'text-slate-300'}`}>
              {value || placeholder}
            </span>
          )}
        </span>
        {right || <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />}
      </button>
      {error && <p className="px-4 pb-2 text-xs font-medium text-rose-500">{error}</p>}
    </div>
  )
}

/** 文本输入字段行：点击聚焦输入 */
export function InputFieldRow({ label, required, value, onChange, placeholder = '请输入', type = 'text', maxLength }) {
  const [focused, setFocused] = useState(false)
  return (
    <div className={`border-b border-slate-100 transition ${focused ? 'bg-budu-50/30' : ''}`}>
      <label className="flex min-h-[52px] w-full items-center gap-3 px-4 py-2.5">
        <span className="w-[110px] shrink-0 text-[15px] text-slate-600">
          {label}
          {required && <span className="ml-0.5 text-rose-500">*</span>}
        </span>
        <input
          type={type}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          maxLength={maxLength}
          className="min-w-0 flex-1 bg-transparent text-[15px] text-slate-800 outline-none placeholder:text-slate-300"
        />
      </label>
    </div>
  )
}

/** 文本域字段行 */
export function TextAreaRow({ label, required, value, onChange, placeholder = '请输入', maxLength = 500 }) {
  return (
    <div className="border-b border-slate-100">
      <label className="flex min-h-[52px] w-full items-start gap-3 px-4 py-3">
        <span className="w-[110px] shrink-0 pt-1 text-[15px] text-slate-600">
          {label}
          {required && <span className="ml-0.5 text-rose-500">*</span>}
        </span>
        <textarea
          rows={2}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          className="min-w-0 flex-1 resize-none bg-transparent text-[15px] text-slate-800 outline-none placeholder:text-slate-300"
        />
      </label>
    </div>
  )
}

/** 抄送人选择器：账号列表多选（排除 public/cashier 与本人），确定生效 */
export function CcSheet({ open, value = [], exclude, onChange, onClose }) {
  const [draft, setDraft] = useState(Array.isArray(value) ? value : [])
  const [q, setQ] = useState('')
  const [candidates, setCandidates] = useState([])
  useEffect(() => {
    if (open) {
      setDraft(Array.isArray(value) ? value : [])
      setQ('')
      api('/v2/approvals/cc-candidates')
        .then((res) => setCandidates(Array.isArray(res.rows) ? res.rows : []))
        .catch(() => setCandidates([]))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const roleLabel = (role) =>
    ({ developer: '开发者', admin: '管理员', manager: '店长', staff: '员工', finance: '财务', cashier: '门店收银' }[role] || role)
  const filtered = candidates.filter(
    (c) => c.username !== exclude && (!q.trim() || c.username.toLowerCase().includes(q.trim().toLowerCase())),
  )
  const toggle = (uname) => {
    setDraft((prev) => (prev.includes(uname) ? prev.filter((x) => x !== uname) : [...prev, uname]))
  }
  return (
    <BottomSheet
      open={open}
      title="添加抄送人"
      onClose={onClose}
      onConfirm={() => {
        onChange(draft)
        onClose()
      }}
    >
      <div className="border-b border-slate-100 px-4 py-2.5">
        <div className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索账号"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-300"
          />
        </div>
      </div>
      <div className="py-1">
        {filtered.length === 0 ? (
          <p className="py-10 text-center text-xs text-slate-300">未找到可添加的账号</p>
        ) : (
          filtered.map((c) => {
            const selected = draft.includes(c.username)
            const display = c.name && c.name !== c.username ? `${c.name}（${c.username}）` : c.username
            return (
              <button
                key={c.username}
                onClick={() => toggle(c.username)}
                className="flex min-h-12 w-full items-center gap-3 px-5 text-left active:bg-slate-50"
              >
                <span
                  className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-bold ${
                    selected ? 'bg-budu-500 text-white' : 'bg-slate-100 text-slate-500'
                  }`}
                >
                  {display.slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-[15px] ${selected ? 'font-semibold text-budu-600' : 'text-slate-700'}`}>
                    {display}
                  </span>
                  <span className="block text-xs text-slate-400">{roleLabel(c.role)}</span>
                </span>
                {selected && <Check className="h-4 w-4 shrink-0 text-budu-500" />}
              </button>
            )
          })
        )}
      </div>
    </BottomSheet>
  )
}
