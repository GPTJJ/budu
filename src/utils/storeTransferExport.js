import * as XLSX from 'xlsx'
import { downloadFile } from './downloadFile.js'
import { transferStatusLabel } from './storeTransfer.js'

const formatTime = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'

export function transferExcelRows(records, storeLabel) {
  return (Array.isArray(records) ? records : []).flatMap((record) =>
    (record.items || []).map((item) => ({
      调拨单号: record.id,
      创建时间: formatTime(record.createdAt),
      状态: transferStatusLabel(record.status),
      调出门店: storeLabel(record.fromStoreKey, record.fromStoreName),
      调入门店: storeLabel(record.storeKey, record.storeName),
      类型: item.category === 'material' ? '物料' : item.category === 'product' ? '产品' : '其他',
      名称: item.productName || '—',
      编码: item.itemCode || '—',
      数量: Number(item.quantity) || 0,
      申请人: record.createdBy || '—',
      发货人: record.shippedBy || '—',
      发货时间: formatTime(record.shippedAt),
      备注: record.note || '',
    })),
  )
}

export function exportTransferExcel(records, storeLabel) {
  const rows = transferExcelRows(records, storeLabel)
  const sheet = XLSX.utils.json_to_sheet(rows.length ? rows : [{ 提示: '当前筛选条件下暂无调拨明细' }])
  sheet['!cols'] = [
    { wch: 25 }, { wch: 20 }, { wch: 10 }, { wch: 16 }, { wch: 16 }, { wch: 9 },
    { wch: 28 }, { wch: 24 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 20 }, { wch: 30 },
  ]
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, '门店调拨明细')
  XLSX.writeFile(workbook, `BUDU门店调拨_${new Date().toISOString().slice(0, 10)}.xlsx`)
}

function wrapCanvasText(ctx, text, maxWidth) {
  const chars = [...String(text || '—')]
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

export async function exportTransferImage(record, storeLabel) {
  if (document.fonts?.ready) await document.fonts.ready
  const scale = 2
  const width = 750
  const contentWidth = width - 96
  const font = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif'
  const measure = document.createElement('canvas').getContext('2d')
  measure.font = `26px ${font}`
  const items = record.items || []
  const itemLayouts = items.map((item, index) => {
    const label = `${index + 1}. ${item.category === 'material' ? '物料' : '产品'} · ${item.productName || '—'}  × ${item.quantity}`
    const lines = wrapCanvasText(measure, label, contentWidth - 32)
    return { item, lines, height: Math.max(58, lines.length * 34 + (item.note ? 30 : 12)) }
  })
  const noteLines = wrapCanvasText(measure, record.note || '—', contentWidth - 32)
  const height = 500 + itemLayouts.reduce((sum, row) => sum + row.height, 0) + noteLines.length * 32
  const canvas = document.createElement('canvas')
  canvas.width = width * scale
  canvas.height = height * scale
  const ctx = canvas.getContext('2d')
  ctx.scale(scale, scale)
  ctx.fillStyle = '#fffdfb'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#712f3d'
  ctx.fillRect(0, 0, width, 142)
  ctx.fillStyle = '#ffffff'
  ctx.font = `700 38px ${font}`
  ctx.fillText('BUDU 门店调拨单', 48, 64)
  ctx.font = `20px ${font}`
  ctx.fillText(`单号 ${record.id}`, 48, 104)

  let y = 186
  ctx.fillStyle = '#2f2930'
  ctx.font = `700 28px ${font}`
  ctx.fillText(`${storeLabel(record.fromStoreKey, record.fromStoreName)}  →  ${storeLabel(record.storeKey, record.storeName)}`, 48, y)
  y += 44
  ctx.fillStyle = '#766d72'
  ctx.font = `21px ${font}`
  ctx.fillText(`状态：${transferStatusLabel(record.status)}    申请人：${record.createdBy || '—'}`, 48, y)
  y += 34
  ctx.fillText(`创建：${formatTime(record.createdAt)}`, 48, y)
  y += 34
  ctx.fillText(`发货：${formatTime(record.shippedAt)}    发货人：${record.shippedBy || '—'}`, 48, y)
  y += 48

  ctx.strokeStyle = '#eadfe2'
  ctx.lineWidth = 2
  ctx.strokeRect(48, y, contentWidth, itemLayouts.reduce((sum, row) => sum + row.height, 0) + 52)
  ctx.fillStyle = '#f8f1f3'
  ctx.fillRect(48, y, contentWidth, 52)
  ctx.fillStyle = '#712f3d'
  ctx.font = `700 22px ${font}`
  ctx.fillText(`调拨明细 · ${items.length} 种`, 64, y + 34)
  y += 52
  for (const layout of itemLayouts) {
    ctx.strokeStyle = '#f0e8ea'
    ctx.beginPath(); ctx.moveTo(48, y); ctx.lineTo(width - 48, y); ctx.stroke()
    ctx.fillStyle = '#342f32'
    ctx.font = `600 22px ${font}`
    layout.lines.forEach((line, lineIndex) => ctx.fillText(line, 64, y + 32 + lineIndex * 32))
    if (layout.item.note) {
      ctx.fillStyle = '#8a8085'
      ctx.font = `18px ${font}`
      ctx.fillText(`明细备注：${layout.item.note}`, 64, y + layout.height - 12)
    }
    y += layout.height
  }
  y += 46
  ctx.fillStyle = '#712f3d'
  ctx.font = `700 22px ${font}`
  ctx.fillText('调拨备注', 48, y)
  y += 32
  ctx.fillStyle = '#5d5559'
  ctx.font = `21px ${font}`
  noteLines.forEach((line, index) => ctx.fillText(line, 48, y + index * 32))
  ctx.fillStyle = '#a3999e'
  ctx.font = `17px ${font}`
  ctx.fillText('BUDU Operating System · 门店调拨 2.0', 48, height - 40)

  await downloadFile({ dataUrl: canvas.toDataURL('image/png'), name: `BUDU门店调拨_${record.id}.png`, mimeType: 'image/png' })
}
