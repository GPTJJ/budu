export function formatCents(value) {
  const cents = BigInt(value || 0)
  const yuan = cents / 100n
  const decimal = String(cents % 100n).padStart(2, '0')
  return `¥${yuan.toLocaleString('zh-CN')}.${decimal}`
}

export function yuanToCents(value) {
  const text = String(value ?? '').trim()
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error('金额最多保留两位小数')
  const [yuan, decimal = ''] = text.split('.')
  const cents = Number(yuan) * 100 + Number(decimal.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents) || cents > 99999999999) throw new Error('金额超出允许范围')
  return String(cents)
}

export function centsToYuan(value) {
  if (value === null || value === undefined || value === '') return ''
  return (Number(value) / 100).toFixed(2)
}

export function changeCartQuantity(cart, productId, delta) {
  const next = { ...(cart || {}) }
  const quantity = Number(next[productId] || 0) + Number(delta || 0)
  if (quantity <= 0) delete next[productId]
  else next[productId] = Math.min(quantity, 999)
  return next
}

export function cartTotalCents(cart, products) {
  const byId = new Map((products || []).map((product) => [product.productId, product]))
  return Object.entries(cart || {}).reduce((sum, [productId, quantity]) => {
    const product = byId.get(productId)
    if (!product || !Number.isInteger(Number(quantity)) || Number(quantity) <= 0) return sum
    return sum + BigInt(product.salePriceCents) * BigInt(quantity)
  }, 0n)
}

const rootKey = (userId) => `budu-pos:${userId}`
const storeKey = (userId, storeId, field) => `${rootKey(userId)}:${storeId}:${field}`

function readJson(key, fallback) {
  try {
    const value = sessionStorage.getItem(key)
    return value ? JSON.parse(value) : fallback
  } catch {
    return fallback
  }
}

export function getSelectedPosStore(userId) {
  return sessionStorage.getItem(`${rootKey(userId)}:selected-store`) || ''
}

export function setSelectedPosStore(userId, storeId) {
  sessionStorage.setItem(`${rootKey(userId)}:selected-store`, storeId)
}

export function loadPosStoreSession(userId, storeId) {
  return {
    cart: readJson(storeKey(userId, storeId, 'cart'), {}),
    pendingOrderId: sessionStorage.getItem(storeKey(userId, storeId, 'pending-order')) || '',
    successOrderId: sessionStorage.getItem(storeKey(userId, storeId, 'success-order')) || '',
    checkoutKey: sessionStorage.getItem(storeKey(userId, storeId, 'checkout-key')) || '',
  }
}

export function savePosCart(userId, storeId, cart) {
  sessionStorage.setItem(storeKey(userId, storeId, 'cart'), JSON.stringify(cart))
}

export function saveCheckoutKey(userId, storeId, checkoutKey) {
  if (checkoutKey) sessionStorage.setItem(storeKey(userId, storeId, 'checkout-key'), checkoutKey)
  else sessionStorage.removeItem(storeKey(userId, storeId, 'checkout-key'))
}

export function savePendingOrder(userId, storeId, orderId) {
  if (orderId) sessionStorage.setItem(storeKey(userId, storeId, 'pending-order'), orderId)
  else sessionStorage.removeItem(storeKey(userId, storeId, 'pending-order'))
}

export function saveSuccessOrder(userId, storeId, orderId) {
  if (orderId) sessionStorage.setItem(storeKey(userId, storeId, 'success-order'), orderId)
  else sessionStorage.removeItem(storeKey(userId, storeId, 'success-order'))
}

export function clearPosTransaction(userId, storeId) {
  for (const field of ['cart', 'pending-order', 'success-order', 'checkout-key']) {
    sessionStorage.removeItem(storeKey(userId, storeId, field))
  }
}

export function createCheckoutKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `checkout-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export async function compressProductImage(file) {
  if (!file?.type?.startsWith('image/')) throw new Error('请选择图片文件')
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
  const image = await new Promise((resolve, reject) => {
    const element = new Image()
    element.onload = () => resolve(element)
    element.onerror = () => reject(new Error('图片格式不支持'))
    element.src = dataUrl
  })
  const maxSide = 900
  const ratio = Math.min(1, maxSide / Math.max(image.width, image.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.width * ratio))
  canvas.height = Math.max(1, Math.round(image.height * ratio))
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
  let quality = 0.84
  let output = canvas.toDataURL('image/jpeg', quality)
  while (output.length > 580000 && quality > 0.42) {
    quality -= 0.08
    output = canvas.toDataURL('image/jpeg', quality)
  }
  if (output.length > 600000) throw new Error('图片压缩后仍过大，请选择尺寸更小的图片')
  return output
}
