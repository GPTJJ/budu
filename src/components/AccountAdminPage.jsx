import { useEffect, useState } from 'react'
import { ArrowLeft, KeyRound, Loader2, Shield, Trash2, Users, X } from 'lucide-react'
import { api } from '../utils/api'
import { useI18n } from '../i18n'

const inputCls =
  'w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-budu-400 focus:ring-2 focus:ring-budu-100'

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
      <div className="relative w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl">
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
            className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-budu-500 to-grape-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-budu-200/60 transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
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
    if (role === 'owner') return t('最高权限')
    if (role === 'admin') return t('管理员')
    return t('门店运营')
  }

  const changeRole = async (u, role) => {
    if (!window.confirm(t('确定将「{name}」的权限改为「{role}」吗？', { name: u.username, role: roleLabel(role) }))) {
      return
    }
    setError('')
    try {
      await api(`/admin/users/${u.id}/role`, { method: 'PUT', body: JSON.stringify({ role }) })
      await load()
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
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-4">
          <h3 className="flex items-center gap-2 text-[15px] font-bold text-slate-800">
            <Users className="h-4 w-4 text-grape-500" />
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
                  <tr key={u.id} className="transition-colors hover:bg-budu-50/40">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-xl bg-gradient-to-br from-budu-400 to-grape-500 text-xs font-bold text-white">
                          {u.avatar ? (
                            <img src={u.avatar} alt="" className="h-full w-full object-cover" />
                          ) : (
                            (u.username || '?').slice(0, 2).toUpperCase()
                          )}
                        </span>
                        <div className="leading-tight">
                          <p className="font-semibold text-slate-700">{u.username}</p>
                          {isSelf && <p className="text-[11px] font-medium text-budu-500">{t('当前账号')}</p>}
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
                        <option value="owner">{t('最高权限')}</option>
                        <option value="admin">{t('管理员')}</option>
                        <option value="member">{t('门店运营')}</option>
                      </select>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {u.createdAt ? new Date(u.createdAt).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
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
    </div>
  )
}
