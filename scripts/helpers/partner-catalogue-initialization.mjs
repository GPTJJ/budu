// One-time administrative planner only. Never imported by application startup,
// product save hooks, catalogue reads or background workers.
import { applyAutoSku } from '../../src/utils/productExcel.js'
import { isPartnerCandy } from '../../shared/partnerProductUnits.js'
import { isCatalogueEligible } from '../../server/partner-replenishment-catalogue.js'

export function planPartnerCatalogueInitialization(products) {
  const targets = products.filter(p => p.category === 'product' && p.partnerSupplyEnabled === true).sort((a, b) => a.id.localeCompare(b.id))
  const missing = targets.filter(p => !p.sku)
  // Continue the existing default generator sequence, reserving every existing
  // value. Only generated suffix entries are used; existing SKUs never change.
  const prefix = 'BUDU-12Y'
  const used = new Set(products.filter(p => p.sku).map(p => p.sku.trim().toUpperCase()))
  const last = Math.max(0, ...[...used].map(s => /^BUDU-12Y-(\d+)$/.exec(s)).filter(Boolean).map(m => Number(m[1])))
  if (!Number.isSafeInteger(last) || last + missing.length > 10000) throw new Error('SKU_SEQUENCE_REQUIRES_REVIEW')
  const generated = applyAutoSku(Array.from({ length: last + missing.length }, () => ({})), prefix).slice(last)
  const missingSku = new Map(missing.map((p, i) => [p.id, generated[i].sku]))
  const rows = targets.map(p => {
    const sku = p.sku || missingSku.get(p.id)
    let blocked = !p.sku && used.has(sku) ? 'SKU_COLLISION' : null
    const partnerOrderUnit = isPartnerCandy(p) ? 'PCS' : p.partnerOrderUnit || (String(p.unit || '').trim() && BigInt(p.salePriceCents || 0) > 0n ? 'NATIVE' : null)
    const target = { ...p, sku, partnerOrderUnit, partnerMinOrderBaseQty: 1, partnerOrderStepBaseQty: 1, partnerReplenishmentEnabled: true }
    if (!blocked && !isCatalogueEligible(target)) blocked = 'PARTNER_UNIT_OR_PRICE_INVALID'
    if (sku.length > 64) blocked = 'SKU_INVALID'
    if (!blocked) used.add(sku)
    return { id: p.id, name: p.name, candy: isPartnerCandy(p), blocked,
      before: Object.fromEntries(['sku', 'partnerOrderUnit', 'partnerMinOrderBaseQty', 'partnerOrderStepBaseQty', 'partnerReplenishmentEnabled'].map(k => [k, p[k]])),
      after: blocked ? null : { sku, partnerOrderUnit, partnerMinOrderBaseQty: 1, partnerOrderStepBaseQty: 1, partnerReplenishmentEnabled: true } }
  })
  return { targetCount: targets.length, candyCount: targets.filter(isPartnerCandy).length, missingSkuCount: missing.length, rows }
}

// The durable deployment receipt must be checked BEFORE planning/reapplying.
// A completed operation is a no-op even if an administrator has since turned
// Partner OFF. An interrupted operation fails closed for reconciliation.
export function initializationReceiptAction(receipt) {
  if (!receipt) return 'APPLY'
  if (receipt.status === 'COMPLETE') return 'NO_OP'
  throw new Error('INITIALIZATION_INCOMPLETE_RECONCILIATION_REQUIRED')
}
