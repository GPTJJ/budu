import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

const PublicModeContext = createContext(false)
const StorePrivacyContext = createContext(false)
const PrivacyModeContext = createContext(null)

export const PRIVACY_AUTO_LOCK_MS = 30_000

function isEditableElement(target) {
  if (!target || typeof target !== 'object') return false
  const tagName = String(target.tagName || '').toUpperCase()
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return true
  if (target.isContentEditable) return true
  if (typeof target.closest === 'function' && target.closest('[contenteditable="true"]')) return true
  return false
}

export function PublicModeProvider({
  isPublic,
  isStore = false,
  defaultPrivacyMode = true,
  autoLockMs = PRIVACY_AUTO_LOCK_MS,
  children,
}) {
  const isLockedByRole = Boolean(isPublic || isStore)
  const [privacyMode, setPrivacyModeState] = useState(() => Boolean(defaultPrivacyMode))
  const [autoLockRemainingSec, setAutoLockRemainingSec] = useState(0)
  const deadlineRef = useRef(0)

  const setPrivacyMode = useCallback(
    (next) => {
      if (isLockedByRole) {
        setPrivacyModeState(true)
        return
      }
      setPrivacyModeState((prev) => (typeof next === 'function' ? Boolean(next(prev)) : Boolean(next)))
    },
    [isLockedByRole],
  )

  const togglePrivacyMode = useCallback(() => {
    if (isLockedByRole) return
    setPrivacyModeState((prev) => !prev)
  }, [isLockedByRole])

  useEffect(() => {
    if (isLockedByRole) setPrivacyModeState(true)
  }, [isLockedByRole])

  // 全局快捷键 Shift + H 一键切换防窥状态（输入框聚焦或受限账号时不触发）
  useEffect(() => {
    if (typeof window === 'undefined' || isLockedByRole) return undefined
    const onKeyDown = (event) => {
      if (event.defaultPrevented || event.repeat) return
      if (event.metaKey || event.ctrlKey || event.altKey || !event.shiftKey) return
      const isKeyH = event.key === 'H' || event.key === 'h' || event.code === 'KeyH'
      if (!isKeyH) return
      if (isEditableElement(event.target) || isEditableElement(document.activeElement)) return
      event.preventDefault()
      togglePrivacyMode()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isLockedByRole, togglePrivacyMode])

  // 手动关闭防窥（显示明文金额）后，启动 30 秒无操作倒计时，倒计时结束自动重新开启防窥
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    if (isLockedByRole || privacyMode) {
      deadlineRef.current = 0
      setAutoLockRemainingSec(0)
      return undefined
    }

    const duration = Math.max(1000, Number(autoLockMs) || PRIVACY_AUTO_LOCK_MS)
    let lockTimerId = null
    let lastResetAt = 0

    const scheduleLock = () => {
      if (lockTimerId != null) window.clearTimeout(lockTimerId)
      deadlineRef.current = Date.now() + duration
      setAutoLockRemainingSec(Math.ceil(duration / 1000))
      lockTimerId = window.setTimeout(() => {
        deadlineRef.current = 0
        setAutoLockRemainingSec(0)
        setPrivacyModeState(true)
      }, duration)
    }

    const onUserActivity = () => {
      const now = Date.now()
      if (now - lastResetAt < 400) return
      lastResetAt = now
      scheduleLock()
    }

    scheduleLock()

    const tickId = window.setInterval(() => {
      if (!deadlineRef.current) return
      const left = Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000))
      setAutoLockRemainingSec(left)
    }, 1000)

    const activityEvents = ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll']
    for (const evt of activityEvents) {
      window.addEventListener(evt, onUserActivity, { passive: true, capture: true })
    }

    return () => {
      if (lockTimerId != null) window.clearTimeout(lockTimerId)
      window.clearInterval(tickId)
      for (const evt of activityEvents) {
        window.removeEventListener(evt, onUserActivity, { capture: true })
      }
    }
  }, [privacyMode, isLockedByRole, autoLockMs])

  const effectivePrivacy = isLockedByRole || privacyMode

  const privacyValue = useMemo(
    () => ({
      privacyMode: effectivePrivacy,
      effectivePrivacy,
      isLockedByRole,
      autoLockRemainingSec,
      setPrivacyMode,
      togglePrivacyMode,
    }),
    [effectivePrivacy, isLockedByRole, autoLockRemainingSec, setPrivacyMode, togglePrivacyMode],
  )

  return (
    <StorePrivacyContext.Provider value={isStore}>
      <PublicModeContext.Provider value={isPublic}>
        <PrivacyModeContext.Provider value={privacyValue}>{children}</PrivacyModeContext.Provider>
      </PublicModeContext.Provider>
    </StorePrivacyContext.Provider>
  )
}

export function usePublicMode() {
  return useContext(PublicModeContext)
}

export function useStorePrivacy() {
  return useContext(StorePrivacyContext)
}

export function usePrivacyMode() {
  const ctx = useContext(PrivacyModeContext)
  const isPublic = useContext(PublicModeContext)
  const isStore = useContext(StorePrivacyContext)
  if (ctx) return ctx
  const fallbackLocked = Boolean(isPublic || isStore)
  return {
    privacyMode: true,
    effectivePrivacy: true,
    isLockedByRole: fallbackLocked,
    autoLockRemainingSec: 0,
    setPrivacyMode: () => {},
    togglePrivacyMode: () => {},
  }
}
