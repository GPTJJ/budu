import { useState } from 'react'
import { ArrowLeft, Database, Languages, MapPin, Plus, Server, Trash2 } from 'lucide-react'
import { useI18n } from '../i18n'
import { commitStores, getStores } from '../utils/userData'
import { allStores } from '../utils/selectors'

export default function SettingsPage({ user, onBack }) {
  const { lang, setLang, t } = useI18n()
  const [storeName, setStoreName] = useState('')
  const [storeError, setStoreError] = useState('')
  const [version, setVersion] = useState(0)
  const isDeveloper = user?.role === 'developer'
  const customStores = getStores()

  const addStore = () => {
    const name = storeName.trim()
    if (!name) {
      setStoreError(t('请输入门店名称'))
      return
    }
    if (allStores().some((s) => s.name === name)) {
      setStoreError(t('该门店已存在'))
      return
    }
    const key = `store-${Date.now().toString(36)}`
    commitStores([...customStores, { key, name }])
    setStoreName('')
    setStoreError('')
    setVersion((v) => v + 1)
  }

  const removeStore = (key, name) => {
    if (!window.confirm(t('确定删除门店「{name}」吗？', { name }))) return
    commitStores(customStores.filter((s) => s.key !== key))
    setVersion((v) => v + 1)
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
          <h2 className="text-xl font-bold text-slate-800">{t('系统设置')}</h2>
          <p className="mt-0.5 text-[13px] text-slate-400">{t('管理系统偏好与显示选项')}</p>
        </div>
      </div>

      <div className="card p-6">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-budu-400 to-grape-500 text-white shadow-md">
            <Languages className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-[15px] font-bold text-slate-800">{t('界面语言')}</h3>
            <p className="mt-0.5 text-xs text-slate-400">{t('切换后立即生效，并保存在本机浏览器')}</p>
          </div>
        </div>

        <div className="mt-5 grid max-w-sm grid-cols-2 gap-2.5">
          <button
            onClick={() => setLang('zh')}
            className={`rounded-2xl px-4 py-3 text-sm font-semibold transition ${
              lang === 'zh'
                ? 'bg-gradient-to-r from-budu-500 to-grape-500 text-white shadow-lg shadow-budu-200/60'
                : 'bg-slate-50 text-slate-500 hover:bg-budu-50 hover:text-budu-600'
            }`}
          >
            {t('中文')}
          </button>
          <button
            onClick={() => setLang('en')}
            className={`rounded-2xl px-4 py-3 text-sm font-semibold transition ${
              lang === 'en'
                ? 'bg-gradient-to-r from-budu-500 to-grape-500 text-white shadow-lg shadow-budu-200/60'
                : 'bg-slate-50 text-slate-500 hover:bg-budu-50 hover:text-budu-600'
            }`}
          >
            {t('English')}
          </button>
        </div>
      </div>

      {isDeveloper && (
        <div className="card p-6">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-amber-400 to-rose-500 text-white shadow-md">
              <MapPin className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-[15px] font-bold text-slate-800">{t('门店管理')}</h3>
              <p className="mt-0.5 text-xs text-slate-400">{t('新增门店后将同步到首页、业绩录入与人员身份')}</p>
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-2.5 sm:flex-row">
            <input
              value={storeName}
              onChange={(e) => setStoreName(e.target.value)}
              placeholder={t('门店名称')}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-budu-400 focus:ring-2 focus:ring-budu-100 sm:max-w-xs"
            />
            <button
              onClick={addStore}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-budu-500 to-grape-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-budu-200/60 transition hover:opacity-90"
            >
              <Plus className="h-4 w-4" />
              {t('新增门店')}
            </button>
          </div>
          {storeError && <p className="mt-2 text-xs font-medium text-rose-500">{storeError}</p>}

          {customStores.length > 0 && (
            <div className="mt-4 space-y-2">
              {customStores.map((s) => (
                <div
                  key={s.key}
                  className="flex items-center gap-3 rounded-xl bg-slate-50/80 px-4 py-2.5 text-sm"
                >
                  <MapPin className="h-4 w-4 shrink-0 text-budu-400" />
                  <span className="min-w-0 flex-1 truncate font-semibold text-slate-700">{s.name}</span>
                  <button
                    onClick={() => removeStore(s.key, s.name)}
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"
                    aria-label={t('删除')}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="card p-6">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-grape-400 to-budu-500 text-white shadow-md">
            <Server className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-[15px] font-bold text-slate-800">{t('budu Operating System V1.0')}</h3>
            <p className="mt-0.5 text-xs text-slate-400">
              {t('版本')} · {t('数据来源')}
            </p>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-2 rounded-2xl bg-slate-50/80 px-4 py-3 text-xs text-slate-500">
          <Database className="h-4 w-4 shrink-0 text-budu-400" />
          {t('budu OS文档（三店4-7月报表 / 薪资表27-31周）')}
        </div>
      </div>
    </div>
  )
}
