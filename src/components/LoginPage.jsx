import { useState } from 'react'
import { Eye, EyeOff, Loader2, Lock, LogIn, User } from 'lucide-react'
import { api } from '../utils/api'
import { t } from '../utils/text'
import PwaInstallPrompt from './PwaInstallPrompt'
import ComplianceFooter from './ComplianceFooter'
import wordmarkUrl from '../../brand/web/budu-wordmark.svg'

/** 登录页（自助注册已关闭，新账号由开发者创建） */
export default function LoginPage({ onLogin }) {
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
      const data = await api('/auth/login', {
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

  const inputCls = 'input py-2.5 pl-10 pr-10'

  return (
    <div
      className="grid min-h-screen min-h-[100dvh] place-items-center bg-canvas px-3 py-6 sm:px-4"
      style={{ paddingTop: 'max(1.5rem, env(safe-area-inset-top))', paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}
    >
      <div className="w-full max-w-sm">
        <div className="card p-6 sm:p-8">
          <div className="flex flex-col items-center text-center">
            <img src={wordmarkUrl} alt="budu" className="h-auto w-28" />
            <h1 className="mt-4 text-xl font-bold text-slate-800">{t('Operating System 运营系统')}</h1>
            <p className="mt-1 text-xs text-slate-400">{t('登录后查看门店经营数据（多设备共享）')}</p>
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
                autoComplete="current-password"
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
              className="btn-primary w-full px-4 py-2.5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <LogIn className="h-4 w-4" />
              )}
              {t('登录')}
            </button>
          </form>

          <p className="mt-5 text-center text-xs text-slate-400">
            {t('新账号由开发者创建，如需开通请联系管理员')}
          </p>
        </div>
        <ComplianceFooter className="mt-4" />
      </div>
      <PwaInstallPrompt />
    </div>
  )
}
