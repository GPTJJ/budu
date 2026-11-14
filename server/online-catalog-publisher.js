/**
 * ONLINE-CATALOG-ADMIN-001 — CloudBase publisher.
 *
 * The OS server is the management authority; this module projects one profile
 * into the MiniProgram `products` collection and updates `_meta.categories`.
 * It never deletes unknown documents and never performs a full collection
 * overwrite.
 */
import crypto from 'node:crypto'
import { httpError } from './pos-core.js'

const COLLECTION = 'products'
const META_DOC = '_meta'
const DATA_URL_RE = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/i
const EXT = { png: 'png', jpg: 'jpg', jpeg: 'jpg', webp: 'webp', gif: 'gif' }

let cachedPublisher = null

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = stable(value[key])
      return out
    }, {})
  }
  return value
}

export function checksum(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}

/** 组合商品：保留口味槽位定义；若已声明单盒价，则跟随线上价一起更新 */
export function normalizeCombo(value, unitPriceCent) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const combo = { ...value }
  if ('unitPriceCent' in combo) combo.unitPriceCent = unitPriceCent
  return combo
}

export function buildProductDoc({ profile, category, item, combo = null }) {
  if (!profile?.mpId) throw httpError('缺少小程序商品 ID', 409)
  if (!category?.name) throw httpError('缺少线上分类', 409)
  const price = profile.priceCents !== null && profile.priceCents !== undefined ? profile.priceCents : item?.salePriceCents
  const unitPriceCent = price === null || price === undefined ? 0 : Number(price)
  if (!Number.isSafeInteger(unitPriceCent) || unitPriceCent < 0) throw httpError('线上售价无效', 409)
  if (profile.status === 'ON' && unitPriceCent <= 0) throw httpError('上架商品必须有大于 0 的售价', 409)
  return {
    id: profile.mpId,
    name: profile.title || item?.name || '',
    category: category.name,
    status: profile.status === 'ON' ? 'on' : 'off',
    sortOrder: profile.sortOrder || 0,
    unit: profile.unit || item?.unit || '份',
    spec: profile.spec || item?.spec || '',
    unitPriceCent,
    shelfLife: profile.shelfLife || '',
    storage: profile.storage || '',
    subtitle: profile.subtitle || '',
    media: profile.media && typeof profile.media === 'object' ? profile.media : {},
    combo: normalizeCombo(combo, unitPriceCent),
    categoryMeta: category.meta && typeof category.meta === 'object' ? category.meta : {},
  }
}

