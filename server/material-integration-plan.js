import crypto from 'node:crypto'

export const APPROVED_PRODUCT_SKUS = Object.freeze(['BUDU-BALLSWL-001', 'BUDU-BALLSWL-002', 'BUDU-BWDWL-001', 'BUDU-BDWL-001'])

export function materialIntegrationPlan(category, records) {
  if (!category || category.name !== '物料') throw new Error('MATERIAL_CATEGORY_NOT_CONFIRMED')
  const products = records.filter((row) => row.category === 'product' && row.productCategoryId === category.id)
  const materials = records.filter((row) => row.category === 'material')
  const conflicts = []
  for (const sku of APPROVED_PRODUCT_SKUS) if (products.filter((row) => row.sku === sku).length !== 1) conflicts.push({ type: 'APPROVED_PRODUCT_NOT_RESOLVED', sku })
  if (products.length !== 4) conflicts.push({ type: 'PRODUCT_CATEGORY_COUNT_CHANGED', expected: 4, actual: products.length })
  const normalizedName = (name) => String(name).normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('zh-CN')
  for (const row of materials) {
    if (row.productCategoryId && row.productCategoryId !== category.id) conflicts.push({ type: 'MATERIAL_OTHER_CATEGORY_REVIEW', materialId: row.id, productCategoryId: row.productCategoryId })
    for (const product of products) if (normalizedName(row.name) === normalizedName(product.name)) conflicts.push({ type: 'DISTINCT_ID_NAME_REVIEW', materialId: row.id, productId: product.id, name: row.name })
  }
  const fingerprint = (row) => crypto.createHash('sha256').update(JSON.stringify(row, (_, value) => typeof value === 'bigint' ? value.toString() : value)).digest('hex')
  return {
    mode: 'READ_ONLY', category: { id: category.id, name: category.name }, conflicts,
    protectedProducts: products.map((row) => ({ id: row.id, name: row.name, sku: row.sku, transferCode: row.transferCode, isActive: row.isActive, transferEnabled: row.transferEnabled, partnerReplenishmentEnabled: row.partnerReplenishmentEnabled, fingerprint: fingerprint(row), imageHash: row.imageHash || crypto.createHash('sha256').update(row.image || '').digest('hex'), imageHashAlgorithm: row.imageHash ? 'md5' : 'sha256', references: row._count })),
    materials: materials.map((row) => ({ id: row.id, name: row.name, sku: row.sku, transferCode: row.transferCode, version: row.version, references: row._count, fingerprint: fingerprint(row), proposed: { sku: row.sku ? 'KEEP' : 'GENERATE_ONCE', transferCode: row.transferCode ? 'KEEP' : 'GENERATE_ONCE', salePriceCents: row.salePriceCents?.toString() ?? '10', costPriceCents: row.costPriceCents?.toString() ?? '10', productCategoryId: row.productCategoryId || category.id, isActive: false, partnerReplenishmentEnabled: false } })),
  }
}
