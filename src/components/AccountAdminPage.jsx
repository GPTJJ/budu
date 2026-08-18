import { useEffect, useState } from 'react'
import { ArrowLeft, KeyRound, Loader2, MapPin, Shield, Trash2, UserPlus, Users, X } from 'lucide-react'
import { api } from '../utils/api'
import { allStores, employeeList, storeName } from '../utils/selectors'
import { loadUserData } from '../utils/userData'
import { useI18n } from '../i18n'

const inputCls = 'input'

function ResetPasswordModal({ user, onClose }) {
  const { t } = useI18n()
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
  const { t } = useI18n()
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
  const { t } = useI18n()
  const [form, setForm] = useState({ username: '', password: '', role: 'staff', storeKeys: [] })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setError('')
    if (!form.username.trim() || form.password.length < 6) {
      setError(t('请填写用户名和至少 6 位密码'))
      return
    }
    setBusy(true)
    try {
      await api('/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          username: form.username.trim(),
          password: form.password,
          role: form.role,
          storeKeys: form.storeKeys,
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
              <option value="staff">{t('店员')}</option>
              <option value="cashier">{t('门店收银')}</option>
              <option value="manager">{t('店长·区域负责人')}</option>
              <option value="finance">{t('财务')}</option>
              <option value="public">{t('对外展示')}</option>
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
                onChange={(keys) => setForm((s) => ({ ...s, storeKeys: keys }))}
              />
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
  const { t } = useI18n()
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

function BindStaffModal({ user, onClose, onSaved }) {
  const { t } = useI18n()
  const staffList = employeeList('all')
  const staffOptions = [...new Map(staffList.map((s) => [`${s.storeKey}::${s.name}`, s])).values()]
  const [staffKey, setStaffKey] = useState(user.staffKey || '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setError('')
    setBusy(true)
    try {
      await api(`/admin/users/${user.id}/role`, {
        method: 'PUT',
        body: JSON.stringify({ role: user.role, storeKeys: user.storeKeys || [], staffKey }),
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
          <h3 className="text-lg font-bold text-slate-800">{t('绑定员工：{name}', { name: user.username })}</h3>
          <button
            onClick={onClose}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-50 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            aria-label={t('关闭')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-400">{t('一个账号只能绑定一个员工，绑定后仅可查看本人档案')}</p>
        <div className="mt-4">
          <select value={staffKey} onChange={(e) => setStaffKey(e.target.value)} className={inputCls}>
            <option value="">{t('不绑定员工')}</option>
            {staffOptions.map((s) => (
              <option key={`${s.storeKey}::${s.name}`} value={`${s.storeKey}::${s.name}`}>
                {s.name}（{storeName(s.storeKey)}）
              </option>
            ))}
          </select>
          {error && <p className="mt-2 text-xs font-medium text-rose-500">{error}</p>}
        </div>
        <div className="mt-5 flex gap-2">
          <button onClick={onClose} className="flex-1 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-200">
            {t('取消')}
          </button>
          <button onClick={submit} disabled={busy} className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-budu-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:opacity-50">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('保存')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function AccountAdminPage({ currentUser, onBack }) {
  const { t } = useI18n()
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [resetTarget, setResetTarget] = useState(null)
  const [bindTarget, setBindTarget] = useState(null)
  const [staffBindTarget, setStaffBindTarget] = useState(null)
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
    if (role === 'developer') return t('开发者')
    if (role === 'manager') return t('店长·区域负责人')
    if (role === 'staff') return t('店员')
    if (role === 'cashier') return t('门店收银')
    if (role === 'finance') return t('财务')
    if (role === 'public') return t('对外展示')
    return role
  }

  const changeRole = async (u, role) => {
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

  const changeTransferPermission = async (u) => {
    const enabled = !u.permissions?.inventoryTransferAll
    const action = enabled ? '授予' : '撤销'
    if (!window.confirm(t('确定{action}「{name}」库存调拨全权限吗？', { action, name: u.username }))) return
    setError('')
    try {
      await api(`/admin/users/${u.id}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({ inventoryTransferAll: enabled }),
      })
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

  const openStaffBind = async (u) => {
    try {
      await loadUserData()
    } catch {
      /* 忽略刷新失败 */
    }
    setStaffBindTarget(u)
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
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-2xl bg-white px-3.5 py-2.5 text-sm font-medium text-slate-500 shadow-card transition hover:text-budu-600"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('返回首页')}
        </button>
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-slate-800">
            <Shield className="h-5 w-5 text-budu-500" />
            {t('账号管理')}
          </h2>
          <p className="mt-0.5 text-[13px] text-slate-400">{t('查看与管理所有已注册账号')}</p>
        </div>
        <button
          onClick={() => setCreateOpen(true)}
          className="ml-auto flex items-center gap-1.5 rounded-xl bg-budu-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
        >
          <UserPlus className="h-4 w-4" />
          {t('新增账号')}
        </button>
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-4">
          <h3 className="flex items-center gap-2 text-[15px] font-bold text-slate-800">
            <Users className="h-4 w-4 text-budu-500" />
            {t('已注册账号')}
          </h3>
          <span className="rounded-lg bg-budu-50 px-2.5 py-1 text-xs font-semibold text-budu-600">{users.length}</span>
        </div>

        {error && <div className="border-b border-rose-50 bg-rose-50/60 px-5 py-3 text-xs font-medium text-rose-500">{error}</div>}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="bg-slate-50/80 text-xs text-slate-400">
                <th className="px-5 py-3 font-semibold">{t('用户名')}</th>
                <th className="px-4 py-3 font-semibold">{t('角色')}</th>
                <th className="px-4 py-3 font-semibold">{t('注册时间')}</th>
                <th className="px-4 py-3 text-right font-semibold">{t('操作')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {users.map((u) => {
                const isSelf = u.id === currentUser?.id
                return (
                  <tr key={u.id} className="transition-colors hover:bg-slate-50">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-xl bg-budu-500 text-xs font-bold text-white">
                          {u.avatar ? (
                            <img src={u.avatar} alt="" className="h-full w-full object-cover" />
                          ) : (
                            (u.username || '?').slice(0, 2).toUpperCase()
                          )}
                        </span>
                        <div className="leading-tight">
                          <p className="font-semibold text-slate-700">{u.username}</p>
                          {isSelf && <p className="text-[11px] font-medium text-budu-500">{t('当前账号')}</p>}
                          {u.role !== 'developer' && u.role !== 'public' && (
                            <p className="text-[11px] text-slate-400">
                              {Array.isArray(u.storeKeys) && u.storeKeys.length > 0
                                ? t('已绑定 {count} 家门店', { count: u.storeKeys.length })
                                : t('未绑定门店')}
                            </p>
                          )}
                          {u.role === 'staff' && (
                            <p className="text-[11px] text-slate-400">
                              {u.staffKey
                                ? t('已绑定员工：{name}', { name: u.staffKey.split('::')[1] || u.staffKey })
                                : t('未绑定员工')}
                            </p>
                          )}
                          {u.permissions?.inventoryTransferAll && (
                            <p className="text-[11px] font-medium text-emerald-600">{t('库存调拨全权限')}</p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={u.role}
                        disabled={isSelf}
                        onChange={(e) => changeRole(u, e.target.value)}
                        className="rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 outline-none transition focus:border-budu-400 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <option value="developer">{t('开发者')}</option>
                        <option value="manager">{t('店长·区域负责人')}</option>
                        <option value="staff">{t('店员')}</option>
                        <option value="cashier">{t('门店收银')}</option>
                        <option value="finance">{t('财务')}</option>
                        <option value="public">{t('对外展示')}</option>
                      </select>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {u.createdAt ? new Date(u.createdAt).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        {u.role !== 'public' && u.role !== 'developer' && u.role !== 'finance' && (
                          <button
                            onClick={() => changeTransferPermission(u)}
                            className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition ${
                              u.permissions?.inventoryTransferAll
                                ? 'bg-emerald-50 text-emerald-600 hover:bg-rose-50 hover:text-rose-500'
                                : 'text-slate-500 hover:bg-budu-50 hover:text-budu-600'
                            }`}
                          >
                            <Shield className="h-3.5 w-3.5" />
                            {t(u.permissions?.inventoryTransferAll ? '撤销调拨全权限' : '调拨全权限')}
                          </button>
                        )}
                        {u.role !== 'developer' && u.role !== 'public' && u.role !== 'finance' && (
                          <button
                            onClick={() => setBindTarget(u)}
                            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-slate-500 transition hover:bg-budu-50 hover:text-budu-600"
                          >
                            <MapPin className="h-3.5 w-3.5" />
                            {t('绑定门店')}
                          </button>
                        )}
                        {u.role === 'staff' && (
                          <button
                            onClick={() => openStaffBind(u)}
                            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-slate-500 transition hover:bg-budu-50 hover:text-budu-600"
                          >
                            <Users className="h-3.5 w-3.5" />
                            {t('绑定员工')}
                          </button>
                        )}
                        <button
                          onClick={() => setResetTarget(u)}
                          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-slate-500 transition hover:bg-budu-50 hover:text-budu-600"
                        >
                          <KeyRound className="h-3.5 w-3.5" />
                          {t('重置密码')}
                        </button>
                        <button
                          onClick={() => deleteUser(u)}
                          disabled={isSelf}
                          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-rose-400 transition hover:bg-rose-50 hover:text-rose-500 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          {t('删除账号')}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
              {!loading && users.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-12 text-center text-sm text-slate-300">
                    —
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {resetTarget && <ResetPasswordModal user={resetTarget} onClose={() => setResetTarget(null)} />}
      {bindTarget && (
        <BindStoresModal user={bindTarget} onClose={() => setBindTarget(null)} onSaved={load} />
      )}
      {staffBindTarget && (
        <BindStaffModal user={staffBindTarget} onClose={() => setStaffBindTarget(null)} onSaved={load} />
      )}
      {createOpen && <CreateUserModal onClose={() => setCreateOpen(false)} onCreated={load} />}
    </div>
  )
}
