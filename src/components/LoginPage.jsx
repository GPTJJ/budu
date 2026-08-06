import { useState } from 'react'
import { Eye, EyeOff, Loader2, Lock, LogIn, UserPlus, User } from 'lucide-react'
import { api } from '../utils/api'
import { useI18n } from '../i18n'

/** 登录 / 注册页（第一个注册的账号自动成为管理员） */
export default function LoginPage({ onLogin }) {
  const { t } = useI18n()
  const [mode, setMode] = useState('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPwd, setShowPwd] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const data = await api(`/auth/${mode}`, {
        method: 'POST',
        body: JSON.stringify({ username: username.trim(), password }),
      })
      onLogin(data.user)
    } catch (err) {
      setError(t(err.message))
    } finally {
      setBusy(false)
    }
  }

  const switchMode = (m) => {
    setMode(m)
    setError('')
  }

  const inputCls =
    'w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-10 pr-10 text-sm text-slate-700 outline-none transition focus:border-budu-400 focus:ring-2 focus:ring-budu-100'

  return (
    <div className="grid min-h-screen place-items-center bg-[#F7F4FA] px-4">
      <div className="w-full max-w-sm">
        <div className="card p-8">
          <div className="flex flex-col items-center text-center">
            <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-budu-500 to-grape-500 text-xl font-black text-white shadow-lg shadow-budu-200/60">
              B
            </div>
            <h1 className="mt-4 text-xl font-bold text-slate-800">{t('budu 甜蜜运营系统')}</h1>
            <p className="mt-1 text-xs text-slate-400">
              {mode === 'login' ? t('登录后查看门店经营数据（多设备共享）') : t('注册团队账号，首个账号为管理员')}
            </p>
          </div>

          <form onSubmit={submit} className="mt-6 space-y-4">
            <div className="relative">
              <User className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-300" />
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={t('用户名')}
                autoFocus
                autoComplete="username"
                className={inputCls}
              />
            </div>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-300" />
              <input
                type={showPwd ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('密码（至少 6 位）')}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                className={inputCls}
              />
              <button
                type="button"
                onClick={() => setShowPwd((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-300 transition hover:text-slate-500"
                aria-label={t('显示或隐藏密码')}
              >
                {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>

            {error && <p className="text-xs font-medium text-rose-500">{error}</p>}

            <button
              type="submit"
              disabled={busy || !username.trim() || password.length < 6}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-budu-500 to-grape-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-budu-200/60 transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : mode === 'login' ? (
                <LogIn className="h-4 w-4" />
              ) : (
                <UserPlus className="h-4 w-4" />
              )}
              {mode === 'login' ? t('登录') : t('注册并登录')}
            </button>
          </form>

          <p className="mt-5 text-center text-xs text-slate-400">
            {mode === 'login' ? t('还没有账号？') : t('已有账号？')}
            <button
              onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}
              className="ml-1 font-semibold text-budu-600 transition hover:text-budu-500"
            >
              {mode === 'login' ? t('注册一个') : t('去登录')}
            </button>
          </p>
        </div>
        <p className="mt-4 text-center text-[11px] text-slate-300">
          {t('© 2026 budu 甜品 · budu Operating System V1.0')}
        </p>
      </div>
    </div>
  )
}
