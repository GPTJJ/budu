import * as XLSX from 'xlsx'
import { downloadFile } from './downloadFile.js'

export const supplyStatusLabel = (status) => ({ pending: '待备货', shipped: '已发货', withdrawn: '已撤回' }[status] || status || '—')
export const supplyPaymentLabel = (status) => ({ unpaid: '未收款', partial: '部分收款', settled: '已结清', void: '无需收款' }[status] || status || '—')
export const formatCents = (value) => `¥${(Number(value || 0) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
export const formatDiscount = (bps) => `${(Number(bps || 0) / 100).toFixed(Number(bps || 0) % 100 ? 2 : 0)}%`
export const yuanNumber = (value) => Number(value || 0) / 100

const formatTime = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'

export function createPartnerSupplyWorkbook(report) {
  const summaryRows = (report?.summary || []).map((row) => ({
    合作商: row.partnerName,
    供货单数: row.orderCount,
    供货金额: yuanNumber(row.supplyAmountCents),
    期间已收款: yuanNumber(row.receivedAmountCents),
    当前待收款: yuanNumber(row.outstandingAmountCents),
  }))
  const detailRows = (report?.orders || []).flatMap((order) => (order.items || []).map((item) => ({
    供货单号: order.orderNo,
    日期: order.businessDate,
    合作商: order.partnerName,
    发货门店: order.fromStoreName,
    物流状态: supplyStatusLabel(order.status),
    货款状态: supplyPaymentLabel(order.paymentStatus),
    产品编号: item.productCode,
    产品名称: item.productName,
    产品分类: item.productCategory || '未分类',
    数量: item.quantity,
    零售价快照: yuanNumber(item.retailPriceCents),
    合作折扣快照: formatDiscount(item.discountBps),
    合作单价: yuanNumber(item.partnerUnitPriceCents),
    小计: yuanNumber(item.subtotalCents),
    备注: order.note || '',
    创建人: order.createdBy || '—',
    发货确认人: order.shippedBy || '—',
    发货时间: formatTime(order.shippedAt),
  })))
  const receiptRows = (report?.receipts || []).map((receipt) => ({
    收款日期: receipt.receivedDate,
    合作商: receipt.partnerName,
    供货单号: receipt.orderNo,
    本次收款: yuanNumber(receipt.amountCents),
    登记人: receipt.createdBy || '—',
    备注: receipt.note || '',
  }))
  const workbook = XLSX.utils.book_new()
  const summarySheet = XLSX.utils.json_to_sheet(summaryRows.length ? summaryRows : [{ 提示: '当前筛选条件下暂无合作商汇总' }])
  const detailSheet = XLSX.utils.json_to_sheet(detailRows.length ? detailRows : [{ 提示: '当前筛选条件下暂无供货明细' }])
  const receiptSheet = XLSX.utils.json_to_sheet(receiptRows.length ? receiptRows : [{ 提示: '当前筛选条件下暂无收款明细' }])
  summarySheet['!cols'] = [{ wch: 24 }, { wch: 12 }, { wch: 16 }, { wch: 16 }, { wch: 16 }]
  detailSheet['!cols'] = [{ wch: 22 }, { wch: 12 }, { wch: 24 }, { wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 18 }, { wch: 28 }, { wch: 16 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 28 }, { wch: 14 }, { wch: 14 }, { wch: 20 }]
  receiptSheet['!cols'] = [{ wch: 14 }, { wch: 24 }, { wch: 22 }, { wch: 16 }, { wch: 14 }, { wch: 28 }]
  XLSX.utils.book_append_sheet(workbook, summarySheet, '合作商汇总')
  XLSX.utils.book_append_sheet(workbook, detailSheet, '供货明细')
  XLSX.utils.book_append_sheet(workbook, receiptSheet, '收款明细')
  return { workbook, summaryRows, detailRows, receiptRows }
}

export function exportPartnerSupplyExcel(report, options = {}) {
  const result = createPartnerSupplyWorkbook(report)
  const range = options.start || options.end ? `_${options.start || '最早'}_${options.end || '最新'}` : ''
  XLSX.writeFile(result.workbook, `BUDU合作商供货对账${range}.xlsx`)
  return result
}

function wrapCanvasText(ctx, value, maxWidth) {
  const chars = [...String(value || '—')]
  const lines = []
  let current = ''
  for (const char of chars) {
    const next = current + char
    if (ctx.measureText(next).width > maxWidth && current) {
      lines.push(current)
      current = char
    } else current = next
  }
  if (current) lines.push(current)
  return lines.length ? lines : ['—']
}

export async function exportPartnerSupplyImage(order) {
  if (document.fonts?.ready) await document.fonts.ready
  const scale = 2
  const width = 750
  const margin = 48
  const contentWidth = width - margin * 2
  const font = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif'
  const measure = document.createElement('canvas').getContext('2d')
  measure.font = `600 23px ${font}`
  const layouts = (order.items || []).map((item) => {
    const titleLines = wrapCanvasText(measure, `${item.productCode || '—'} ${item.productName || '—'}`, contentWidth - 32)
    return { item, titleLines, height: Math.max(86, titleLines.length * 30 + 52) }
  })
  measure.font = `21px ${font}`
  const noteLines = wrapCanvasText(measure, order.note || '—', contentWidth - 32)
  const height = 560 + layouts.reduce((sum, row) => sum + row.height, 0) + noteLines.length * 30
  const canvas = document.createElement('canvas')
  canvas.width = width * scale
  canvas.height = height * scale
  const ctx = canvas.getContext('2d')
  ctx.scale(scale, scale)
  ctx.fillStyle = '#fffdfb'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#712f3d'
  ctx.fillRect(0, 0, width, 148)
  ctx.fillStyle = '#ffffff'
  ctx.font = `800 40px ${font}`
  ctx.fillText('budu', margin, 58)
  ctx.font = `700 28px ${font}`
  ctx.fillText('合作商供货单', margin, 104)
  ctx.font = `18px ${font}`
  ctx.fillText(order.orderNo || order.id, margin, 132)

  let y = 190
  ctx.fillStyle = '#2f2930'
  ctx.font = `800 30px ${font}`
  ctx.fillText(order.partnerName || '—', margin, y)
  y += 42
  ctx.fillStyle = '#766d72'
  ctx.font = `21px ${font}`
  ctx.fillText(`发货门店：${order.fromStoreName || '—'}`, margin, y)
  y += 32
  ctx.fillText(`业务日期：${order.businessDate || '—'}    状态：${supplyStatusLabel(order.status)}`, margin, y)
  y += 48

  ctx.fillStyle = '#f8f1f3'
  ctx.fillRect(margin, y, contentWidth, 52)
  ctx.fillStyle = '#712f3d'
  ctx.font = `700 22px ${font}`
  ctx.fillText(`产品 · ${layouts.length} 项`, margin + 16, y + 34)
  y += 52
  ctx.strokeStyle = '#eadfe2'
  ctx.strokeRect(margin, y - 52, contentWidth, layouts.reduce((sum, row) => sum + row.height, 0) + 52)
  for (const layout of layouts) {
    ctx.strokeStyle = '#f0e8ea'
    ctx.beginPath(); ctx.moveTo(margin, y); ctx.lineTo(width - margin, y); ctx.stroke()
    ctx.fillStyle = '#342f32'
    ctx.font = `650 22px ${font}`
    layout.titleLines.forEach((line, index) => ctx.fillText(line, margin + 16, y + 30 + index * 29))
    ctx.fillStyle = '#766d72'
    ctx.font = `20px ${font}`
    const detailY = y + layout.height - 20
    ctx.fillText(`${layout.item.quantity} × ${formatCents(layout.item.partnerUnitPriceCents)}`, margin + 16, detailY)
    ctx.fillStyle = '#712f3d'
    ctx.font = `700 21px ${font}`
    ctx.textAlign = 'right'
    ctx.fillText(formatCents(layout.item.subtotalCents), width - margin - 16, detailY)
    ctx.textAlign = 'left'
    y += layout.height
  }
  y += 54
  ctx.fillStyle = '#2f2930'
  ctx.font = `800 30px ${font}`
  ctx.fillText('商品合计', margin, y)
  ctx.fillStyle = '#712f3d'
  ctx.textAlign = 'right'
  ctx.fillText(formatCents(order.totalAmountCents), width - margin, y)
  ctx.textAlign = 'left'
  y += 42
  ctx.fillStyle = '#766d72'
  ctx.font = `21px ${font}`
  ctx.fillText(`合作政策：零售价 × ${formatDiscount(order.effectiveDiscountBps)}`, margin, y)
  y += 42
  ctx.fillStyle = '#712f3d'
  ctx.font = `700 21px ${font}`
  ctx.fillText('备注', margin, y)
  y += 30
  ctx.fillStyle = '#5d5559'
  ctx.font = `20px ${font}`
  noteLines.forEach((line, index) => ctx.fillText(line, margin, y + index * 28))
  ctx.fillStyle = '#a3999e'
  ctx.font = `17px ${font}`
  ctx.fillText('BUDU Operating System · 合作商供货 1.0', margin, height - 38)
  await downloadFile({ dataUrl: canvas.toDataURL('image/png'), name: `BUDU合作商供货_${order.orderNo || order.id}.png`, mimeType: 'image/png' })
}
