import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Bell,
  Bug,
  Database,
  Info,
  Lock,
  MessageCircle,
  RefreshCw,
  Server,
  ShieldCheck,
  Store,
} from 'lucide-react'
import { t } from '../utils/text'
import { APP_VERSION } from '../version'
import { api } from '../utils/api'
import BuduSuccessFeedback from './feedback/BuduSuccessFeedback'
import { DeletedRecordsCenter } from './DeveloperSafeDelete'
import {
  SettingsConfirmDialog,
  SettingsDetailPage,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
} from './settings/SettingsPrimitives'

const sourceLabels = { manual: '人工录入', pos: 'BUDU POS', hybrid: '混合模式' }

function todayText() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function shortDate(value) {
  if (!value) return '未设置'
  const [year, month, day] = String(value).slice(0, 10).split('-')
  return `${year}年${Number(month)}月${Number(day)}日`
}

function SettingBlock({ title, description, children, tone = 'plain' }) {
  return (
    <div className={`rounded-[18px] border p-4 sm:p-5 ${tone === 'soft' ? 'border-budu-100 bg-budu-50/35' : 'border-slate-200/75 bg-white'}`}>
      <h3 className="text-sm font-bold text-slate-800">{title}</h3>
      {description && <p className="mt-1 text-xs leading-5 text-slate-400">{description}</p>}
      <div className="mt-4">{children}</div>
    </div>
  )
}

