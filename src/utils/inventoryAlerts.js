/** 库存申请实时通知（开发者账号轮询，未读状态存 localStorage） */
import { loadUserData, getInventoryRequests } from './userData'

const SEEN_KEY = 'budu-inventory-seen-at'
const POLL_MS = 8000

let state = { unread: 0, items: [] }
let listeners = []
let timer = null
let currentUserKey = null

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
  const items = getInventoryRequests()
    .filter((r) => r.status === 'pending' && (!seenAt || r.createdAt > seenAt))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  state = { unread: items.length, items }
  notify()
}

async function refresh() {
  try {
    await loadUserData()
  } catch {
    /* 网络异常时保留当前状态 */
  }
  compute()
}

/** 启动轮询（仅开发者）；切换账号时自动重置 */
export function ensurePolling(user) {
  const key = user && user.role === 'developer' ? user.username : null
  if (currentUserKey === key) return
  currentUserKey = key
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