export function createOnlineCatalogPublisher({ app, envId = '', logger = console } = {}) {
  if (!app) throw httpError('CloudBase publisher 未初始化', 503)
  const db = app.database()

  async function uploadDataUrl(dataUrl, mpId, slot, index = 0) {
    const match = String(dataUrl || '').match(DATA_URL_RE)
    if (!match) return dataUrl
    const ext = EXT[match[1].toLowerCase()] || 'jpg'
    const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64')
    if (!buffer.length) throw httpError('图片内容为空', 409)
    if (buffer.length > 600000) throw httpError('图片超过 600KB，请压缩后重试', 409)
    const cloudPath = `product-cover/${mpId}/${slot}-${index}.${ext}`
    const result = await app.uploadFile({ cloudPath, fileContent: buffer })
    const fileID = result?.fileID || result?.fileId
    if (!fileID) throw httpError('CloudBase 图片上传未返回 fileID', 502)
    return fileID
  }

  async function materializeMedia(media, mpId) {
    const source = media && typeof media === 'object' ? media : {}
    const output = { ...source }
    if (typeof source.cover === 'string' && DATA_URL_RE.test(source.cover)) {
      output.cover = await uploadDataUrl(source.cover, mpId, 'cover')
    }
    for (const key of ['gallery', 'detail']) {
      if (Array.isArray(source[key])) {
        output[key] = []
        for (let index = 0; index < source[key].length; index += 1) {
          const value = source[key][index]
          output[key].push(typeof value === 'string' && DATA_URL_RE.test(value)
            ? await uploadDataUrl(value, mpId, key, index)
            : value)
        }
      }
    }
    return output
  }

  async function readProduct(mpId) {
    const result = await db.collection(COLLECTION).where({ id: mpId }).limit(1).get()
    return (result?.data || [])[0] || null
  }

  async function readAllProducts() {
    const result = await db.collection(COLLECTION).limit(200).get()
    return (result?.data || []).filter((doc) => doc && doc.id && doc.id !== META_DOC)
  }

  async function publishProduct({ profile, category, item }) {
    const existing = await readProduct(profile.mpId)
    // 档案没存组合定义时，沿用 CloudBase 现有值，避免把 combo 覆盖成 null
    const doc = buildProductDoc({ profile, category, item, combo: profile.combo ?? existing?.combo ?? null })
    doc.media = await materializeMedia(doc.media, doc.id)
    if (existing) {
      // @cloudbase/node-sdk document.update/add/set take the payload directly
      // (unlike the wx client SDK's { data: ... } wrapper).
      await db.collection(COLLECTION).doc(existing._id).update(doc)
    } else {
      await db.collection(COLLECTION).add(doc)
    }
    // CloudBase is eventually consistent: retry the read-back so a stale
    // snapshot right after the write does not fail checksum verification.
    let readBack = null
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 400 * attempt))
      readBack = await readProduct(doc.id)
      if (!readBack) continue
      const actual = checksum({
        id: readBack.id,
        name: readBack.name,
        category: readBack.category,
        status: readBack.status,
        sortOrder: readBack.sortOrder,
        unit: readBack.unit,
        spec: readBack.spec,
        unitPriceCent: readBack.unitPriceCent,
        shelfLife: readBack.shelfLife,
        storage: readBack.storage,
        subtitle: readBack.subtitle,
        media: readBack.media || {},
        combo: readBack.combo ?? null,
        categoryMeta: readBack.categoryMeta || {},
      })
      if (checksum(doc) === actual) {
        logger.info?.('[online-catalog] published', { mpId: doc.id, envId, action: existing ? 'updated' : 'created', checksum: actual, attempts: attempt + 1 })
        return { action: existing ? 'updated' : 'created', checksum: actual, doc }
      }
    }
    if (!readBack) throw httpError('发布后回读不到商品', 502)
    throw httpError('发布回读校验失败，请重试', 502)
  }

  async function publishCategories(categories) {
    const names = (categories || []).map((category) => category.name).filter(Boolean)
    if (!names.length) throw httpError('没有可发布的线上分类', 409)
    const metaRef = db.collection(COLLECTION).doc(META_DOC)
    let existing = null
    try { existing = await metaRef.get() } catch { existing = null }
    if (existing?.data && !Array.isArray(existing.data)) await metaRef.update({ categories: names })
    else await metaRef.set({ categories: names })
    logger.info?.('[online-catalog] categories published', { envId, count: names.length })
    return { categories: names }
  }

  return { publishProduct, publishCategories, readProduct, readAllProducts, uploadDataUrl, buildProductDoc, envId }
}

export async function getOnlineCatalogPublisher() {
  if (cachedPublisher) return cachedPublisher
  const envId = String(process.env.TCB_ENV_ID || '').trim()
  const secretId = String(process.env.TCB_SECRET_ID || '').trim()
  const secretKey = String(process.env.TCB_SECRET_KEY || '').trim()
  if (!envId || !secretId || !secretKey) {
    throw httpError('CloudBase 发布凭据未配置（TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY）', 503)
  }
  const imported = await import('@cloudbase/node-sdk').catch(() => {
    throw httpError('CloudBase SDK 未安装，请先执行 npm install', 503)
  })
  const sdk = imported.default || imported
  let app
  try {
    app = sdk.init({ env: envId, secretId, secretKey })
  } catch (error) {
    throw httpError(`CloudBase 初始化失败：${error.message || error}`, 503)
  }
  cachedPublisher = createOnlineCatalogPublisher({ app, envId })
  return cachedPublisher
}
