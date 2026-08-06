import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { en, interpolate } from './locales'

const STORAGE_KEY = 'budu-os-lang'
const I18nContext = createContext(null)

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'zh'
    } catch {
      return 'zh'
    }
  })

  const setLang = useCallback((next) => {
    const value = next === 'en' ? 'en' : 'zh'
    setLangState(value)
    try {
      localStorage.setItem(STORAGE_KEY, value)
    } catch {
      /* 忽略存储失败 */
    }
  }, [])

  useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.lang = lang
  }, [lang])

  const t = useCallback(
    (key, vars) => {
      const template = lang === 'en' ? en[key] || key : key
      return interpolate(template, vars)
    },
    [lang],
  )

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}

export const WEEK_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
