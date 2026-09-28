import * as XLSX from 'xlsx'
import { downloadFile } from './downloadFile.js'

export const replenishmentStatusLabel = (status) => ({
  SUBMITTED: '待审核', APPROVED: '待发货', PARTIALLY_SHIPPED: '部分发货',
  SHIPPED: '已发货', REJECTED: '已驳回', CANCELLED: '已取消',
}[status] || status || '—')

export const applicationTime = (value) => new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(value))

const units = (item) => item.orderUnitSnapshot === 'KG' ? 'kg' : item.orderUnitSnapshot === 'PCS' ? '颗' : item.nativeUnitSnapshot || '单位'
const displayQuantity = (base, item) => item.orderUnitSnapshot === 'KG' ? Number(base || 0) / 1000 : Number(base || 0)
const priceYuan = (item) => Number(item.basePriceSnapshotCents) * Number(item.discountBpsSnapshot) / 1_000_000
const moneyYuan = (cents) => Number(cents || 0) / 100

function totalQuantity(items, field) {
  const totals = new Map()
  for (const item of items) {
    const unit = units(item)
    totals.set(unit, (totals.get(unit) || 0) + displayQuantity(item[field], item))
  }
  return [...totals].map(([unit, amount]) => `${Number(amount.toFixed(3))} ${unit}`).join(' + ')
}

export function createReplenishmentWorkbook(orders) {
  const summary = [['申请日期', '订单号', '合作商名称', '合作商门店', '订单状态', '商品种类数', '申请总数量', '已发总数量', '订单金额']]
  const details = [['申请日期', '订单号', '合作商名称', '合作商门店', '订单状态', '商品名称', 'SKU（POS）', '单位', '供货价', '申请数量', '已发数量', '待发数量', '小计']]
  for (const order of orders) {
    const common = [applicationTime(order.submittedAt), order.orderNo, order.partnerNameSnapshot, order.partnerStore?.name || '', replenishmentStatusLabel(order.status)]
    const items = order.items || []
    summary.push([...common, items.length, totalQuantity(items, 'requestedQuantityBase'), totalQuantity(items, 'shippedQuantityBase'), moneyYuan(order.requestedTotalAmountCents)])
    for (const item of items) {
      const remaining = item.remainingQuantityBase == null
        ? (order.status === 'SUBMITTED' ? item.requestedQuantityBase : 0)
        : item.remainingQuantityBase
      details.push([...common, item.productNameSnapshot, item.skuSnapshot || '', units(item), priceYuan(item), displayQuantity(item.requestedQuantityBase, item), displayQuantity(item.shippedQuantityBase, item), displayQuantity(remaining, item), moneyYuan(item.requestedLineAmountCents)])
    }
  }
  const workbook = XLSX.utils.book_new()
  for (const [name, rows, widths] of [
    ['订单汇总', summary, [19, 28, 22, 22, 14, 14, 22, 22, 16]],
    ['商品明细', details, [19, 28, 22, 22, 14, 28, 22, 12, 14, 14, 14, 14, 14]],
  ]) {
    const sheet = XLSX.utils.aoa_to_sheet(rows)
    sheet['!cols'] = widths.map((wch) => ({ wch }))
    XLSX.utils.book_append_sheet(workbook, sheet, name)
  }
  return workbook
}

export function exportReplenishmentExcel(orders) {
  const workbook = createReplenishmentWorkbook(orders)
  XLSX.writeFile(workbook, `budu补货订单_${new Date().toISOString().slice(0, 10)}.xlsx`)
  return workbook
}

function wrapText(ctx, text, width) {
  const lines = []
  let line = ''
  for (const char of [...String(text || '—')]) {
    if (line && ctx.measureText(line + char).width > width) { lines.push(line); line = char } else line += char
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['—']
}

export async function createReplenishmentImage(order) {
  if (document.fonts?.ready) await document.fonts.ready
  const width = 750
  const margin = 42
  const font = '"PingFang SC", "Microsoft YaHei", sans-serif'
  const measure = document.createElement('canvas').getContext('2d')
  measure.font = `600 24px ${font}`
  const rows = (order.items || []).map((item) => {
    const lines = wrapText(measure, item.productNameSnapshot, 355)
    return { item, lines, height: Math.max(76, lines.length * 32 + 28) }
  })
  const height = 338 + rows.reduce((sum, row) => sum + row.height, 0) + 32
  const scale = Math.min(2, 16000 / height)
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(width * scale)
  canvas.height = Math.ceil(height * scale)
  const ctx = canvas.getContext('2d')
  ctx.scale(scale, scale)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#712f3d'
  ctx.fillRect(0, 0, width, 12)
  ctx.fillStyle = '#272530'
  ctx.font = `700 30px ${font}`
  ctx.fillText(order.orderNo, margin, 65)
  ctx.font = `24px ${font}`
  ctx.fillText(`合作商：${order.partnerNameSnapshot || '—'}`, margin, 115)
  ctx.fillText(`门店：${order.partnerStore?.name || '—'}`, margin, 153)
  ctx.fillText(`申请时间：${applicationTime(order.submittedAt)}`, margin, 191)
  ctx.fillStyle = '#f8f1f3'
  ctx.fillRect(margin, 235, width - margin * 2, 62)
  ctx.fillStyle = '#712f3d'
  ctx.font = `700 23px ${font}`
  ctx.fillText('商品名称', margin + 16, 274)
  ctx.textAlign = 'right'
  ctx.fillText('申请数量', 582, 274)
  ctx.fillText('已发数量', width - margin - 16, 274)
  let y = 297
  for (const row of rows) {
    ctx.fillStyle = '#e9e1e4'
    ctx.fillRect(margin, y + row.height - 1, width - margin * 2, 1)
    ctx.fillStyle = '#272530'
    ctx.textAlign = 'left'
    ctx.font = `600 24px ${font}`
    row.lines.forEach((line, index) => ctx.fillText(line, margin + 16, y + 38 + index * 32))
    ctx.textAlign = 'right'
    ctx.font = `23px ${font}`
    ctx.fillText(`${displayQuantity(row.item.requestedQuantityBase, row.item)} ${units(row.item)}`, 582, y + 40)
    ctx.fillText(`${displayQuantity(row.item.shippedQuantityBase, row.item)} ${units(row.item)}`, width - margin - 16, y + 40)
    y += row.height
  }
  return canvas
}

export async function exportReplenishmentImage(order) {
  const canvas = await createReplenishmentImage(order)
  await downloadFile({ dataUrl: canvas.toDataURL('image/png'), name: `budu补货申请_${order.orderNo}.png`, mimeType: 'image/png' })
}
