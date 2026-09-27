const FIELD_ALIASES = {
  name: ['商品名称', '菜品名称', '菜品名', '品名', '名称', '商品', '菜品', 'productname', 'itemname', 'menuitem', 'name'],
  sku: ['sku', '商品sku', '菜品sku', '商品编码', '菜品编码', '商品编号', '菜品编号', '货号', '编码', 'productsku', 'itemsku'],
  posCategory: ['分类', '商品分类', '菜品分类', '品类', '类别', 'category', 'productcategory', 'menucategory'],
  salePriceCents: ['售价', '售价元', '售卖价', '售卖价格', '销售价', '销售价格', '零售价', '价格', '单价', 'price', 'saleprice', 'sellingprice'],
  costPriceCents: ['成本价', '成本价元', '成本', '进价', '采购价', 'cost', 'costprice'],
  unit: ['单位', '售卖单位', '计量单位', 'unit'],
  barcode: ['条码', '商品条码', '菜品条码', 'barcode', 'ean', 'upc'],
  sortOrder: ['排序', '顺序', '序号', 'sort', 'sortorder'],
  trackInventory: ['参与库存', '是否参与库存', '库存商品', 'trackinventory'],
}

function normalizedHeader(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-—/\\（）()【】\[\]：:·.]/g, '')
}

const ALIAS_TO_FIELD = new Map(Object.entries(FIELD_ALIASES)
  .flatMap(([field, aliases]) => aliases.map((alias) => [normalizedHeader(alias), field])))

function fieldForHeader(value) {
  const normalized = normalizedHeader(value)
  if (ALIAS_TO_FIELD.has(normalized)) return ALIAS_TO_FIELD.get(normalized)
  for (const [alias, field] of ALIAS_TO_FIELD) {
    if (alias.length >= 3 && normalized.startsWith(alias)) return field
  }
  return ''
}

function moneyToCents(value) {
  const text = String(value ?? '').trim().replace(/[¥￥,，\s元]/g, '')
  if (!text) return { error: '缺少金额' }
  // 最多 3 位小数；3 位小数按第 3 位四舍五入到分（字符串计算，避免浮点误差）
  if (!/^\d+(?:\.\d{1,3})?$/.test(text)) return { error: `金额格式不正确：${String(value)}` }
  let [yuan, fraction = ''] = text.split('.')
  if (fraction.length > 2) {
    const third = Number(fraction[2])
    fraction = fraction.slice(0, 2)
    if (third >= 5) {
      const carry = Number(fraction) + 1
      if (carry === 100) {
        yuan = String(Number(yuan) + 1)
        fraction = '00'
      } else {
        fraction = String(carry).padStart(2, '0')
      }
    }
  }
  const cents = BigInt(yuan) * 100n + BigInt(fraction.padEnd(2, '0'))
  if (cents > 99999999999n) return { error: '金额超出允许范围' }
  return { value: cents.toString() }
}

function defaultCategory(sheetName) {
  const name = String(sheetName || '').trim()
  return /^(sheet|工作表)\s*\d*$/i.test(name) || /^(菜单|商品|菜品|menu)$/i.test(name) ? '' : name.slice(0, 30)
}

function findHeader(rows) {
  let best = null
  for (let index = 0; index < Math.min(rows.length, 20); index += 1) {
    const fields = (rows[index] || []).map(fieldForHeader)
    const found = new Set(fields.filter(Boolean))
    const score = found.size
    if (found.has('name') && found.has('salePriceCents') && (!best || score > best.score)) {
      best = { index, fields, score }
    }
  }
  return best
}

function truthyCell(value) {
  const text = String(value ?? '').trim().toLowerCase()
  return ['1', 'true', '是', '参与', '启用', 'yes', 'y'].includes(text)
}

/**
 * 自动生成 SKU：{prefix}-{NN}（如 BUDU-12Y-01）；序号位数按行数自适应（<100 用 2 位，≥100 用 3 位）
 * 覆盖 Excel 中的 SKU（用于不想沿用源系统编码的场景）
 */
export function applyAutoSku(rows, prefix = 'BUDU-12Y') {
  const p = String(prefix || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '') || 'ITEM'
  const width = rows.length >= 100 ? 3 : 2
  return rows.map((row, index) => ({ ...row, sku: `${p}-${String(index + 1).padStart(width, '0')}` }))
}

