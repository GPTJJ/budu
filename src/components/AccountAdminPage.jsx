import { useEffect, useState } from 'react'
import { ArrowLeft, KeyRound, Loader2, MapPin, RotateCcw, Shield, SlidersHorizontal, Trash2, UserPlus, Users, X } from 'lucide-react'
import { api } from '../utils/api'
import { allStores, currentEmployeeDirectory, storeName } from '../utils/selectors'
import { loadUserData } from '../utils/userData'
import { t } from '../utils/text'
import {
  ACTIVE_ROLES,
  DAILY_ENTRY_CAPABILITIES,
  DAILY_ENTRY_CAPABILITY_OPTIONS,
  MODULE_GROUPS,
  ROLE_LABELS,
  defaultModuleKeys,
  normalizeAccountPermissions,
} from '../../shared/accountPermissions'

const inputCls = 'input'

/** 注册时间展示：YYYY/MM/DD HH:mm（保留数据原值，仅前端格式化，去秒） */
function formatCreatedAt(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 角色 Select 视觉配色（数据行为不变）：员工浅粉、开发者强调、停用灰 */
function roleSelectClass(role, disabled) {
  const base = 'min-w-[100px] cursor-pointer rounded-[14px] px-3 text-sm font-semibold outline-none transition focus:ring-2 focus:ring-budu-200 disabled:cursor-not-allowed disabled:opacity-50'
  if (disabled) return `${base} border border-slate-200 bg-white text-slate-400`
  if (role === 'public') return `${base} border border-slate-200 bg-slate-100 text-slate-400`
  if (role === 'developer') return `${base} border border-budu-200 bg-budu-500 text-white`
  if (role === 'staff') return `${base} border border-budu-100 bg-budu-50 text-budu-600`
  if (role === 'cashier') return `${base} border border-slate-200 bg-slate-50 text-slate-600`
  return `${base} border border-slate-200 bg-slate-50 text-slate-700`
}

/** 头像首字：优先显示名，其次用户名（取前 2 个字符，中文姓名友好） */
function avatarText(u) {
  const text = (u.displayName || u.username || '?').trim()
  return text.slice(0, 2).toUpperCase()
}

function ResetPasswordModal({ user, onClose }) {
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setError('')
    setOk('')
    if (newPassword !== confirm) {
      setError(t('两次输入的新密码不一致'))
      return
    }
    setBusy(true)
    try {
      await api(`/admin/users/${user.id}/password`, {
        method: 'PUT',
        body: JSON.stringify({ newPassword }),
      })
      setOk(t('密码已重置'))
      setTimeout(onClose, 1200)
    } catch (err) {
      setError(t(err.message))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-lg">
        <div className="flex items-start justify-between gap-4">
          <h3 className="text-lg font-bold text-slate-800">{t('重置密码：{name}', { name: user.username })}</h3>
          <button
            onClick={onClose}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-50 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            aria-label={t('关闭')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="mt-5 space-y-3">
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder={t('新密码（至少 6 位）')}
            className={inputCls}
          />
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder={t('确认新密码')}
            className={inputCls}
          />
          {error && <p className="text-xs font-medium text-rose-500">{error}</p>}
          {ok && <p className="text-xs font-medium text-emerald-500">{ok}</p>}
          <button
            onClick={submit}
            disabled={busy || newPassword.length < 6 || !confirm}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-budu-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('保存')}
          </button>
        </div>
      </div>
    </div>
  )
}

function StoreCheckboxes({ selected, onChange, single = false }) {
  const stores = allStores()
  const toggle = (key) =>
    single ? onChange([key]) : onChange(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key])
  if (stores.length === 0) {
    return <p className="text-xs text-slate-300">{t('暂无门店，请先在系统设置新增门店')}</p>
  }
  return (
    <div className="grid max-h-40 grid-cols-1 gap-1 overflow-y-auto rounded-xl bg-slate-50 p-2 sm:grid-cols-2">
      {stores.map((s) => {
        const checked = selected.includes(s.key)
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => toggle(s.key)}
            className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-medium transition ${
              checked ? 'bg-budu-100 text-budu-700' : 'text-slate-600 hover:bg-white'
            }`}
          >
            <span
              className={`grid h-4 w-4 shrink-0 place-items-center rounded border text-[10px] font-bold ${
                checked ? 'border-budu-500 bg-budu-500 text-white' : 'border-slate-200 bg-white text-transparent'
              }`}
            >
              ✓
            </span>
            {s.name}
          </button>
        )
      })}
    </div>
  )
}

function CreateUserModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ username: '', name: '', password: '', role: 'staff', storeKeys: [], staffKey: '', employeeId: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // Gate 20：员工选择器用当前 PG Employee 目录（currentEmployeeDirectory，Employee.id 为 option 身份，
  // 不按姓名折叠——同店同名独立可选项）；employeeNo 辅助区分显示。
  const directoryEmployees = currentEmployeeDirectory('all')

  const submit = async () => {
    setError('')
    if (!form.username.trim() || form.password.length < 6) {
      setError(t('请填写用户名和至少 6 位密码'))
      return
    }
    if (['staff', 'manager'].includes(form.role) && !form.employeeId) {
      setError(t('请选择绑定的员工'))
      return
    }
    setBusy(true)
    try {
      await api('/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          username: form.username.trim(),
          name: form.name.trim(),
          password: form.password,
          role: form.role,
          storeKeys: form.storeKeys,
          staffKey: form.staffKey,
          employeeId: form.employeeId || undefined,
        }),
      })
      onCreated()
      onClose()
    } catch (err) {
      setError(t(err.message))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-lg">
        <div className="flex items-start justify-between gap-4">
          <h3 className="text-lg font-bold text-slate-800">{t('创建账号')}</h3>
          <button
            onClick={onClose}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-50 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            aria-label={t('关闭')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-5 space-y-3">
          <div>
            <span className="mb-1.5 block text-xs font-semibold text-slate-500">{t('用户名')}</span>
            <input
              value={form.username}
              onChange={(e) => setForm((s) => ({ ...s, username: e.target.value }))}
              placeholder={t('2-20 个字符')}
              className={inputCls}
              autoFocus
            />
          </div>
          <div>
            <span className="mb-1.5 block text-xs font-semibold text-slate-500">{t('持有人姓名（用于审批/抄送显示，可空）')}</span>
            <input
              value={form.name}
              onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
              placeholder={t('如：张三')}
              className={inputCls}
            />
          </div>
          <div>
            <span className="mb-1.5 block text-xs font-semibold text-slate-500">{t('初始密码')}</span>
            <input
              type="text"
              value={form.password}
              onChange={(e) => setForm((s) => ({ ...s, password: e.target.value }))}
              placeholder={t('至少 6 位，创建后建议提醒对方修改')}
              className={inputCls}
            />
          </div>
          <div>
            <span className="mb-1.5 block text-xs font-semibold text-slate-500">{t('角色')}</span>
            <select
              value={form.role}
              onChange={(e) => setForm((s) => ({ ...s, role: e.target.value }))}
              className={inputCls}
            >
              <option value="staff">{t('员工')}</option>
              <option value="admin">{t('管理员')}</option>
              <option value="cashier">{t('门店收银')}</option>
              <option value="manager">{t('店长')}</option>
              <option value="finance">{t('财务')}</option>
              <option value="developer">{t('开发者')}</option>
            </select>
          </div>
          {['staff', 'manager', 'cashier'].includes(form.role) && (
            <div>
              <span className="mb-1.5 block text-xs font-semibold text-slate-500">
                {t(form.role === 'cashier' ? '绑定门店（收银账号仅可绑定一家）' : '绑定门店')}
              </span>
              <StoreCheckboxes
                single={form.role === 'cashier'}
                selected={form.storeKeys}
                onChange={(keys) => setForm((s) => ({ ...s, storeKeys: keys, staffKey: s.staffKey && keys.includes(s.staffKey.split('::')[0]) ? s.staffKey : '' }))}
              />
            </div>
          )}
          {['staff', 'manager'].includes(form.role) && (
            <div>
              <span className="mb-1.5 block text-xs font-semibold text-slate-500">{t('绑定员工')}</span>
              <select
                value={form.employeeId}
                onChange={(e) => {
                  const emp = directoryEmployees.find((s) => s.id === e.target.value)
                  setForm((s) => ({
                    ...s,
                    employeeId: e.target.value,
                    staffKey: emp ? `${emp.storeKey}::${emp.name}` : '',
                  }))
                }}
                className={inputCls}
              >
                <option value="">{t('请选择员工')}</option>
                {directoryEmployees
                  .filter((s) => form.storeKeys.includes(s.storeKey))
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}（{storeName(s.storeKey)}）{s.employeeNo ? ` · ${s.employeeNo}` : ''}
                    </option>
                  ))}
              </select>
            </div>
          )}
          {error && <p className="text-xs font-medium text-rose-500">{error}</p>}
        </div>

        <div className="mt-5 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-200"
          >
            {t('取消')}
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-budu-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('创建')}
          </button>
        </div>
      </div>
    </div>
  )
}

function BindStoresModal({ user, onClose, onSaved }) {
  const [selected, setSelected] = useState(user.storeKeys || [])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setError('')
    setBusy(true)
    try {
      await api(`/admin/users/${user.id}/role`, {
        method: 'PUT',
        body: JSON.stringify({ role: user.role, storeKeys: selected }),
      })
      onSaved()
      onClose()
    } catch (err) {
      setError(t(err.message))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-lg">
        <div className="flex items-start justify-between gap-4">
          <h3 className="text-lg font-bold text-slate-800">{t('绑定门店：{name}', { name: user.username })}</h3>
          <button
            onClick={onClose}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-50 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            aria-label={t('关闭')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="mt-5">
          <StoreCheckboxes single={user.role === 'cashier'} selected={selected} onChange={setSelected} />
          {error && <p className="mt-2 text-xs font-medium text-rose-500">{error}</p>}
        </div>
        <div className="mt-5 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-200"
          >
            {t('取消')}
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-budu-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('保存')}
          </button>
        </div>
      </div>
    </div>
  )
}

function RoleBindingModal({ user, role, onClose, onSaved }) {
  const [storeKeys, setStoreKeys] = useState(role === 'cashier' ? (user.storeKeys || []).slice(0, 1) : (user.storeKeys || []))
  // Gate 20：初始绑定 = User.employeeId（稳定身份）；staffKey 仅展示快照
  const [employeeId, setEmployeeId] = useState(['manager', 'staff'].includes(role) ? (user.employeeId || '') : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const directoryEmployees = currentEmployeeDirectory('all')
  const staffOptions = directoryEmployees.filter((s) => storeKeys.includes(s.storeKey))
  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const emp = directoryEmployees.find((s) => s.id === employeeId)
      await api(`/admin/users/${user.id}/role`, {
        method: 'PUT',
        body: JSON.stringify({
          role,
          storeKeys,
          staffKey: role === 'cashier' ? '' : (emp ? `${emp.storeKey}::${emp.name}` : ''),
          employeeId: ['manager', 'staff'].includes(role) ? employeeId || undefined : undefined,
        }),
      })
      await onSaved()
      onClose()
    } catch (err) {
      setError(t(err.message))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div><h3 className="text-lg font-bold text-slate-800">{t('设置角色：{role}', { role: ROLE_LABELS[role] })}</h3><p className="mt-1 text-xs text-slate-400">{user.displayName || user.username}</p></div>
          <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-xl bg-slate-50 text-slate-400"><X className="h-5 w-5" /></button>
        </div>
        <div className="mt-5 space-y-4">
          <div><span className="mb-1.5 block text-xs font-semibold text-slate-500">{role === 'cashier' ? t('绑定门店（仅一家）') : t('绑定门店')}</span><StoreCheckboxes single={role === 'cashier'} selected={storeKeys} onChange={(keys) => { setStoreKeys(keys); if (staffKey && !keys.includes(staffKey.split('::')[0])) setStaffKey('') }} /></div>
          {['manager', 'staff'].includes(role) && <div><span className="mb-1.5 block text-xs font-semibold text-slate-500">{t('绑定员工')}</span><select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className={inputCls}><option value="">{t('请选择员工')}</option>{staffOptions.map((s) => <option key={s.id} value={s.id}>{s.name}（{storeName(s.storeKey)}）{s.employeeNo ? ` · ${s.employeeNo}` : ''}</option>)}</select></div>}
          {error && <p className="text-xs font-medium text-rose-500">{error}</p>}
        </div>
        <div className="mt-5 flex gap-2"><button onClick={onClose} className="flex-1 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-500">{t('取消')}</button><button onClick={submit} disabled={busy} className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-budu-500 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />}{t('保存并切换')}</button></div>
      </div>
    </div>
  )
}

function PermissionModal({ user, onClose, onSaved }) {
  const initialModules = user.permissions?.modules || {}
  const [modules, setModules] = useState(initialModules)
  const [transferAll, setTransferAll] = useState(user.permissions?.inventoryTransferAll === true)
  const [dailyEntry, setDailyEntry] = useState(() => normalizeAccountPermissions(user.permissions, user.role, user.assetCenter === true).dailyEntry)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const toggleModule = (key) => setModules((current) => ({ ...current, [key]: current[key] !== true }))
  const toggleGroup = (group) => {
    const enabled = group.modules.every((item) => modules[item.key] === true)
    setModules((current) => ({
      ...current,
      ...Object.fromEntries(group.modules.map((item) => [item.key, !enabled])),
    }))
  }
  const resetDefaults = () => {
    const defaults = new Set(defaultModuleKeys(user.role, user.assetCenter === true))
    const nextModules = Object.fromEntries(MODULE_GROUPS.flatMap((group) => group.modules).map((item) => [item.key, defaults.has(item.key)]))
    setModules(nextModules)
    setDailyEntry(normalizeAccountPermissions({ modules: nextModules }, user.role, user.assetCenter === true).dailyEntry)
  }
  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      await api(`/admin/users/${user.id}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({ modules, inventoryTransferAll: transferAll, dailyEntry }),
      })
      await onSaved()
      try {
        const bc = 'BroadcastChannel' in window ? new BroadcastChannel('budu-auth-sync') : null
        bc?.postMessage({ type: 'auth-changed' })
        bc?.close()
      } catch { /* 轮询兜底 */ }
      onClose()
    } catch (err) {
      setError(t(err.message))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-lg sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-bold text-slate-800">{t('功能授权：{name}', { name: user.displayName || user.username })}</h3>
            <p className="mt-1 text-xs text-slate-400">{t('授权仅决定版块访问，门店范围和版块内操作边界保持不变')}</p>
          </div>
          <button onClick={onClose} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-50 text-slate-400"><X className="h-5 w-5" /></button>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {MODULE_GROUPS.map((group) => {
            const allEnabled = group.modules.every((item) => modules[item.key] === true)
            return (
              <section key={group.key} className="rounded-2xl border border-slate-100 bg-slate-50/60 p-3">
                <button type="button" onClick={() => toggleGroup(group)} className="flex w-full items-center justify-between text-sm font-bold text-slate-700">
                  {t(group.label)}
                  <span className={`rounded-full px-2 py-0.5 text-[10px] ${allEnabled ? 'bg-emerald-100 text-emerald-700' : 'bg-white text-slate-400'}`}>{allEnabled ? t('已全选') : t('全组选中')}</span>
                </button>
                <div className="mt-2 space-y-1">
                  {group.modules.map((item) => (
                    <label key={item.key} className="flex min-h-10 cursor-pointer items-center gap-2 rounded-xl px-2 text-xs font-medium text-slate-600 hover:bg-white">
                      <input type="checkbox" checked={modules[item.key] === true} onChange={() => toggleModule(item.key)} className="h-4 w-4 accent-budu-500" />
                      {t(item.label)}
                    </label>
                  ))}
                </div>
              </section>
            )
          })}
        </div>
        {modules['inventory-transfer'] === true && (
          <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-amber-100 bg-amber-50 px-3 text-xs font-semibold text-amber-700">
            <input type="checkbox" checked={transferAll} onChange={(e) => setTransferAll(e.target.checked)} className="h-4 w-4 accent-amber-500" />
            {t('允许管理全部门店的库存调拨（不受账号门店绑定限制）')}
          </label>
        )}
        {modules['store-entry'] === true && (
          <section className="mt-3 rounded-2xl border border-budu-100 bg-budu-50/60 p-3">
            <p className="text-sm font-bold text-slate-700">{t('每日录入操作权限')}</p>
            <p className="mt-1 text-[11px] leading-5 text-slate-400">{t('编辑、确认与历史修正分开授权；门店范围仍受账号绑定限制。')}</p>
            <div className="mt-2 grid gap-1 sm:grid-cols-2">
              {DAILY_ENTRY_CAPABILITY_OPTIONS.map((item) => (
                <label key={item.key} className="flex min-h-10 cursor-pointer items-center gap-2 rounded-xl bg-white/70 px-3 text-xs font-medium text-slate-600">
                  <input
                    type="checkbox"
                    checked={dailyEntry[item.key] === true}
                    onChange={(event) => setDailyEntry((current) => ({ ...current, [item.key]: event.target.checked }))}
                    className="h-4 w-4 accent-budu-500"
                  />
                  {t(item.label)}
                </label>
              ))}
            </div>
            {dailyEntry[DAILY_ENTRY_CAPABILITIES.REVISE] && (
              <p className="mt-2 text-[11px] font-semibold text-amber-700">{t('历史修正必须经受控流程并写入审计日志。')}</p>
            )}
          </section>
        )}
        {user.permissionsUpdatedAt && <p className="mt-3 text-[11px] text-slate-400">{t('最近修改：{time} · {operator}', { time: new Date(user.permissionsUpdatedAt).toLocaleString(), operator: user.permissionsUpdatedBy || '开发者' })}</p>}
        {error && <p className="mt-3 text-xs font-medium text-rose-500">{error}</p>}
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" onClick={resetDefaults} className="inline-flex items-center gap-1.5 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-600"><RotateCcw className="h-4 w-4" />{t('恢复角色默认')}</button>
          <button type="button" onClick={onClose} className="ml-auto rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-500">{t('取消')}</button>
          <button type="button" onClick={submit} disabled={busy} className="inline-flex items-center gap-1.5 rounded-xl bg-budu-500 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />}{t('保存授权')}</button>
        </div>
      </div>
    </div>
  )
}

