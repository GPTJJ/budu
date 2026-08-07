/** 库存申请实时通知（开发者账号轮询，未读状态存 localStorage） */
import { loadUserData, getInventoryRequests } from './userData'
import { api } from './api'

const SEEN_KEY = 'budu-inventory-seen-at'
const MUTED_KEY = 'budu-alert-muted'
const POLL_MS = 8000

let state = { unread: 0, items: [], stock: [] }
let listeners = []
let timer = null
let currentUserKey = null
let currentCanNotify = false
let initialized = false
let lastNotifiedId = null
let audioCtx = null

function muted() {
  try {
    return localStorage.getItem(MUTED_KEY) === '1'
  } catch {
    return false
  }
}

/** 首次用户点击后解锁音频（浏览器自动播放策略） */
export function unlockAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    audioCtx = audioCtx || new Ctx()
    if (audioCtx.state === 'suspended') audioCtx.resume()
  } catch {
    /* 忽略 */
  }
}

export function isAlertMuted() {
  return muted()
}

export function setAlertMuted(value) {
  try {
    localStorage.setItem(MUTED_KEY, value ? '1' : '0')
  } catch {
    /* 忽略 */
  }
}

/** 短提示音（三连音） */
function playChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    const ctx = audioCtx || new Ctx()
    audioCtx = ctx
    if (ctx.state === 'suspended') ctx.resume()
    const now = ctx.currentTime
    ;[880, 1174.66, 1567.98].forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      const t = now + i * 0.12
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(0.22, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(t)
      osc.stop(t + 0.55)
    })
  } catch {
    /* 忽略音频异常 */
  }
}

function notify() {
  for (const fn of listeners) fn(state)
}

function compute() {
  let seenAt = ''
  try {
    seenAt = localStorage.getItem(SEEN_KEY) || ''
  } catch {
    /* SSR / 隐私模式忽略 */
  }
  const items = currentCanNotify
    ? getInventoryRequests()
        .filter((r) => (r.status === 'pending' || r.status === 'in_transit') && (!seenAt || r.createdAt > seenAt))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    : []
  state = { unread: items.length, items }
  notify()

  // 新申请到达时播放提示音（首次加载不响，避免旧申请轰炸）
  const topId = items[0] ? items[0].id : null
  if (initialized && topId && topId !== lastNotifiedId && state.unread > 0 && !muted()) {
    playChime()
  }
  lastNotifiedId = topId
  initialized = true
}

async function refresh() {
  try {
    await loadUserData()
  } catch {
    /* 网络异常时保留当前状态 */
  }
  compute()
  if (currentCanNotify) {
    try {
      const res = await api('/v2/stock/alerts')
      state = { ...state, stock: Array.isArray(res.rows) ? res.rows : [] }
      notify()
    } catch {
      /* v2 不可用时忽略 */
    }
  }
}

/** 启动全局数据同步（所有登录账号，8 秒一次）；通知计算仅开发者/店长 */
export function ensurePolling(user) {
  const key = user ? user.username : null
  if (currentUserKey === key) return
  currentUserKey = key
  currentCanNotify = Boolean(user && ['developer', 'manager'].includes(user.role))
  initialized = false
  lastNotifiedId = null
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (!key) return
  compute()
  timer = setInterval(refresh, POLL_MS)
}

export function markSeen() {
  const latest = state.items[0] && state.items[0].createdAt
  if (latest) {
    try {
      localStorage.setItem(SEEN_KEY, latest)
    } catch {
      /* 忽略 */
    }
  }
  state = { ...state, unread: 0 }
  notify()
}

export function subscribe(fn) {
  listeners.push(fn)
  return () => {
    listeners = listeners.filter((x) => x !== fn)
  }
}

export function getAlerts() {
  return state
}
