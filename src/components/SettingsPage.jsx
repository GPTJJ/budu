import { useEffect, useState } from 'react'
import { ArrowLeft, Bell, Database, Lock, MessageCircle, Server, Store } from 'lucide-react'
import { t } from '../utils/text'
import { APP_VERSION } from '../version'
import { api } from '../utils/api'
import BuduSuccessFeedback from './feedback/BuduSuccessFeedback'
import { DeletedRecordsCenter } from './DeveloperSafeDelete'

const inputCls = 'input'

export default function SettingsPage({ user, onBack }) {
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
  // 微信绑定状态
  const [wxBindings, setWxBindings] = useState(null)
  const [wxTip, setWxTip] = useState('')
  const [feedback, setFeedback] = useState(null)
  const [wxBusy, setWxBusy] = useState(false)
  // 管理员手动绑定（企微 userid，跳过扫码）
  const [manualUsername, setManualUsername] = useState('')
  const [manualUserid, setManualUserid] = useState('')
  const [manualBusy, setManualBusy] = useState(false)
  const [manualTip, setManualTip] = useState('')
  const isDeveloper = ['developer', 'finance', 'admin'].includes(user?.role) // 最高业务权限角色一致
  const canManageWechatBindings = user?.role === 'developer'

  const sendTestAlert = async () => {
    setAlertTip('')
    try {
      const res = await api('/v2/alerts/test', { method: 'POST', body: JSON.stringify({}) })
      setAlertTip(res.configured ? t('测试消息已发送 ✓') : t('未配置 Webhook，仅返回站内状态'))
    } catch (err) {
      setAlertTip(t(err.message))
    }
  }

  const loadWxBindings = async () => {
    try {
      const res = await api('/v2/wechat/bindings')
      setWxBindings(res)
    } catch {
      setWxBindings(null)
    }
  }

  useEffect(() => {
    loadWxBindings()
  }, [])

  const bindWechat = async () => {
    setWxBusy(true)
    setWxTip('')
    try {
      const res = await api('/v2/wechat/bind-qrcode', { method: 'POST', body: JSON.stringify({}) })
      window.open(res.url, '_blank', 'noopener,noreferrer')
      setWxTip(t('请在打开的微信授权页扫码，授权成功后回到本页刷新查看绑定状态'))
    } catch (err) {
      setWxTip(t(err.message))
    } finally {
      setWxBusy(false)
    }
  }

  const revokeWechat = async (id) => {
    if (!window.confirm(t('确定解绑该微信吗？解绑后将不再收到微信提醒'))) return
    try {
      await api(`/v2/wechat/bindings/${id}/revoke`, { method: 'POST', body: JSON.stringify({}) })
      setWxTip(t('已解绑'))
      loadWxBindings()
    } catch (err) {
      setWxTip(t(err.message))
    }
  }

  // 管理员手动绑定：绕过扫码，直接写企微 userid（域名主体校验未通过/员工不便扫码时使用）
  const bindWechatManual = async () => {
    if (!manualUsername.trim() || !manualUserid.trim()) {
      setManualTip('请填写系统账号和企微 userid')
      return
    }
    setManualBusy(true)
    setManualTip('')
    try {
      const res = await api('/v2/wechat/bindings/manual', {
        method: 'POST',
        body: JSON.stringify({ username: manualUsername.trim(), userid: manualUserid.trim() }),
      })
      setManualUserid('')
      setManualTip(`已绑定 ${manualUsername.trim()} → ${res.identityHint}，推送立即生效`)
      setFeedback({ title: t('绑定成功'), description: `已绑定 ${manualUsername.trim()} → ${res.identityHint}` })
      loadWxBindings()
    } catch (err) {
      setManualTip(err.message)
    } finally {
      setManualBusy(false)
    }
  }

  const lookupWechatManual = async () => {
    if (!manualUsername.trim()) {
      setManualTip('请先填写系统账号')
      return
    }
    setManualBusy(true)
    setManualTip('')
    try {
      const res = await api(`/v2/wechat/bindings/lookup?username=${encodeURIComponent(manualUsername.trim())}`)
      const active = (res.rows || []).filter((r) => r.status === 'active')
      setManualTip(active.length
        ? `${manualUsername.trim()} 已绑定企微：${active[0].identityHint}`
        : `${manualUsername.trim()} 当前未绑定`)
    } catch (err) {
      setManualTip(err.message)
    } finally {
      setManualBusy(false)
    }
  }

  const testWechat = async () => {
    setWxTip('')
    try {
      const res = await api('/v2/wechat/test', { method: 'POST', body: JSON.stringify({}) })
      setWxTip(res.ok ? t('测试微信已发送 ✓') : t('发送失败'))
    } catch (err) {
      setWxTip(t(err.message))
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
          <p className="mt-0.5 text-[13px] text-slate-400">{t('管理门店、安全、提醒与营业数据配置')}</p>
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

      {/* 微信提醒绑定（通知中心个人提醒） */}
      <div className="card p-6">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-budu-500 text-white shadow-md">
            <MessageCircle className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-[15px] font-bold text-slate-800">{t('微信提醒')}</h3>
            <p className="mt-0.5 text-xs text-slate-400">
              {t('扫码授权一次绑定微信，工资条/审批/调拨/发票/邮寄等站内通知将同步推送微信提醒，点击消息直达对应页面；微信仅提醒，不承载业务操作')}
            </p>
          </div>
        </div>

        <div className="mt-4">
          {wxBindings === null ? (
            <p className="text-xs text-slate-300">{t('加载中…')}</p>
          ) : !wxBindings.configured ? (
            <p className="rounded-xl bg-slate-50 px-4 py-3 text-xs font-medium text-slate-400">
              {t('微信提醒通道未开通（需要配置企业微信自建应用或公众号资质）；当前仅站内通知，不影响任何现有功能')}
            </p>
          ) : (
            <>
              {wxBindings.rows.filter((r) => r.status === 'active').length === 0 ? (
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    onClick={bindWechat}
                    disabled={wxBusy}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-budu-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:opacity-50"
                  >
                    <MessageCircle className="h-4 w-4" />
                    {wxBusy ? t('跳转中…') : t('扫码绑定微信')}
                  </button>
                  <span className="text-[11px] text-slate-400">{t('授权一次即可，随时可解绑')}</span>
                </div>
              ) : (
                <div className="space-y-2">
                  {wxBindings.rows.filter((r) => r.status === 'active').map((b) => (
                    <div key={b.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-slate-50/80 px-4 py-2.5">
                      <span className="grid h-8 w-8 place-items-center rounded-full bg-budu-500 text-xs font-bold text-white">微</span>
                      <span className="text-sm font-semibold text-slate-700">
                        {b.identityHint || t('微信')} · {b.channel === 'wecom' ? t('企业微信') : t('公众号')}
                      </span>
                      <span className="text-[11px] text-emerald-600">{t('已绑定')}</span>
                      <span className="ml-auto flex items-center gap-2">
                        <button
                          onClick={testWechat}
                          className="rounded-lg bg-budu-50 px-3 py-1.5 text-xs font-semibold text-budu-600 transition hover:bg-budu-100"
                        >
                          {t('发送测试')}
                        </button>
                        <button
                          onClick={() => revokeWechat(b.id)}
                          className="rounded-lg bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-500 transition hover:bg-rose-100"
                        >
                          {t('解绑')}
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          {wxTip && <p className="mt-3 text-xs font-medium text-slate-500">{wxTip}</p>}

          {canManageWechatBindings && (
            <div className="mt-4 rounded-xl border border-dashed border-budu-200 bg-budu-50/40 px-4 py-3">
              <p className="text-xs font-bold text-slate-600">开发者手动绑定企微 userid（跳过扫码）</p>
              <p className="mt-1 text-[11px] text-slate-400">
                用于扫码绑定被域名校验拦截或员工不便扫码时：填系统账号 + 员工企业微信 userid（企微通讯录 → 成员资料可见），保存后推送立即生效
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  value={manualUsername}
                  onChange={(e) => setManualUsername(e.target.value)}
                  placeholder="系统账号"
                  className="input w-40"
                />
                <input
                  value={manualUserid}
                  onChange={(e) => setManualUserid(e.target.value)}
                  placeholder="企微 userid"
                  className="input w-40"
                />
                <button
                  onClick={bindWechatManual}
                  disabled={manualBusy}
                  className="rounded-lg bg-budu-500 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:opacity-90 disabled:opacity-50"
                >
                  {manualBusy ? '处理中…' : '保存绑定'}
                </button>
                <button
                  onClick={lookupWechatManual}
                  disabled={manualBusy}
                  className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-500 transition hover:bg-slate-50 disabled:opacity-50"
                >
                  查询
                </button>
              </div>
              {manualTip && <p className="mt-2 text-[11px] font-medium text-slate-500">{manualTip}</p>}
            </div>
          )}
        </div>
      </div>

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

      {user?.role === 'developer' && <DeletedRecordsCenter user={user} />}

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
          {t('PostgreSQL / 云端共享数据 / POS 实时汇总')}
        </div>
      </div>

      {/* 卡皮巴拉提交成功动画 */}
      {feedback && (
        <BuduSuccessFeedback
          open={!!feedback}
          title={feedback.title}
          description={feedback.description}
          onClose={() => setFeedback(null)}
        />
      )}
    </div>
  )
}
