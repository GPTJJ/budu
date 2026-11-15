import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, ShieldCheck, Save } from 'lucide-react'
import { api } from '../utils/api'
import { MP_CONSOLE_MODULES, MP_CONSOLE_PRESETS, ROLE_LABELS } from '../../shared/accountPermissions'

/**
 * 设置 → 权限分配（仅开发者）
 *
 * 为其他账号分配小程序管理台的模块权限：
 *  - 可以按角色模板一键分配（全部/运营/客服/只读/无权限），再逐项微调；
 *  - 保存后立即生效：服务端每次请求都从库里取账号权限，对方下一次操作即按新权限校验；
 *  - 对方的已打开页面最多 60 秒内同步导航（页面会轮询 /access），未授权模块既不显示也无法访问。
 *  - 开发者不能修改自己的权限（需另一位开发者操作），且开发者账号的「设置」始终保留。
 */

const MODULE_LABELS = Object.fromEntries(MP_CONSOLE_MODULES.map((item) => [item.key, item.label]))

function fmtTime(value) {
  if (!value) return '从未分配'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function moduleCount(modules) {
  return MP_CONSOLE_MODULES.filter((item) => modules?.[item.key]).length
}

export default function AccessBoard() {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState(null)
  const [draft, setDraft] = useState({})
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api('/v2/online-catalog/access/grants')
      setUsers(res.users || [])
    } catch (err) {
      setError(err.message || '加载授权清单失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const openEdit = (user) => {
    if (user.self) return
    setEditing(user)
    setDraft(Object.fromEntries(MP_CONSOLE_MODULES.map((item) => [item.key, user.modules?.[item.key] === true])))
    setNotice('')
  }

  const applyPreset = (preset) => {
    const next = Object.fromEntries(MP_CONSOLE_MODULES.map((item) => [item.key, preset.modules.includes(item.key)]))
    if (editing?.role === 'developer') next.settings = true
    setDraft(next)
  }

  const save = async () => {
    if (!editing) return
    setBusy(true)
    setError('')
    try {
      const res = await api(`/v2/online-catalog/access/grants/${editing.id}`, {
        method: 'PUT',
        body: JSON.stringify({ modules: draft }),
      })
      setUsers((list) => list.map((user) => (user.id === editing.id ? { ...user, ...res.user, self: user.self } : user)))
      setNotice(`已保存 ${editing.displayName || editing.username} 的管理台权限（${moduleCount(draft)}/8 个模块）。立即生效：对方下一次操作即按新权限校验，已打开的页面最多 60 秒内同步。`)
      setEditing(null)
    } catch (err) {
      setError(err.message || '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const sorted = useMemo(() => {
    const rank = { developer: 0, admin: 1, finance: 2, manager: 3, staff: 4, cashier: 5 }
    return [...users].sort((a, b) => (rank[a.role] ?? 9) - (rank[b.role] ?? 9) || String(a.username).localeCompare(String(b.username)))
  }, [users])

  return (
    <div>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[11px] leading-relaxed text-slate-500">
          仅开发者可分配。未勾选的模块在对方界面与路由中都不出现，接口也会返回 403；保存即生效。
        </p>
        <button type="button" onClick={load} className="inline-flex h-9 items-center justify-center gap-1 rounded-xl border border-slate-200 px-3 text-sm text-slate-600 hover:bg-slate-50 sm:h-8">
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

      {error ? <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700">{error}</div> : null}
      {notice ? <div className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-700">{notice}</div> : null}

      <div className="grid gap-3 lg:grid-cols-[1.15fr_1fr]">
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[560px]">
              <thead>
                <tr className="border-b border-slate-100 bg-[#FEFDFC] text-left text-[11px] text-slate-500">
                  <th className="px-4 py-2.5 font-medium">账号</th>
                  <th className="w-[90px] px-3 py-2.5 font-medium">角色</th>
                  <th className="w-[110px] px-3 py-2.5 font-medium">授权</th>
                  <th className="w-[90px] px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={4}><div className="px-4 py-14 text-center text-xs text-slate-400">加载中…</div></td></tr>
                ) : !sorted.length ? (
                  <tr><td colSpan={4}><div className="px-4 py-14 text-center text-xs text-slate-400">没有可选账号</div></td></tr>
                ) : sorted.map((user) => (
                  <tr key={user.id} className={`border-b border-slate-100 last:border-0 ${editing?.id === user.id ? 'bg-budu-50/40' : ''}`}>
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium text-slate-700">{user.displayName || user.username}{user.self ? <span className="ml-1 rounded bg-slate-100 px-1 py-0.5 text-[10px] text-slate-400">本人</span> : null}</div>
                      <div className="mt-0.5 font-mono text-[11px] text-slate-400">{user.username}</div>
                    </td>
                    <td className="px-3 py-3 text-xs text-slate-500">{ROLE_LABELS[user.role] || user.role}</td>
                    <td className="px-3 py-3 text-xs text-slate-600">
                      {moduleCount(user.modules)}/8
                      {user.explicit ? <span className="ml-1 rounded bg-budu-50 px-1 py-0.5 text-[10px] text-budu-600">已分配</span> : <span className="ml-1 rounded bg-slate-100 px-1 py-0.5 text-[10px] text-slate-400">角色默认</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button type="button" disabled={user.self} onClick={() => openEdit(user)} className="h-8 rounded-lg border border-slate-200 px-2.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-30">配置</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="divide-y divide-slate-100 md:hidden">
            {loading ? (
              <div className="px-4 py-14 text-center text-xs text-slate-400">加载中…</div>
            ) : !sorted.length ? (
              <div className="px-4 py-14 text-center text-xs text-slate-400">没有可选账号</div>
            ) : sorted.map((user) => (
              <button key={user.id} type="button" disabled={user.self} onClick={() => openEdit(user)} className={`block w-full px-4 py-3 text-left active:bg-slate-50 disabled:opacity-50 ${editing?.id === user.id ? 'bg-budu-50/40' : ''}`}>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700">{user.displayName || user.username}{user.self ? '（本人）' : ''}</span>
                  <span className="shrink-0 text-[11px] text-slate-400">{moduleCount(user.modules)}/8</span>
                </div>
                <div className="mt-0.5 text-[11px] text-slate-400">{ROLE_LABELS[user.role] || user.role} · {user.explicit ? '已分配' : '角色默认'}</div>
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2.5 text-[11px] text-slate-400">
            <span>共 {sorted.length} 个账号</span>
            <span>开发者本人不可自改</span>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          {!editing ? (
            <div className="py-10 text-center">
              <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-slate-100 text-slate-400"><ShieldCheck size={20} /></div>
              <div className="text-sm text-slate-600">选择左侧账号开始配置</div>
              <p className="mx-auto mt-1 max-w-xs text-[11px] leading-relaxed text-slate-400">可以先用角色模板一键分配，再按模块微调；保存后立即生效。</p>
            </div>
          ) : (
            <>
              <div className="mb-3">
                <div className="text-sm font-semibold text-slate-800">{editing.displayName || editing.username}</div>
                <div className="mt-0.5 text-[11px] text-slate-400">{ROLE_LABELS[editing.role] || editing.role} · 上次分配 {fmtTime(editing.updatedAt)}{editing.updatedBy ? ` · ${editing.updatedBy}` : ''}</div>
              </div>

              <div className="mb-3 flex flex-wrap gap-1.5">
                {MP_CONSOLE_PRESETS.map((preset) => (
                  <button key={preset.key} type="button" onClick={() => applyPreset(preset)} className="h-8 rounded-full border border-slate-200 bg-white px-3 text-xs text-slate-600 hover:bg-slate-50">{preset.label}</button>
                ))}
              </div>

              <div className="space-y-1.5">
                {MP_CONSOLE_MODULES.map((item) => (
                  <label key={item.key} className="flex cursor-pointer items-start gap-2 rounded-xl border border-slate-100 px-3 py-2 hover:bg-slate-50">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 accent-[#C2607F]"
                      checked={draft[item.key] === true}
                      disabled={editing.role === 'developer' && item.key === 'settings'}
                      onChange={(e) => setDraft((current) => ({ ...current, [item.key]: e.target.checked }))}
                    />
                    <span className="min-w-0">
                      <span className="block text-xs font-medium text-slate-700">{item.label}{editing.role === 'developer' && item.key === 'settings' ? '（开发者固定保留）' : ''}</span>
                      <span className="block text-[11px] text-slate-400">{item.note}</span>
                    </span>
                  </label>
                ))}
              </div>

              <div className="mt-4 flex items-center justify-between gap-2">
                <span className="text-[11px] text-slate-400">已选 {moduleCount(draft)}/8 个模块</span>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setEditing(null)} className="h-9 rounded-xl border border-slate-200 px-4 text-sm text-slate-600">取消</button>
                  <button type="button" onClick={save} disabled={busy} className="inline-flex h-9 items-center gap-1 rounded-xl bg-budu-500 px-4 text-sm font-semibold text-white disabled:opacity-50"><Save size={14} />{busy ? '保存中…' : '保存并生效'}</button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-2 text-[11px] leading-relaxed text-amber-800">
        默认隐藏逻辑：没有勾选的模块既不出现在导航里，也不能通过直达地址访问（接口返回 403）。账号被调整角色后，管理台授权会重置为新角色的默认值，需要重新分配。
      </div>
    </div>
  )
}
