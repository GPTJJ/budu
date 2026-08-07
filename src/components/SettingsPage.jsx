import { useEffect, useState } from 'react'
import { ArrowLeft, Bell, Database, Languages, MapPin, Plus, Server, Trash2 } from 'lucide-react'
import { useI18n } from '../i18n'
import { api } from '../utils/api'
import { commitStores, getStores } from '../utils/userData'
import { allStores } from '../utils/selectors'

const inputCls =
  'w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-budu-400 focus:ring-2 focus:ring-budu-100'

export default function SettingsPage({ user, onBack }) {
  const { lang, setLang, t } = useI18n()
  const [storeName, setStoreName] = useState('')
  const [storeError, setStoreError] = useState('')
  const [version, setVersion] = useState(0)
  const [alertTip, setAlertTip] = useState('')
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

  const sendTestAlert = async () => {
    setAlertTip('')
    try {
      const res = await api('/v2/alerts/test', { method: 'POST', body: JSON.stringify({}) })
      setAlertTip(res.configured ? t('测试消息已发送 ✓') : t('未配置 Webhook，仅返回站内状态'))
    } catch (err) {
      setAlertTip(t(err.message))
    }
  }

  const [mt, setMt] = useState(null)
  const [mtForm, setMtForm] = useState({ meituanStoreId: '', storeKey: allStores()[0]?.key || '' })
  const [mtMsg, setMtMsg] = useState('')
  const [unmapped, setUnmapped] = useState([])
  const [dmForm, setDmForm] = useState({ dishName: '', productName: '' })

  const loadMt = async () => {
    try {
      const d = await api('/v2/meituan/status')
      setMt(d)
      const u = await api('/v2/meituan/dish-unmapped')
      setUnmapped((u && u.rows) || [])
    } catch (err) {
      setMtMsg(t(err.message))
    }
  }

  useEffect(() => {
    if (isDeveloper) loadMt()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDeveloper])

  const addMeituanMapping = async () => {
    setMtMsg('')
    const id = mtForm.meituanStoreId.trim()
    if (!id) {
      setMtMsg(t('请填写美团店铺ID'))
      return
    }
    try {
      const mappings = [
        ...((mt && mt.mappings) || []).filter((m) => m.meituanStoreId !== id),
        { meituanStoreId: id, storeKey: mtForm.storeKey, enabled: true },
      ]
      await api('/v2/meituan/mappings', { method: 'PUT', body: JSON.stringify({ mappings }) })
      setMtForm((s) => ({ ...s, meituanStoreId: '' }))
      await loadMt()
    } catch (err) {
      setMtMsg(t(err.message))
    }
  }

  const syncMeituanNow = async () => {
    setMtMsg('')
    try {
      const d = await api('/v2/meituan/sync-now', { method: 'POST', body: JSON.stringify({}) })
      setMtMsg(d.message + (d.sample ? t('（模拟样例：营业额 ¥{amount}，{ord} 单）', { amount: (d.sample.incCents / 100).toFixed(2), ord: d.sample.ord }) : ''))
      await loadMt()
    } catch (err) {
      setMtMsg(t(err.message))
    }
  }

  const saveDishMapping = async () => {
    setMtMsg('')
    if (!dmForm.dishName || !dmForm.productName.trim()) {
      setMtMsg(t('请选择美团菜品并填写映射商品'))
      return
    }
    try {
      await api('/v2/meituan/dish-mappings', {
        method: 'PUT',
        body: JSON.stringify({ mappings: [{ dishName: dmForm.dishName, productName: dmForm.productName.trim() }] }),
      })
      setDmForm({ dishName: '', productName: '' })
      await loadMt()
    } catch (err) {
      setMtMsg(t(err.message))
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
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-emerald-400 to-teal-500 text-white shadow-md">
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
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-md">
              <Bell className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-[15px] font-bold text-slate-800">{t('美团收银对接')}</h3>
              <p className="mt-0.5 text-xs text-slate-400">
                {mt
                  ? mt.configured
                    ? t('已配置 · 每 5 分钟自动同步')
                    : t('模拟模式 · 未配置美团凭证')
                  : t('加载中…')}
              </p>
            </div>
            <div className="ml-auto flex gap-2">
              <button
                onClick={syncMeituanNow}
                className="rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-amber-600"
              >
                {t('立即同步')}
              </button>
            </div>
          </div>

          {mtMsg && <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-xs font-medium text-slate-600">{mtMsg}</p>}

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-2xl bg-slate-50/70 p-4">
              <p className="mb-2 text-xs font-semibold text-slate-500">{t('门店映射')}</p>
              <div className="space-y-1.5">
                {((mt && mt.mappings) || []).map((m) => (
                  <div key={m.meituanStoreId} className="flex items-center justify-between rounded-lg bg-white px-3 py-2 text-xs">
                    <span className="font-semibold text-slate-700">{m.meituanStoreId}</span>
                    <span className="text-slate-400">→ {storeName(m.storeKey)}</span>
                    <span className={m.enabled ? 'text-emerald-600' : 'text-slate-400'}>
                      {m.enabled ? t('启用') : t('停用')}
                    </span>
                  </div>
                ))}
                {(!mt || !mt.mappings || mt.mappings.length === 0) && (
                  <p className="py-3 text-center text-xs text-slate-300">{t('暂无映射，请添加')}</p>
                )}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <input
                  value={mtForm.meituanStoreId}
                  onChange={(e) => setMtForm((s) => ({ ...s, meituanStoreId: e.target.value }))}
                  placeholder={t('美团店铺ID')}
                  className={`${inputCls} flex-1`}
                />
                <select value={mtForm.storeKey} onChange={(e) => setMtForm((s) => ({ ...s, storeKey: e.target.value }))} className={`${inputCls} w-40`}>
                  {allStores().map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <button onClick={addMeituanMapping} className="rounded-xl bg-amber-500 px-4 py-2 text-xs font-semibold text-white transition hover:bg-amber-600">
                  {t('添加映射')}
                </button>
              </div>
            </div>

            <div className="rounded-2xl bg-slate-50/70 p-4">
              <p className="mb-2 text-xs font-semibold text-slate-500">{t('最近同步')}</p>
              <div className="max-h-40 space-y-1.5 overflow-y-auto">
                {((mt && mt.logs) || []).map((l) => (
                  <div key={l.id} className="rounded-lg bg-white px-3 py-2 text-[11px]">
                    <p className={`font-semibold ${l.status === 'ok' ? 'text-emerald-600' : 'text-rose-500'}`}>
                      {l.storeKey} · {l.day} · {l.status === 'ok' ? t('成功') : t('失败')}
                    </p>
                    <p className="mt-0.5 truncate text-slate-400">{l.message}</p>
                  </div>
                ))}
                {(!mt || !mt.logs || mt.logs.length === 0) && (
                  <p className="py-3 text-center text-xs text-slate-300">{t('暂无同步记录')}</p>
                )}
              </div>

              <p className="mb-2 mt-4 text-xs font-semibold text-slate-500">{t('菜品待匹配')}</p>
              <div className="flex flex-wrap gap-2">
                <select value={dmForm.dishName} onChange={(e) => setDmForm((s) => ({ ...s, dishName: e.target.value }))} className={`${inputCls} flex-1`}>
                  <option value="">{t('选择美团菜品')}</option>
                  {unmapped.map((u) => (
                    <option key={u.dishName} value={u.dishName}>
                      {u.dishName}（{u.sales}）
                    </option>
                  ))}
                </select>
                <input
                  value={dmForm.productName}
                  onChange={(e) => setDmForm((s) => ({ ...s, productName: e.target.value }))}
                  placeholder={t('映射到商品名')}
                  className={`${inputCls} flex-1`}
                />
                <button onClick={saveDishMapping} className="rounded-xl bg-budu-500 px-4 py-2 text-xs font-semibold text-white transition hover:bg-budu-600">
                  {t('保存映射')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

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
