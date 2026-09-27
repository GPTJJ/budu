import crypto from 'node:crypto'

function required(value, label) {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`缺少 ${label}`)
  return text
}

export function classifyProductSkuSource(row) {
  const category = String(row.productCategory?.name ?? row.productCategoryName ?? '').trim()
  const brand = String(row.brand ?? '').trim()
  const categoryTp = /^(?:pos-)?(?:森醒|12\s*样商店)$/.test(category)
  const brandTp = /^(?:森醒|12\s*样商店)$/.test(brand)
  if (brand && !brandTp && categoryTp) throw new Error(`商品 ${row.id} 的品牌与第三方分类冲突`)
  if (brandTp) return { prefix: 'TP', basis: `brand:${brand}` }
  if (categoryTp) return { prefix: 'TP', basis: `category:${category}` }
  if (/森醒|12\s*样商店/.test(category) || /森醒|12\s*样商店/.test(brand)) {
    throw new Error(`商品 ${row.id} 的第三方归属写法有歧义`)
  }
  return { prefix: 'BD', basis: 'confirmed-default-budu' }
}

export function buildProductSkuPlan(rows, { actorUserId, reason, snapshotId, expectedCount } = {}) {
  if (!Array.isArray(rows)) throw new Error('商品快照必须是数组')
  if (expectedCount != null && rows.length !== expectedCount) throw new Error(`商品数漂移：预计 ${expectedCount}，实际 ${rows.length}`)
  const actor = required(actorUserId, 'actorUserId')
  const why = required(reason, 'reason')
  const snapshot = required(snapshotId, 'snapshotId')
  const ids = new Set()
  const oldSkus = new Set()
  const prepared = rows.map((row) => {
    const id = required(row.id, 'InventoryItem.id')
    if (ids.has(id)) throw new Error(`重复商品 ID：${id}`)
    ids.add(id)
    if (row.category !== 'product') throw new Error(`${id} 不是商品`)
    if (typeof row.isActive !== 'boolean') throw new Error(`${id} isActive 缺失`)
    const name = required(row.name, `${id} name`)
    const createdAt = required(row.createdAt, `${id} createdAt`)
    if (Number.isNaN(Date.parse(createdAt))) throw new Error(`${id} createdAt 无效`)
    const oldSku = row.sku == null ? null : String(row.sku)
    const normalizedOldSku = oldSku?.trim().toUpperCase() || null
    if (normalizedOldSku && oldSkus.has(normalizedOldSku)) throw new Error(`旧 SKU 重复：${normalizedOldSku}`)
    if (normalizedOldSku) oldSkus.add(normalizedOldSku)
    const { prefix, basis } = classifyProductSkuSource(row)
    return { id, name, oldSku, createdAt: new Date(createdAt).toISOString(), isActive: row.isActive === true,
      classificationBasis: basis, prefix, transferCodeBefore: row.transferCode || null }
  })
  const mapping = []
  const counts = { BD: 0, TP: 0 }
  for (const prefix of ['BD', 'TP']) {
    const subset = prepared.filter((row) => row.prefix === prefix)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    for (const row of subset) {
      const serial = ++counts[prefix]
      if (serial > 999999) throw new Error(`${prefix} 流水已用尽`)
      const newSku = `${prefix}-${String(serial).padStart(6, '0')}`
      if (oldSkus.has(newSku)) throw new Error(`新 SKU ${newSku} 已被旧商品编码占用`)
      mapping.push({ ...row, newSku, transferCodeAfter: row.transferCodeBefore,
        alias: row.oldSku?.trim() && row.oldSku.trim().toUpperCase() !== newSku ? row.oldSku.trim().toUpperCase() : null })
    }
  }
  const plan = { schemaVersion: 1, snapshotId: snapshot, actorUserId: actor, reason: why,
    counts: { total: rows.length, BD: counts.BD, TP: counts.TP,
      missingOldSku: prepared.filter((row) => !row.oldSku?.trim()).length,
      aliases: mapping.filter((row) => row.alias).length }, mapping }
  const canonical = JSON.stringify(plan)
  return { ...plan, sha256: crypto.createHash('sha256').update(canonical).digest('hex') }
}
