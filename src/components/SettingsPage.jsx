import { useEffect, useState } from 'react'
import { ArrowLeft, Bell, Database, Languages, Lock, MapPin, Plus, Server, Store, Trash2 } from 'lucide-react'
import { useI18n } from '../i18n'
import { APP_VERSION } from '../version'
import { api } from '../utils/api'
import { commitStores, getStores } from '../utils/userData'
import { allStores } from '../utils/selectors'

const inputCls = 'input'

export default function SettingsPage({ user, onBack }) {
  const { lang, setLang, t } = useI18n()
  const [storeName, setStoreName] = useState('')
  const [storeError, setStoreError] = useState('')
  const [version, setVersion] = useState(0)
  const [alertTip, setAlertTip] = useState('')
  const [sourceStores, setSourceStores] = useState([])
  const [sourceStore, setSourceStore] = useState('')
  const [sourceType, setSourceType] = useState('manual')
  const [sourceDate, setSourceDate] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const [sourceSaving, setSourceSaving] = useState(false)
  const [sourceTip, setSourceTip] = useState('')
  const [secOld, setSecOld] = useState('')
  const [secNew, setSecNew] = useState('')
  const [secConfirm, setSecConfirm] = useState('')
  const [secError, setSecError] = useState('')
  const [secTip, setSecTip] = useState('')
  const [secSaving, setSecSaving] = useState(false)
  const isDeveloper = user?.role === 'developer' || user?.role === 'finance' // 财务权限与开发者一致
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

  const sendTestAlert = async () => {
    setAlertTip('')
    try {
      const res = await api('/v2/alerts/test', { method: 'POST', body: JSON.stringify({}) })
      setAlertTip(res.configured ? t('测试消息已发送 ✓') : t('未配置 Webhook，仅返回站内状态'))
    } catch (err) {
      setAlertTip(t(err.message))
    }
  }

  const saveSecondPassword = async () => {
    if (!secOld.trim()) {
      setSecError('请输入当前登录密码')
      return
    }
    if (secNew.length < 6) {
      setSecError('二级密码至少 6 位')
      return
    }
    if (secNew !== secConfirm) {
      setSecError('两次输入的二级密码不一致')
      return
    }
    setSecSaving(true)
    setSecError('')
    setSecTip('')
    try {
      await api('/auth/second-password', {
        method: 'PUT',
        body: JSON.stringify({ oldPassword: secOld, newSecondPassword: secNew }),
      })
      setSecOld('')
      setSecNew('')
      setSecConfirm('')
      setSecTip('二级密码已保存')
    } catch (err) {
      setSecError(err.message)
    } finally {
      setSecSaving(false)
    }
  }

  useEffect(() => {
    if (!isDeveloper) return
    api('/v2/store-sales-sources')
      .then((data) => {
        const list = data.rows || []
        setSourceStores(list)
        if (list.length > 0) {
          setSourceStore((current) => current || list[0].storeKey)
        }
      })
      .catch((err) => setSourceTip(t(err.message)))
  }, [isDeveloper]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const row = sourceStores.find((s) => s.storeKey === sourceStore)
    if (row) {
      setSourceType(row.salesDataSource || 'manual')
      setSourceDate(row.salesDataSourceEffectiveDate || (() => {
        const d = new Date()
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      })())
    }
  }, [sourceStore, sourceStores])

  const saveSalesSource = async () => {
    if (!sourceStore) {
      setSourceTip(t('请选择门店'))
      return
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceDate)) {
      setSourceTip(t('请选择生效日期'))
      return
    }
    setSourceSaving(true)
    setSourceTip('')
    try {
      await api('/v2/store-sales-source', {
        method: 'PUT',
        body: JSON.stringify({
          storeKey: sourceStore,
          salesDataSource: sourceType,
          effectiveDate: sourceDate,
          reason: '设置页门店来源配置',
        }),
      })
      const data = await api('/v2/store-sales-sources')
      setSourceStores(data.rows || [])
      setSourceTip(t('门店销售数据来源已保存 ✓'))
    } catch (err) {
      setSourceTip(t(err.message))
    } finally {
      setSourceSaving(false)
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
          <h2 className="text-xl font-bold text-slate-800">{t('系统设置')}</h2>
          <p className="mt-0.5 text-[13px] text-slate-400">{t('管理系统偏好与显示选项')}</p>
        </div>
      </div>

      <div className="card p-6">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-budu-500 text-white shadow-md">
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
                ? 'bg-budu-500 text-white shadow-sm'
                : 'bg-slate-50 text-slate-500 hover:bg-budu-50 hover:text-budu-600'
            }`}
          >
            {t('中文')}
          </button>
          <button
            onClick={() => setLang('en')}
            className={`rounded-2xl px-4 py-3 text-sm font-semibold transition ${
              lang === 'en'
                ? 'bg-budu-500 text-white shadow-sm'
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
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-emerald-500 text-white shadow-md">
              <Bell className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-[15px] font-bold text-slate-800">{t('企业微信告警')}</h3>
              <p className="mt-0.5 text-xs text-slate-400">{t('配置 WECHAT_WORK_WEBHOOK_URL 后，库存/备份异常会推送到群')}</p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              onClick={sendTestAlert}
              className="rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-600"
            >
              {t('发送测试消息')}
            </button>
            {alertTip && <span className="text-xs font-medium text-slate-500">{alertTip}</span>}
          </div>
        </div>
      )}

      {isDeveloper && (
        <div className="card p-6">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-amber-500 text-white shadow-md">
              <Lock className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-[15px] font-bold text-slate-800">二级密码</h3>
              <p className="mt-0.5 text-xs text-slate-400">用于删除雇员等高风险操作，防止误删；忘记时可用当前登录密码重新设置</p>
            </div>
          </div>
          <div className="mt-4 grid max-w-xl gap-3 sm:grid-cols-3">
            <label className="block text-xs font-semibold text-slate-500">当前登录密码
              <input type="password" value={secOld} onChange={(e) => setSecOld(e.target.value)} className="input mt-1 w-full" />
            </label>
            <label className="block text-xs font-semibold text-slate-500">新二级密码（至少 6 位）
              <input type="password" value={secNew} onChange={(e) => setSecNew(e.target.value)} className="input mt-1 w-full" />
            </label>
            <label className="block text-xs font-semibold text-slate-500">确认新二级密码
              <input type="password" value={secConfirm} onChange={(e) => setSecConfirm(e.target.value)} className="input mt-1 w-full" />
            </label>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button onClick={saveSecondPassword} disabled={secSaving} className="rounded-xl bg-budu-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:opacity-50">
              {secSaving ? '保存中…' : '保存二级密码'}
            </button>
            {secError && <span className="text-xs font-medium text-rose-500">{secError}</span>}
            {secTip && <span className="text-xs font-medium text-emerald-600">{secTip}</span>}
          </div>
        </div>
      )}

      {isDeveloper && (
        <div className="card p-6">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-rose-500 text-white shadow-md">
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
              className="input sm:max-w-xs"
            />
            <button
              onClick={addStore}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-budu-500 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
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
                  <MapPin className="h-4 w-4 shrink-0 text-budu-600" />
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

      {isDeveloper && (
        <div className="card p-6">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-violet-500 text-white shadow-md">
              <Store className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-[15px] font-bold text-slate-800">POS 试点门店配置</h3>
              <p className="mt-0.5 text-xs text-slate-400">按门店设置营业数据来源：人工录入 / POS 自动同步 / 混合模式（生效日期起生效，历史日报不受影响）</p>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-4">
            <label className="block text-xs font-semibold text-slate-500">门店
              <select value={sourceStore} onChange={(e) => setSourceStore(e.target.value)} className="input mt-1">
                {sourceStores.map((s) => <option key={s.storeKey} value={s.storeKey}>{s.storeName}</option>)}
              </select>
            </label>
            <label className="block text-xs font-semibold text-slate-500">销售数据来源
              <select value={sourceType} onChange={(e) => setSourceType(e.target.value)} className="input mt-1">
                <option value="manual">人工录入（暂未接入 POS）</option>
                <option value="pos">POS 自动同步</option>
                <option value="hybrid">混合模式（POS + 管理员调整）</option>
              </select>
            </label>
            <label className="block text-xs font-semibold text-slate-500">生效日期
              <input type="date" value={sourceDate} onChange={(e) => setSourceDate(e.target.value)} className="input mt-1" />
            </label>
            <div className="flex items-end">
              <button onClick={saveSalesSource} disabled={sourceSaving || sourceStores.length === 0} className="w-full rounded-xl bg-budu-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {sourceSaving ? '保存中…' : '保存配置'}
              </button>
            </div>
          </div>
          {sourceTip && <p className="mt-3 text-xs font-medium text-slate-500">{sourceTip}</p>}
          {sourceStores.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {sourceStores.map((s) => (
                <span key={s.storeKey} className={`rounded-full px-3 py-1 text-xs font-semibold ${s.salesDataSource === 'pos' ? 'bg-emerald-50 text-emerald-600' : s.salesDataSource === 'hybrid' ? 'bg-violet-50 text-violet-600' : 'bg-slate-100 text-slate-500'}`}>
                  {s.storeName} · {s.salesDataSource === 'pos' ? 'POS' : s.salesDataSource === 'hybrid' ? '混合' : '人工'}{s.salesDataSourceEffectiveDate ? `（${s.salesDataSourceEffectiveDate} 起）` : ''}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="card p-6">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-budu-500 text-white shadow-md">
            <Server className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-[15px] font-bold text-slate-800">
              {t('budu Operating System {version}', { version: APP_VERSION })}
            </h3>
            <p className="mt-0.5 text-xs text-slate-400">
              {t('版本')} · {t('数据来源')}
            </p>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-2 rounded-2xl bg-slate-50/80 px-4 py-3 text-xs text-slate-500">
          <Database className="h-4 w-4 shrink-0 text-budu-600" />
          {t('budu OS文档（三店4-7月报表 / 薪资表27-31周）')}
        </div>
      </div>
    </div>
  )
}