export function analyzeProductMenuSheets(sheets, existingProducts = []) {
  const existingBySku = new Map(existingProducts.map((item) => [String(item.sku || '').trim().toUpperCase(), item]).filter(([key]) => key))
  const existingByName = new Map(existingProducts.map((item) => [String(item.name || '').trim(), item]).filter(([key]) => key))
  const parsed = []
  const sheetErrors = []

  for (const sheet of sheets || []) {
    const rows = Array.isArray(sheet.rows) ? sheet.rows : []
    const header = findHeader(rows)
    if (!header) {
      if (rows.some((row) => (row || []).some((cell) => String(cell ?? '').trim()))) sheetErrors.push(`${sheet.name || '未命名工作表'}：未识别到“菜品名”和“售价”列`)
      continue
    }
    let inheritedCategory = defaultCategory(sheet.name)
    const column = Object.fromEntries(header.fields.map((field, index) => [field, index]).filter(([field]) => field))
    for (let rowIndex = header.index + 1; rowIndex < rows.length; rowIndex += 1) {
      const cells = rows[rowIndex] || []
      const cell = (field) => column[field] === undefined ? '' : cells[column[field]]
      const name = String(cell('name') ?? '').trim()
      const rawSku = String(cell('sku') ?? '').trim()
      const rawSale = String(cell('salePriceCents') ?? '').trim()
      const rawCost = String(cell('costPriceCents') ?? '').trim()
      const rowCategory = String(cell('posCategory') ?? '').trim()

      if (!name && !rawSku && !rawSale && !rawCost && !rowCategory) continue
      if (rowCategory) inheritedCategory = rowCategory.slice(0, 30)
      const onlyName = name && !rawSku && !rawSale && !rawCost && !rowCategory
      if (onlyName) {
        inheritedCategory = name.slice(0, 30)
        continue
      }
      if (/^(合计|总计|小计|total)$/i.test(name)) continue

      const sku = rawSku.replace(/\s+/g, '').toUpperCase()
      const sale = moneyToCents(rawSale)
      const cost = moneyToCents(rawCost)
      const posCategory = (rowCategory || inheritedCategory).slice(0, 30)
      const errors = []
      if (!name) errors.push('缺少菜品名')
      if (!sku) errors.push('缺少 SKU')
      if (!posCategory) errors.push('缺少分类')
      if (sale.error) errors.push(`售价${sale.error === '缺少金额' ? '为空' : sale.error}`)
      if (cost.error) errors.push(`成本价${cost.error === '缺少金额' ? '为空' : cost.error}`)

      const skuMatch = existingBySku.get(sku)
      const nameMatch = existingByName.get(name)
      if (skuMatch && nameMatch && skuMatch.productId !== nameMatch.productId) errors.push('SKU 与菜品名分别匹配到不同商品')
      if (!skuMatch && nameMatch) errors.push('名称已存在；禁止按名称自动关联，请编辑现有商品')
      const matched = skuMatch || null
      parsed.push({
        sourceSheet: sheet.name || '未命名工作表',
        sourceRow: rowIndex + 1,
        name,
        sku,
        posCategory,
        salePriceCents: sale.value || '',
        costPriceCents: cost.value || '',
        unit: String(cell('unit') ?? '').trim() || '份',
        barcode: String(cell('barcode') ?? '').trim(),
        sortOrder: String(cell('sortOrder') ?? '').trim(),
        ...(column.trackInventory === undefined ? {} : { trackInventory: truthyCell(cell('trackInventory')) }),
        isActive: true,
        action: matched ? 'update' : 'create',
        matchedProductId: matched?.productId || '',
        errors,
      })
    }
  }

  const skuRows = new Map()
  const nameRows = new Map()
  for (const row of parsed) {
    if (row.sku) skuRows.set(row.sku, [...(skuRows.get(row.sku) || []), row])
    if (row.name) nameRows.set(row.name, [...(nameRows.get(row.name) || []), row])
  }
  for (const group of skuRows.values()) if (group.length > 1) group.forEach((row) => row.errors.push('Excel 内 SKU 重复'))
  for (const group of nameRows.values()) if (group.length > 1) group.forEach((row) => row.errors.push('Excel 内菜品名重复'))

  return {
    rows: parsed,
    validRows: parsed.filter((row) => row.errors.length === 0),
    sheetErrors,
  }
}