/**
 * 账号卡片（移动端单列 / 桌面端双列网格）
 * 纯视觉重构：数据、角色切换、操作入口与弹窗逻辑与改造前完全一致。
 */
function AccountCard({ u, isSelf, currentUser, onChangeRole, onPermission, onBindStore, onSetName, onBindStaff, onResetPassword, onDelete }) {
  const showStoreBind = u.role !== 'developer' && u.role !== 'public'
  const showStaffBind = ['staff', 'manager'].includes(u.role)
  const showPermissions = !['public', 'developer', 'cashier'].includes(u.role)
  const showBindStoreBtn = u.role !== 'developer' && u.role !== 'public' && u.role !== 'finance' && u.role !== 'admin'
  const showSetNameBtn = u.role !== 'public' && !isSelf

  return (
    <div className="rounded-[20px] bg-white p-[18px] shadow-[0_4px_20px_rgba(27,37,61,0.05)] transition-shadow hover:shadow-[0_6px_24px_rgba(27,37,61,0.09)]">
      {/* 主区：头像 + 信息 + 角色 */}
      <div className="flex items-start gap-3">
        <span className="grid h-[52px] w-[52px] shrink-0 place-items-center overflow-hidden rounded-2xl bg-budu-500 text-sm font-bold text-white shadow-sm">
          {u.avatar ? (
            <img src={u.avatar} alt="" className="h-full w-full object-cover" />
          ) : (
            avatarText(u)
          )}
        </span>

        <div className="min-w-0 flex-1">
          {/* 用户名：保证一行可读，禁止拆行 */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
            <p className="min-w-0 truncate text-[17px] font-semibold leading-[1.35] text-[#192033]">
              {u.displayName || u.username}
            </p>
            {u.displayName && (
              <span className="inline-flex max-w-[140px] items-center gap-0.5 truncate rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-medium text-slate-500 ring-1 ring-inset ring-slate-200/70">
                <span className="text-slate-400">@</span>
                <span className="truncate">{u.username}</span>
              </span>
            )}
            {isSelf && (
              <span className="rounded-full bg-budu-50 px-2 py-0.5 text-[10px] font-semibold text-budu-600">{t('当前账号')}</span>
            )}
          </div>

          {/* 绑定信息：整行展示，不换行挤压 */}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] leading-relaxed text-[#7a8395]">
            {showStoreBind && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5 text-slate-300" />
                {Array.isArray(u.storeKeys) && u.storeKeys.length > 0
                  ? t('已绑定 {count} 家门店', { count: u.storeKeys.length })
                  : t('未绑定门店')}
              </span>
            )}
            {showStaffBind && (
              <span className="inline-flex items-center gap-1">
                <Users className="h-3.5 w-3.5 text-slate-300" />
                {u.staffKey
                  ? t('员工：{name}', { name: u.staffKey.split('::')[1] || u.staffKey })
                  : t('未绑定员工')}
              </span>
            )}
          </div>

          {/* 特殊权限 Tag（自动换行） */}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {u.permissions?.inventoryTransferAll && (
              <span className="inline-flex items-center gap-1 rounded-lg bg-[#ecfaf1] px-2 py-1 text-xs font-medium text-[#24a65a]">
                ✓ {t('库存调拨全权限')}
              </span>
            )}
          </div>

          {u.status === 'disabled' && (
            <p className="mt-1.5 text-[13px] font-semibold text-[#ef4c66]">● {t('账号已停用')}</p>
          )}
          {u.bindingLegacyExempt && (
            <p className="mt-1.5 text-xs font-semibold text-amber-600">{t('待补齐门店与员工绑定')}</p>
          )}
        </div>

        {/* 角色选择器（数据行为不变，仅视觉） */}
        <div className="shrink-0">
          <select
            value={u.role}
            disabled={isSelf}
            onChange={(e) => onChangeRole(u, e.target.value)}
            className={roleSelectClass(u.role, isSelf)}
            aria-label={t('角色')}
          >
            {u.role === 'public' && <option value="public">{t('已停用')}</option>}
            {ACTIVE_ROLES.map((role) => <option key={role} value={role}>{t(ROLE_LABELS[role])}</option>)}
          </select>
          {u.role === 'public' && (
            <p className="mt-1 text-right text-[11px] text-slate-400">{t('原角色：对外展示')}</p>
          )}
        </div>
      </div>

      {/* 底部：注册时间 + 操作 */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-slate-100 pt-3">
        <span className="text-xs text-[#98a0b1]">
          {t('注册时间：{time}', { time: formatCreatedAt(u.createdAt) })}
        </span>
        <div className="flex flex-wrap items-center gap-1">
          {showPermissions && (
            <button
              onClick={() => onPermission(u)}
              className="inline-flex items-center gap-1 rounded-lg bg-slate-50 px-2 py-1.5 text-xs font-medium text-budu-600 transition hover:bg-budu-50"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {t('功能授权')}
            </button>
          )}
          {showBindStoreBtn && (
            <button
              onClick={() => onBindStore(u)}
              className="inline-flex items-center gap-1 rounded-lg bg-slate-50 px-2 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-budu-50 hover:text-budu-600"
            >
              <MapPin className="h-3.5 w-3.5" />
              {t('绑定门店')}
            </button>
          )}
          {showSetNameBtn && (
            <button
              onClick={() => onSetName(u)}
              className="inline-flex items-center gap-1 rounded-lg bg-slate-50 px-2 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-budu-50 hover:text-budu-600"
            >
              <Users className="h-3.5 w-3.5" />
              {t('设置姓名')}
            </button>
          )}
          {showStaffBind && (
            <button
              onClick={() => onBindStaff(u)}
              className="inline-flex items-center gap-1 rounded-lg bg-slate-50 px-2 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-budu-50 hover:text-budu-600"
            >
              <Users className="h-3.5 w-3.5" />
              {t('绑定员工')}
            </button>
          )}
          <button
            onClick={() => onResetPassword(u)}
            className="inline-flex items-center gap-1 rounded-lg bg-slate-50 px-2 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-budu-50 hover:text-budu-600"
          >
            <KeyRound className="h-3.5 w-3.5" />
            {t('重置密码')}
          </button>
          <button
            onClick={() => onDelete(u)}
            disabled={isSelf}
            className="inline-flex items-center gap-1 rounded-lg bg-rose-50/70 px-2 py-1.5 text-xs font-medium text-rose-500 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('删除账号')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function AccountAdminPage({ currentUser, onBack }) {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [resetTarget, setResetTarget] = useState(null)
  const [bindTarget, setBindTarget] = useState(null)
  const [permissionTarget, setPermissionTarget] = useState(null)
  const [roleTarget, setRoleTarget] = useState(null)
  const [createOpen, setCreateOpen] = useState(false)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const data = await api('/admin/users')
      setUsers(data.users || [])
    } catch (err) {
      setError(t(err.message))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const roleLabel = (role) => {
    if (role === 'public') return t('已停用（原对外展示）')
    return t(ROLE_LABELS[role] || role)
  }

  const changeRole = async (u, role) => {
    if (['manager', 'staff', 'cashier'].includes(role)) {
      try { await loadUserData() } catch { /* 使用现有员工缓存 */ }
      setRoleTarget({ user: u, role })
      return
    }
    if (!window.confirm(t('确定将「{name}」的权限改为「{role}」吗？', { name: u.username, role: roleLabel(role) }))) {
      return
    }
    setError('')
    try {
      await api(`/admin/users/${u.id}/role`, { method: 'PUT', body: JSON.stringify({ role }) })
      await load()
      try {
        const bc = 'BroadcastChannel' in window ? new BroadcastChannel('budu-auth-sync') : null
        if (bc) {
          bc.postMessage({ type: 'auth-changed' })
          bc.close()
        }
      } catch { /* 同浏览器多标签页即时同步，失败时靠轮询兜底 */ }
    } catch (err) {
      setError(t(err.message))
    }
  }

  const deleteUser = async (u) => {
    if (!window.confirm(t('确定删除账号「{name}」吗？此操作不可恢复。', { name: u.username }))) return
    setError('')
    try {
      await api(`/admin/users/${u.id}`, { method: 'DELETE' })
      await load()
    } catch (err) {
      setError(t(err.message))
    }
  }

  return (
    <div className="space-y-5">
      {/* 顶部：返回 + 标题 + 新增账号 */}
      <div className="flex flex-wrap items-center gap-4">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-2xl bg-white px-3.5 py-2.5 text-sm font-medium text-slate-500 shadow-[0_4px_14px_rgba(20,30,50,0.06)] transition hover:text-budu-600"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('返回首页')}
        </button>
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-bold text-[#182033]">
            <Shield className="h-6 w-6 text-budu-500" />
            {t('账号管理')}
          </h2>
          <p className="mt-0.5 text-[13px] text-[#7c8597]">{t('查看与管理所有已注册账号')}</p>
        </div>
        <button
          onClick={() => setCreateOpen(true)}
          className="ml-auto flex items-center gap-1.5 rounded-[14px] bg-budu-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
        >
          <UserPlus className="h-4 w-4" />
          {t('新增账号')}
        </button>
      </div>

      {/* 汇总卡片 */}
      <section className="flex items-center gap-4 rounded-[22px] bg-white p-5 shadow-[0_6px_24px_rgba(24,32,51,0.05)]">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-budu-50 text-budu-500">
          <Users className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[15px] font-bold text-[#182033]">
            {t('已注册账号')}
            <span className="rounded-full bg-[#fff0f5] px-2.5 py-0.5 text-[13px] font-semibold text-[#c93c70]">{users.length}</span>
          </p>
          <p className="mt-0.5 text-xs text-[#7c8597]">{t('所有已注册的账号及状态')}</p>
        </div>
      </section>

      {error && (
        <div className="rounded-2xl bg-rose-50/70 px-4 py-3 text-xs font-medium text-rose-500">{error}</div>
      )}

      {/* 账号卡片列表：移动端单列 / 桌面端双列 */}
      {loading ? (
        <div className="grid place-items-center py-12 text-sm text-slate-400">{t('加载中…')}</div>
      ) : users.length === 0 ? (
        <div className="grid place-items-center rounded-[22px] bg-white py-14 text-sm text-slate-300 shadow-[0_4px_20px_rgba(27,37,61,0.04)]">
          {t('暂无账号')}
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {users.map((u) => (
            <AccountCard
              key={u.id}
              u={u}
              isSelf={u.id === currentUser?.id}
              currentUser={currentUser}
              onChangeRole={changeRole}
              onPermission={setPermissionTarget}
              onBindStore={(target) => (['manager', 'staff'].includes(target.role) ? setRoleTarget({ user: target, role: target.role }) : setBindTarget(target))}
              onSetName={(target) => {
                const name = window.prompt(t('设置持有人姓名（用于审批/抄送显示）'), target.displayName || '')
                if (name === null) return
                api(`/admin/users/${target.id}/name`, { method: 'PUT', body: JSON.stringify({ name: name.trim() }) })
                  .then(load)
                  .catch((err) => setError(t(err.message)))
              }}
              onBindStaff={setRoleTarget}
              onResetPassword={setResetTarget}
              onDelete={deleteUser}
            />
          ))}
        </div>
      )}

      {resetTarget && <ResetPasswordModal user={resetTarget} onClose={() => setResetTarget(null)} />}
      {bindTarget && (
        <BindStoresModal user={bindTarget} onClose={() => setBindTarget(null)} onSaved={load} />
      )}
      {permissionTarget && (
        <PermissionModal user={permissionTarget} onClose={() => setPermissionTarget(null)} onSaved={load} />
      )}
      {roleTarget && (
        <RoleBindingModal user={roleTarget.user} role={roleTarget.role} onClose={() => setRoleTarget(null)} onSaved={load} />
      )}
      {createOpen && <CreateUserModal onClose={() => setCreateOpen(false)} onCreated={load} />}
    </div>
  )
}
