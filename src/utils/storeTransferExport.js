import * as XLSX from 'xlsx'
import { downloadFile } from './downloadFile.js'
import { transferEstimatedWeightGrams, transferEstimatedWeightLabel, transferQuantityLabel, transferStatusLabel, transferViewStatus } from './storeTransfer.js'

const formatTime = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'

const shanghaiDate = (value) => {
  if (!value) return ''
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value)).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}
const itemType = (item) => item.category === 'material' ? '物料' : '产品'
const itemCategory = (item) => item.category === 'product' ? item.productCategory || '未分类' : '—'

export function buildTransferExportData(records, options = {}) {
  const storeLabel = options.storeLabel || ((key, legacyName = '') => legacyName || key || '—')
  const selectedStores = new Set(Array.isArray(options.storeKeys) ? options.storeKeys : [])
  const filterType = ['product', 'material'].includes(options.itemType) ? options.itemType : 'all'
  const details = []
  const summary = new Map()
  const selectedAllStores = selectedStores.size === 0

  for (const record of Array.isArray(records) ? records : []) {
    if (transferViewStatus(record.status) !== 'shipped' || !record.shippedAt) continue
    const shippedDate = shanghaiDate(record.shippedAt)
    if (options.dateFrom && shippedDate < options.dateFrom) continue
    if (options.dateTo && shippedDate > options.dateTo) continue
    const fromSelected = selectedAllStores || selectedStores.has(record.fromStoreKey)
    const toSelected = selectedAllStores || selectedStores.has(record.storeKey)
    if (!fromSelected && !toSelected) continue

    for (const item of record.items || []) {
      if (filterType !== 'all' && item.category !== filterType) continue
      const type = itemType(item)
      const category = itemCategory(item)
      const code = item.itemCode || '—'
      const name = item.productName || '—'
      const quantity = Number(item.quantity) || 0
      const boxQuantity = Number(item.boxQuantity) || 0
      const pieceQuantity = Number(item.pieceQuantity) || 0
      const estimatedWeightGrams = transferEstimatedWeightGrams(item)
      details.push({
        调拨单号: record.id,
        发货时间: formatTime(record.shippedAt),
        调出门店: storeLabel(record.fromStoreKey, record.fromStoreName),
        调入门店: storeLabel(record.storeKey, record.storeName),
        类型: type,
        产品分类: category,
        编号: code,
        名称: name,
        '历史数量（件）': quantity || '',
        箱数: boxQuantity || '',
        散颗数: pieceQuantity || '',
        '估算重量（约kg）': estimatedWeightGrams > 0 ? Number((estimatedWeightGrams / 1000).toFixed(3)) : '',
        申请人: record.createdBy || '—',
        发货确认人: record.shippedBy || '—',
        备注: record.note || '',
      })
      for (const direction of [
        fromSelected && { key: record.fromStoreKey, name: storeLabel(record.fromStoreKey, record.fromStoreName), sign: -1 },
        toSelected && { key: record.storeKey, name: storeLabel(record.storeKey, record.storeName), sign: 1 },
      ].filter(Boolean)) {
        const key = [direction.key, item.category, category, code, name].join('\u0000')
        const current = summary.get(key) || { 门店: direction.name, 类型: type, 分类: category, 编号: code, 名称: name, 调入数量: 0, 调出数量: 0, 净调拨: 0, 调入箱数: 0, 调出箱数: 0, 净箱数: 0, 调入散颗数: 0, 调出散颗数: 0, 净散颗数: 0, '净估算重量（约kg）': 0, _storeKey: direction.key }
        if (direction.sign > 0) {
          current.调入数量 += quantity
          current.调入箱数 += boxQuantity
          current.调入散颗数 += pieceQuantity
        } else {
          current.调出数量 += quantity
          current.调出箱数 += boxQuantity
          current.调出散颗数 += pieceQuantity
        }
        current.净调拨 = current.调入数量 - current.调出数量
        current.净箱数 = current.调入箱数 - current.调出箱数
        current.净散颗数 = current.调入散颗数 - current.调出散颗数
        current['净估算重量（约kg）'] = Number((current['净估算重量（约kg）'] + direction.sign * estimatedWeightGrams / 1000).toFixed(3))
        summary.set(key, current)
      }
    }
  }

  const summaryRows = [...summary.values()].sort((a, b) => a._storeKey.localeCompare(b._storeKey) || a.类型.localeCompare(b.类型) || a.分类.localeCompare(b.分类, 'zh-CN') || a.编号.localeCompare(b.编号, 'zh-CN') || a.名称.localeCompare(b.名称, 'zh-CN')).map(({ _storeKey, ...row }) => row)
  return { summaryRows, detailRows: details }
}

export function createTransferExportWorkbook(records, options = {}) {
  const { summaryRows, detailRows } = buildTransferExportData(records, options)
  const summarySheet = XLSX.utils.json_to_sheet(summaryRows.length ? summaryRows : [{ 提示: '当前筛选条件下暂无已发货调拨汇总' }])
  const detailSheet = XLSX.utils.json_to_sheet(detailRows.length ? detailRows : [{ 提示: '当前筛选条件下暂无已发货调拨明细' }])
  summarySheet['!cols'] = [{ wch: 18 }, { wch: 9 }, { wch: 16 }, { wch: 18 }, { wch: 28 }, ...Array.from({ length: 10 }, () => ({ wch: 14 }))]
  detailSheet['!cols'] = [{ wch: 25 }, { wch: 20 }, { wch: 18 }, { wch: 18 }, { wch: 9 }, { wch: 16 }, { wch: 18 }, { wch: 28 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 20 }, { wch: 14 }, { wch: 14 }, { wch: 30 }]
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, summarySheet, '调拨汇总')
  XLSX.utils.book_append_sheet(workbook, detailSheet, '调拨明细')
  return { workbook, summaryRows, detailRows }
}

export function exportTransferExcel(records, options = {}) {
  const result = createTransferExportWorkbook(records, options)
  const range = options.dateFrom || options.dateTo ? `_${options.dateFrom || '最早'}_${options.dateTo || '最新'}` : ''
  XLSX.writeFile(result.workbook, `BUDU门店物资调拨汇总${range}.xlsx`)
  return result
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
    const estimate = transferEstimatedWeightLabel(item)
    const label = `${index + 1}. ${item.category === 'material' ? '物料' : '产品'} · ${item.productName || '—'}  ${transferQuantityLabel(item)}${estimate ? ` · ${estimate}` : ''}`
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
