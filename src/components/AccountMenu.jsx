import { useState } from 'react'
import { ChevronDown, Image as ImageIcon, KeyRound, Loader2, LogOut, RefreshCw, Upload, Users, X } from 'lucide-react'
import { api } from '../utils/api'
import { t } from '../utils/text'
import { ROLE_LABELS, canManageAccounts } from '../../shared/accountPermissions'

const inputCls = 'input'

function ModalShell({ title, onClose, children }) {
  return (
    <div data-budu-overlay-root className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="budu-overlay-backdrop absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label={title} className="budu-overlay-scroll relative max-h-[calc(100dvh-2rem)] w-full max-w-md rounded-2xl bg-white p-6 shadow-lg">
        <div className="flex items-start justify-between gap-4">
          <h3 className="text-lg font-bold text-slate-800">{title}</h3>
          <button
            onClick={onClose}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-50 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            aria-label={t('关闭')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="mt-5">{children}</div>
      </div>
    </div>
  )
}

function PasswordModal({ onClose }) {
  const [oldPassword, setOldPassword] = useState('')
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
      await api('/auth/me', { method: 'PUT', body: JSON.stringify({ oldPassword, newPassword }) })
      setOk(t('密码修改成功'))
      setTimeout(onClose, 1200)
    } catch (err) {
      setError(t(err.message))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalShell title={t('修改密码')} onClose={onClose}>
      <div className="space-y-3">
        <input
          type="password"
          value={oldPassword}
          onChange={(e) => setOldPassword(e.target.value)}
          placeholder={t('当前密码')}
          className={inputCls}
        />
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
          disabled={busy || !oldPassword || newPassword.length < 6 || !confirm}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-budu-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {t('保存')}
        </button>
      </div>
    </ModalShell>
  )
}

function ProfileModal({ mode, user, onUserChange, onClose }) {
  const [username, setUsername] = useState(user?.username || '')
  const [avatar, setAvatar] = useState(user?.avatar || '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const initial = (user?.username || 'B').slice(0, 2).toUpperCase()

  const handleFile = (e) => {
    const file = e.target.files && e.target.files[0]
    if (!file || !file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const size = 256
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        const scale = Math.max(size / img.width, size / img.height)
        const w = img.width * scale
        const h = img.height * scale
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h)
        setAvatar(canvas.toDataURL('image/jpeg', 0.85))
      }
      img.src = reader.result
    }
    reader.readAsDataURL(file)
  }

  const submit = async () => {
    setError('')
    const body = {}
    if (mode === 'username') {
      const name = username.trim()
      if (name.length < 2 || name.length > 20) {
        setError(t('用户名需为 2-20 个字符'))
        return
      }
      body.username = name
    } else {
      if (!avatar) {
        setError(t('请选择一张图片'))
        return
      }
      body.avatar = avatar
    }
    setBusy(true)
    try {
      const data = await api('/auth/me', { method: 'PUT', body: JSON.stringify(body) })
      onUserChange(data.user)
      onClose()
    } catch (err) {
      setError(t(err.message))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalShell title={mode === 'avatar' ? t('修改头像') : t('修改用户名')} onClose={onClose}>
      {mode === 'avatar' ? (
        <div className="flex flex-col items-center gap-3">
          <div className="grid h-24 w-24 place-items-center overflow-hidden rounded-full bg-budu-500 text-2xl font-bold text-white shadow-lg">
            {avatar ? <img src={avatar} alt="" className="h-full w-full object-cover" /> : initial}
          </div>
          <label className="flex cursor-pointer items-center gap-1.5 rounded-xl bg-budu-50 px-4 py-2 text-sm font-semibold text-budu-600 transition hover:bg-budu-100">
            <Upload className="h-4 w-4" />
            {t('选择图片')}
            <input type="file" accept="image/*" className="hidden" onChange={handleFile} />
          </label>
          <p className="text-center text-xs text-slate-400">{t('支持从本机选择图片，自动裁剪为方形头像')}</p>
        </div>
      ) : (
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={t('用户名')}
          className={inputCls}
          autoFocus
        />
      )}
      {error && <p className="mt-3 text-xs font-medium text-rose-500">{error}</p>}
      <button
        onClick={submit}
        disabled={busy}
        className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-xl bg-budu-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {t('保存')}
      </button>
    </ModalShell>
  )
}

function MenuButton({ icon: Icon, label, onClick, danger }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] font-medium transition ${
        danger ? 'text-rose-500 hover:bg-rose-50' : 'text-slate-600 hover:bg-budu-50 hover:text-budu-700'
      }`}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {label}
    </button>
  )
}

export default function AccountMenu({ user, onUserChange, onLogout, onManageAccounts, variant = 'header' }) {
  const [open, setOpen] = useState(false)
  const [modal, setModal] = useState(null)
  const name = user?.username || t('伙伴')
  const initial = name.slice(0, 2).toUpperCase()
  const roleText = t(ROLE_LABELS[user?.role] || '账号')
  const avatar = user?.avatar

  const close = () => setOpen(false)

  const handleLogout = () => {
    if (window.confirm(t('确定要退出登录吗？'))) {
      close()
      onLogout()
    }
  }

  const handleSwitch = () => {
    if (window.confirm(t('确定要切换账号吗？'))) {
      close()
      onLogout()
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 rounded-2xl p-1.5 text-left transition hover:bg-slate-50"
        aria-label={t('打开账号菜单')}
      >
        <span className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-2xl bg-budu-500 text-sm font-bold text-white shadow-md">
          {avatar ? <img src={avatar} alt="" className="h-full w-full object-cover" /> : initial}
        </span>
        <span className="hidden min-w-0 flex-1 text-left sm:block">
          <span className="block truncate text-[13px] font-semibold text-slate-700">{name}</span>
          <span className="block truncate text-[11px] text-slate-400">{roleText}</span>
        </span>
        <ChevronDown
          className={`ml-auto h-3.5 w-3.5 shrink-0 text-slate-300 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} />
          <div
            className={`absolute z-50 w-56 overflow-hidden rounded-2xl border border-slate-100 bg-white p-1.5 shadow-lg ${
              variant === 'sidebar' ? 'bottom-full left-0 mb-2' : 'right-0 top-full mt-2'
            }`}
          >
            <div className="px-3 py-2">
              <p className="truncate text-sm font-bold text-slate-800">{name}</p>
              <p className="truncate text-[11px] text-slate-400">{roleText}</p>
            </div>
            <div className="my-1 h-px bg-slate-100" />
            <MenuButton icon={KeyRound} label={t('修改密码')} onClick={() => { close(); setModal('password') }} />
            <MenuButton icon={ImageIcon} label={t('修改头像')} onClick={() => { close(); setModal('avatar') }} />
            {canManageAccounts(user) && onManageAccounts && (
              <MenuButton
                icon={Users}
                label={t('账号管理')}
                onClick={() => {
                  close()
                  onManageAccounts()
                }}
              />
            )}
            <div className="my-1 h-px bg-slate-100" />
            <MenuButton icon={RefreshCw} label={t('切换账号')} onClick={handleSwitch} />
            <MenuButton icon={LogOut} label={t('退出登录')} danger onClick={handleLogout} />
          </div>
        </>
      )}

      {modal === 'password' && <PasswordModal onClose={() => setModal(null)} />}
      {modal === 'avatar' && (
        <ProfileModal mode="avatar" user={user} onUserChange={onUserChange} onClose={() => setModal(null)} />
      )}
      {modal === 'username' && (
        <ProfileModal mode="username" user={user} onUserChange={onUserChange} onClose={() => setModal(null)} />
      )}
    </div>
  )
}
