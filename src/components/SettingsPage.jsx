import { ArrowLeft, Database, Languages, Server } from 'lucide-react'
import { useI18n } from '../i18n'

export default function SettingsPage({ onBack }) {
  const { lang, setLang, t } = useI18n()

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