export default function SettingsPage({ user, onBack }) {
  const [activePanel, setActivePanel] = useState('')
  const mainScrollRef = useRef(0)
  const [alertStatus, setAlertStatus] = useState(null)
  const [alertTip, setAlertTip] = useState('')
  const [alertBusy, setAlertBusy] = useState(false)
  const [sourceStores, setSourceStores] = useState([])
  const [sourceStore, setSourceStore] = useState('')
  const [sourceType, setSourceType] = useState('manual')
  const [sourceDate, setSourceDate] = useState(todayText)
  const [sourceSaving, setSourceSaving] = useState(false)
  const [sourceTip, setSourceTip] = useState('')
  const [secOld, setSecOld] = useState('')
  const [secNew, setSecNew] = useState('')
  const [secConfirm, setSecConfirm] = useState('')
  const [secError, setSecError] = useState('')
  const [secTip, setSecTip] = useState('')
  const [secSaving, setSecSaving] = useState(false)
  const [wxBindings, setWxBindings] = useState(null)
  const [wxTip, setWxTip] = useState('')
  const [feedback, setFeedback] = useState(null)
  const [wxBusy, setWxBusy] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState(null)
  const [manualUsername, setManualUsername] = useState('')
  const [manualUserid, setManualUserid] = useState('')
  const [manualBusy, setManualBusy] = useState(false)
  const [manualTip, setManualTip] = useState('')
  const [systemHealth, setSystemHealth] = useState(null)
  const isElevated = ['developer', 'finance', 'admin'].includes(user?.role)
  const isDeveloper = user?.role === 'developer'

  const activeBindings = useMemo(
    () => (wxBindings?.rows || []).filter((row) => row.status === 'active'),
    [wxBindings],
  )
  const alertDisplay = alertStatus?.healthy === false
    ? { label: '异常', tone: 'danger' }
    : alertStatus?.configured
      ? { label: '已连接', tone: 'success' }
      : { label: '未配置', tone: 'warning' }

  const loadWxBindings = async () => {
    try {
      const result = await api('/v2/wechat/bindings')
      setWxBindings(result)
    } catch {
      setWxBindings(null)
    }
  }

  const loadSourceStores = async () => {
    if (!isElevated) return
    try {
      const result = await api('/v2/store-sales-sources')
      const rows = result.rows || []
      setSourceStores(rows)
      setSourceStore((current) => current || rows[0]?.storeKey || '')
    } catch (error) {
      setSourceTip(t(error.message))
    }
  }

  const loadSettingsSummary = async () => {
    const operations = [loadWxBindings(), api('/health').then(setSystemHealth).catch(() => setSystemHealth(null))]
    if (isElevated) {
      operations.push(api('/v2/alerts/status').then(setAlertStatus).catch(() => setAlertStatus(null)))
      operations.push(loadSourceStores())
    }
    await Promise.allSettled(operations)
  }

  useEffect(() => {
    void loadSettingsSummary()
  }, [user?.id, user?.role]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const row = sourceStores.find((store) => store.storeKey === sourceStore)
    if (!row) return
    setSourceType(row.salesDataSource || 'manual')
    setSourceDate(row.salesDataSourceEffectiveDate || todayText())
  }, [sourceStore, sourceStores])

  const openPanel = (panel) => {
    mainScrollRef.current = window.scrollY
    setActivePanel(panel)
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'auto' }))
  }

  const closePanel = () => {
    setActivePanel('')
    window.requestAnimationFrame(() => window.scrollTo({ top: mainScrollRef.current, behavior: 'auto' }))
  }

  const sendTestAlert = async () => {
    setAlertBusy(true)
    setAlertTip('')
    try {
      const result = await api('/v2/alerts/test', { method: 'POST', body: JSON.stringify({}) })
      setAlertStatus({ configured: result.configured, healthy: result.ok })
      setAlertTip(result.configured ? t('测试消息已发送 ✓') : t('企业微信告警尚未配置'))
    } catch (error) {
      setAlertTip(t(error.message))
    } finally {
      setAlertBusy(false)
    }
  }

  const bindWechat = async () => {
    setWxBusy(true)
    setWxTip('')
    try {
      const result = await api('/v2/wechat/bind-qrcode', { method: 'POST', body: JSON.stringify({}) })
      window.open(result.url, '_blank', 'noopener,noreferrer')
      setWxTip(t('请在打开的授权页扫码，完成后刷新绑定状态'))
    } catch (error) {
      setWxTip(t(error.message))
    } finally {
      setWxBusy(false)
    }
  }

  const revokeWechat = async () => {
    if (!revokeTarget) return
    setWxBusy(true)
    setWxTip('')
    try {
      await api(`/v2/wechat/bindings/${revokeTarget.id}/revoke`, { method: 'POST', body: JSON.stringify({}) })
      setRevokeTarget(null)
      setWxTip(t('已解绑'))
      await loadWxBindings()
    } catch (error) {
      setWxTip(t(error.message))
    } finally {
      setWxBusy(false)
    }
  }

  const testWechat = async () => {
    setWxBusy(true)
    setWxTip('')
    try {
      const result = await api('/v2/wechat/test', { method: 'POST', body: JSON.stringify({}) })
      setWxTip(result.ok ? t('测试微信已发送 ✓') : t('发送失败'))
    } catch (error) {
      setWxTip(t(error.message))
    } finally {
      setWxBusy(false)
    }
  }

  const bindWechatManual = async () => {
    if (!manualUsername.trim() || !manualUserid.trim()) {
      setManualTip('请填写系统账号和企微 userid')
      return
    }
    setManualBusy(true)
    setManualTip('')
    try {
      const result = await api('/v2/wechat/bindings/manual', {
        method: 'POST',
        body: JSON.stringify({ username: manualUsername.trim(), userid: manualUserid.trim() }),
      })
      setManualUserid('')
      setManualTip(`已绑定 ${manualUsername.trim()} → ${result.identityHint}`)
      setFeedback({ title: t('绑定成功'), description: `已绑定 ${manualUsername.trim()} → ${result.identityHint}` })
      await loadWxBindings()
    } catch (error) {
      setManualTip(error.message)
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
      const result = await api(`/v2/wechat/bindings/lookup?username=${encodeURIComponent(manualUsername.trim())}`)
      const active = (result.rows || []).filter((row) => row.status === 'active')
      setManualTip(active.length ? `${manualUsername.trim()} 已绑定企微：${active[0].identityHint}` : `${manualUsername.trim()} 当前未绑定`)
    } catch (error) {
      setManualTip(error.message)
    } finally {
      setManualBusy(false)
    }
  }

  const saveSecondPassword = async () => {
    if (!secOld.trim()) return setSecError('请输入当前登录密码')
    if (secNew.length < 6) return setSecError('二级密码至少 6 位')
    if (secNew !== secConfirm) return setSecError('两次输入的二级密码不一致')
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
    } catch (error) {
      setSecError(error.message)
    } finally {
      setSecSaving(false)
    }
  }

  const saveSalesSource = async () => {
    if (!sourceStore) return setSourceTip(t('请选择门店'))
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceDate)) return setSourceTip(t('请选择生效日期'))
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
      await loadSourceStores()
      setSourceTip(t('门店销售数据来源已保存 ✓'))
    } catch (error) {
      setSourceTip(t(error.message))
    } finally {
      setSourceSaving(false)
    }
  }

  const posSummary = useMemo(() => {
    if (!sourceStores.length) return '加载中'
    const posCount = sourceStores.filter((row) => ['pos', 'hybrid'].includes(row.salesDataSource)).length
    return `${posCount} 家 POS · ${sourceStores.length - posCount} 家人工`
  }, [sourceStores])

  if (activePanel === 'alert') {
    return (
      <SettingsDetailPage title="企业微信告警" subtitle="库存与系统异常的群机器人提醒" onBack={closePanel}>
        <SettingBlock title="连接状态" description="仅显示通道是否已安全配置，不展示 webhook 或密钥。" tone="soft">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-50 text-emerald-600"><Bell className="h-5 w-5" /></span>
              <div><p className="text-sm font-semibold text-slate-800">企业微信群机器人</p><p className="text-xs text-slate-400">异常通知推送通道</p></div>
            </div>
            <SettingsStatus tone={alertDisplay.tone}>{alertDisplay.label}</SettingsStatus>
          </div>
        </SettingBlock>
        <SettingBlock title="通道测试" description="仅在需要确认配置时发送一条测试消息。">
          <button type="button" disabled={alertBusy} onClick={sendTestAlert} className="min-h-11 rounded-xl bg-budu-600 px-4 text-sm font-bold text-white disabled:opacity-40">{alertBusy ? '发送中…' : '发送测试消息'}</button>
          {alertTip && <p className="mt-3 text-xs font-medium text-slate-500">{alertTip}</p>}
        </SettingBlock>
      </SettingsDetailPage>
    )
  }

  if (activePanel === 'wechat') {
    return (
      <SettingsDetailPage title="微信提醒" subtitle="个人企业微信提醒与绑定" onBack={closePanel} actions={<button type="button" aria-label="刷新绑定状态" disabled={wxBusy} onClick={() => void loadWxBindings()} className="grid h-10 w-10 place-items-center rounded-full text-slate-500 hover:bg-slate-100"><RefreshCw className="h-4 w-4" /></button>}>
        <SettingBlock title="当前状态" description="工单、审批、调拨等提醒可同步到个人企业微信。" tone="soft">
          {wxBindings === null ? (
            <p className="text-sm text-slate-400">加载中…</p>
          ) : !wxBindings.configured ? (
            <div className="flex items-center justify-between gap-3"><p className="text-sm text-slate-600">当前仅保留站内通知</p><SettingsStatus tone="warning">未配置</SettingsStatus></div>
          ) : activeBindings.length === 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-slate-600">尚未绑定个人企业微信</p><SettingsStatus tone="neutral">未绑定</SettingsStatus></div>
          ) : (
            <div className="space-y-3">
              {activeBindings.map((binding) => (
                <div key={binding.id} className="flex items-center gap-3 rounded-2xl bg-white px-3 py-3 ring-1 ring-slate-200/70">
                  <span className="grid h-9 w-9 place-items-center rounded-full bg-budu-50 text-sm font-bold text-budu-600">微</span>
                  <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-slate-800">{binding.identityHint || '企业微信账号'}</p><p className="text-xs text-slate-400">{binding.channel === 'wecom' ? '企业微信' : '公众号'}</p></div>
                  <SettingsStatus tone="success">已绑定</SettingsStatus>
                  <button type="button" disabled={wxBusy} onClick={() => setRevokeTarget(binding)} className="min-h-11 rounded-xl px-2 text-xs font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-40">解除绑定</button>
                </div>
              ))}
            </div>
          )}
        </SettingBlock>
        {wxBindings?.configured && activeBindings.length === 0 && (
          <button type="button" disabled={wxBusy} onClick={bindWechat} className="min-h-12 w-full rounded-xl bg-budu-600 px-4 text-sm font-bold text-white disabled:opacity-40">{wxBusy ? '跳转中…' : '扫码绑定微信'}</button>
        )}
        {activeBindings.length > 0 && (
          <SettingBlock title="绑定操作">
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={wxBusy} onClick={testWechat} className="min-h-11 rounded-xl bg-budu-600 px-4 text-sm font-bold text-white disabled:opacity-40">发送测试</button>
            </div>
          </SettingBlock>
        )}
        {wxTip && <p className="rounded-xl bg-slate-100 px-4 py-3 text-xs font-medium text-slate-600">{wxTip}</p>}
        <SettingsConfirmDialog open={Boolean(revokeTarget)} title="解除微信绑定" description="解绑后将不再收到个人企业微信提醒，站内通知不受影响。" busy={wxBusy} onCancel={() => setRevokeTarget(null)} onConfirm={revokeWechat} />
      </SettingsDetailPage>
    )
  }

  if (activePanel === 'pos') {
    const selected = sourceStores.find((row) => row.storeKey === sourceStore)
    return (
      <SettingsDetailPage title="门店与 POS" subtitle="管理门店销售数据来源" onBack={closePanel}>
        <SettingBlock title="POS 点单 / 门店配置" description="配置只从生效日期起作用，历史日报的数据来源保持不变。" tone="soft">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <label className="block text-xs font-semibold text-slate-500">门店<select value={sourceStore} onChange={(event) => setSourceStore(event.target.value)} className="input mt-1.5 w-full">{sourceStores.map((store) => <option key={store.storeKey} value={store.storeKey}>{store.storeName}</option>)}</select></label>
            <label className="block text-xs font-semibold text-slate-500">销售数据来源<select aria-label="销售数据来源" value={sourceType} onChange={(event) => setSourceType(event.target.value)} className="input mt-1.5 w-full"><option value="manual">人工录入</option><option value="pos">BUDU POS</option><option value="hybrid">混合模式</option></select></label>
            <label className="block text-xs font-semibold text-slate-500">生效日期<input type="date" value={sourceDate} onChange={(event) => setSourceDate(event.target.value)} className="input mt-1.5 w-full" /></label>
          </div>
          <button type="button" disabled={sourceSaving || !selected} onClick={saveSalesSource} className="mt-4 min-h-11 rounded-xl bg-budu-600 px-5 text-sm font-bold text-white disabled:opacity-40">{sourceSaving ? '保存中…' : '保存配置'}</button>
          {sourceTip && <p className="mt-3 text-xs font-medium text-slate-500">{sourceTip}</p>}
        </SettingBlock>
        <SettingBlock title="已配置门店" description="状态来自当前门店销售数据来源 authority。">
          <div className="divide-y divide-slate-100">
            {sourceStores.map((store) => (
              <div key={store.storeKey} className="flex min-h-14 items-center gap-3 py-3">
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-slate-800">{store.storeName}</p><p className="mt-0.5 text-xs text-slate-400">{store.salesDataSourceEffectiveDate ? `${shortDate(store.salesDataSourceEffectiveDate)} 起` : '未设置生效日期'}</p></div>
                <SettingsStatus tone={store.salesDataSource === 'pos' ? 'success' : store.salesDataSource === 'hybrid' ? 'brand' : 'neutral'}>{sourceLabels[store.salesDataSource] || '人工录入'}</SettingsStatus>
              </div>
            ))}
          </div>
        </SettingBlock>
      </SettingsDetailPage>
    )
  }

  if (activePanel === 'security') {
    return (
      <SettingsDetailPage title="账号与安全" subtitle="密码、二级密码与高风险操作保护" onBack={closePanel}>
        <SettingBlock title="二级密码" description="用于删除雇员等高风险操作；必须使用当前登录密码验证后重新设置。" tone="soft">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-xs font-semibold text-slate-500">当前登录密码<input aria-label="当前登录密码" type="password" value={secOld} onChange={(event) => setSecOld(event.target.value)} className="input mt-1.5 w-full" /></label>
            <label className="block text-xs font-semibold text-slate-500">新二级密码（至少 6 位）<input aria-label="新二级密码（至少 6 位）" type="password" value={secNew} onChange={(event) => setSecNew(event.target.value)} className="input mt-1.5 w-full" /></label>
            <label className="block text-xs font-semibold text-slate-500">确认新二级密码<input aria-label="确认新二级密码" type="password" value={secConfirm} onChange={(event) => setSecConfirm(event.target.value)} className="input mt-1.5 w-full" /></label>
          </div>
          <button type="button" disabled={secSaving} onClick={saveSecondPassword} className="mt-4 min-h-11 rounded-xl bg-budu-600 px-5 text-sm font-bold text-white disabled:opacity-40">{secSaving ? '保存中…' : '保存二级密码'}</button>
          {secError && <p className="mt-3 text-xs font-medium text-rose-600">{secError}</p>}
          {secTip && <p className="mt-3 text-xs font-medium text-emerald-600">{secTip}</p>}
        </SettingBlock>
        <div className="flex items-start gap-3 rounded-[18px] border border-slate-200/70 bg-slate-50 p-4 text-xs leading-5 text-slate-500"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-budu-600" /><p>密码只通过现有安全接口提交；页面不会读取或展示密码哈希、令牌或内部凭据。</p></div>
      </SettingsDetailPage>
    )
  }

  if (activePanel === 'developer') {
    return (
      <SettingsDetailPage title="开发者工具" subtitle="审计、已删除记录与系统诊断" onBack={closePanel}>
        <SettingBlock title="企微绑定调试 / 高级绑定" description="仅用于扫码受限时，由开发者按系统账号绑定企业微信 userid。">
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <input aria-label="开发者绑定系统账号" value={manualUsername} onChange={(event) => setManualUsername(event.target.value)} placeholder="系统账号" className="input w-full" />
            <input aria-label="开发者绑定企微 userid" value={manualUserid} onChange={(event) => setManualUserid(event.target.value)} placeholder="企微 userid" className="input w-full" />
            <button type="button" disabled={manualBusy} onClick={bindWechatManual} className="min-h-11 rounded-xl bg-budu-600 px-4 text-sm font-bold text-white disabled:opacity-40">{manualBusy ? '处理中…' : '保存绑定'}</button>
          </div>
          <button type="button" disabled={manualBusy} onClick={lookupWechatManual} className="mt-2 min-h-10 rounded-xl px-2 text-sm font-semibold text-budu-600 disabled:opacity-40">查询当前绑定</button>
          {manualTip && <p className="mt-2 text-xs font-medium text-slate-500">{manualTip}</p>}
        </SettingBlock>
        <SettingBlock title="数据来源说明" description="业务数据以 PostgreSQL 为权威；浏览器缓存只用于界面体验，不能覆盖业务事实。">
          <div className="flex items-center gap-3 text-sm text-slate-600"><Database className="h-5 w-5 text-slate-400" /><span>PostgreSQL · 云端共享数据 · POS 实时汇总</span></div>
        </SettingBlock>
        <DeletedRecordsCenter user={user} />
      </SettingsDetailPage>
    )
  }

  if (activePanel === 'system') {
    return (
      <SettingsDetailPage title="系统信息" subtitle="运行状态与版本信息" onBack={closePanel}>
        <SettingBlock title={`budu Operating System ${APP_VERSION}`} description="当前运行版本" tone="soft">
          <div className="divide-y divide-slate-100">
            <div className="flex items-center justify-between gap-3 py-3 text-sm"><span className="text-slate-500">系统状态</span><SettingsStatus tone={systemHealth?.ok && systemHealth?.dbOk ? 'success' : 'warning'}>{systemHealth?.ok && systemHealth?.dbOk ? '运行中' : '检查中'}</SettingsStatus></div>
            <div className="flex items-center justify-between gap-3 py-3 text-sm"><span className="text-slate-500">数据来源</span><span className="text-right font-semibold text-slate-700">PostgreSQL / 云端共享</span></div>
            {isDeveloper && systemHealth?.gitSha && <div className="flex items-center justify-between gap-3 py-3 text-sm"><span className="text-slate-500">运行版本</span><code className="max-w-[65%] truncate text-xs text-slate-600">{systemHealth.gitSha}</code></div>}
          </div>
        </SettingBlock>
        <div className="flex items-start gap-3 rounded-[18px] bg-slate-100 px-4 py-4 text-xs leading-5 text-slate-500"><Info className="mt-0.5 h-4 w-4 shrink-0" /><p>系统信息仅用于确认当前服务状态。敏感凭据与密码不会在此页面展示。</p></div>
      </SettingsDetailPage>
    )
  }

  const wxStatus = wxBindings === null
    ? <SettingsStatus>加载中</SettingsStatus>
    : !wxBindings.configured
      ? <SettingsStatus tone="warning">未配置</SettingsStatus>
      : activeBindings.length > 0
        ? <SettingsStatus tone="success">已绑定</SettingsStatus>
        : <SettingsStatus>未绑定</SettingsStatus>

  return (
    <div className="mx-auto min-w-0 w-full max-w-5xl">
      <h2 className="sr-only">{t('系统设置')}</h2>
      <div className="mb-5 flex items-center justify-between gap-4 px-1">
        <p className="text-[13px] text-slate-400">{t('管理门店、提醒与营业配置')}</p>
        <button type="button" onClick={onBack} className="hidden min-h-10 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-slate-500 transition hover:bg-white hover:text-budu-600 lg:inline-flex"><ArrowLeft className="h-4 w-4" />返回首页</button>
      </div>

      <div className="grid min-w-0 grid-cols-1 items-start gap-6 lg:grid-cols-2">
        <div className="min-w-0 space-y-6">
          <SettingsSection title="提醒与通知">
            {isElevated && <SettingsRow testId="settings-row-alert" icon={Bell} iconTone="green" title="企业微信告警" subtitle="异常通知将推送至企业微信群" status={<SettingsStatus tone={alertDisplay.tone}>{alertDisplay.label}</SettingsStatus>} onClick={() => openPanel('alert')} />}
            <SettingsRow testId="settings-row-wechat" icon={MessageCircle} iconTone="brand" title="微信提醒" subtitle="工单、审批、调拨等个人提醒" status={wxStatus} onClick={() => openPanel('wechat')} last />
          </SettingsSection>

          {isElevated && (
            <SettingsSection title="门店与 POS">
              <SettingsRow testId="settings-row-pos" icon={Store} iconTone="blue" title="POS 点单 / 门店配置" subtitle="销售数据来源与生效日期" status={<SettingsStatus tone="brand">{posSummary}</SettingsStatus>} onClick={() => openPanel('pos')} last />
            </SettingsSection>
          )}
        </div>

        <div className="min-w-0 space-y-6">
          {isElevated && (
            <SettingsSection title="账号与安全">
              <SettingsRow testId="settings-row-security" icon={Lock} iconTone="amber" title="安全设置" subtitle="密码、二级密码与账号安全" status={<SettingsStatus>可管理</SettingsStatus>} onClick={() => openPanel('security')} last />
            </SettingsSection>
          )}

          <SettingsSection title="开发者与系统">
            {isDeveloper && <SettingsRow testId="settings-row-developer" icon={Bug} iconTone="violet" title="开发者工具" subtitle="审计、已删除记录与系统诊断" status={<SettingsStatus tone="brand">开发者专用</SettingsStatus>} onClick={() => openPanel('developer')} />}
            <SettingsRow testId="settings-row-system" icon={Server} iconTone="slate" title="系统信息" subtitle={`budu Operating System ${APP_VERSION}`} status={<SettingsStatus tone={systemHealth?.ok && systemHealth?.dbOk ? 'success' : 'neutral'}>{systemHealth?.ok && systemHealth?.dbOk ? '运行中' : '检查中'}</SettingsStatus>} onClick={() => openPanel('system')} last />
          </SettingsSection>
        </div>
      </div>

      <p className="mt-6 px-1 text-center text-[11px] leading-5 text-slate-400">设置项会根据当前账号权限显示；敏感凭据不会在页面中展示。</p>

      {feedback && <BuduSuccessFeedback open title={feedback.title} description={feedback.description} onClose={() => setFeedback(null)} />}
    </div>
  )
}
