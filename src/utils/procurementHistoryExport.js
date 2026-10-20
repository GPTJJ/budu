import * as XLSX from 'xlsx';
import JSZip from 'jszip';

export const historyTypeLabels = { ORDER: '采购下单', RECEIPT: '采购收货', RETURN: '退货', REPLACEMENT: '补货' };
export const historyStatusLabels = { DRAFT: '准备中', ORDERED: '待收货', RECEIVING: '收货处理中', CLOSED: '已结束', CANCELLED: '已取消', PENDING: '待核准', APPROVED: '已核准', RETURNED: '已退回修改', PROCESSING: '处理中', COMPLETED: '已完成' };
export const historyHeaders = [
  ['供应商','门店','商品','单位','本期下单','本期实收','本期退回','本期补货'],
  ['下单日期','采购单号','供应商','收货门店','商品','单位','下单数量','记录状态','备单人','备注'],
  ['发生日期','类型','记录单号','关联单号','供应商','门店','商品','单位','本次数量','记录状态','登记人','确认人','备注']
];
export const historyFactNote = '本期下单为有效采购；实收仅含已核准采购收货；退回及补货仅含用户已确认事实。未确认／作废明细不计入汇总；重开期间使用上次确认版本。';
export function historyFilterDescription(data) {
  const f = data.filters, labels = data.filterLabels || {};
  const status = (s, isReturn = false) => isReturn && s === 'PENDING' ? '待确认' : historyStatusLabels[s] || '全部';
  return `供应商：${labels.supplier || f.supplierId || '全部'}；门店：${labels.store || f.storeKey || '授权门店'}；商品：${labels.item || f.itemId || '全部'}；类型：${historyTypeLabels[f.type] || '全部'}；采购状态：${status(f.orderStatus)}；收货状态：${status(f.receiptStatus)}；退货状态：${status(f.returnStatus, true)}；关键词：${f.keyword || '无'}`;
}
const dateCell = d => d ? { t: 'n', v: (Date.parse(d + 'T00:00:00Z') - Date.UTC(1899,11,30)) / 86400000, z: 'yyyy-mm-dd' } : { t: 's', v: '' };
const asCell = value => typeof value === 'number' ? { t: 'n', v: value, z: Number.isInteger(value) ? '#,##0' : '#,##0.###' } : { t: 's', v: String(value ?? '') };
export function createProcurementHistoryWorkbook(data) {
  if (data.complete !== true) throw new Error('完整查询未完成，无法导出');
  const wb = XLSX.utils.book_new();
  const rows = [
    data.summary.map(r => [r.supplierName,r.storeName,r.itemName,r.unit,...['ordered','received','returned','replacement'].map(k => Number(r[k]))]),
    data.purchases.map(r => [dateCell(r.date),r.number,r.supplierName,r.storeName,r.itemName,r.unit,r.quantity === '' ? '' : Number(r.quantity),r.status,r.registeredBy,r.notes]),
    data.events.map(r => [dateCell(r.date),historyTypeLabels[r.type],r.number,r.relatedNumber,r.supplierName,r.storeName,r.itemName,r.unit,Number(r.quantity),r.status,r.registeredBy,r.confirmedBy,r.notes])
  ];
  const names = ['期间汇总','采购明细','收退货明细'];
  const widths = [[24,20,30,10,15,15,15,15],[15,42,24,20,30,10,15,18,18,60],[15,14,42,42,24,20,30,10,15,18,18,18,64]];
  for (let i = 0; i < 3; i++) {
    const values = [[`budu 采购记录 · ${names[i]}`],[`日期范围：${data.filters.start || '不限'} 至 ${data.filters.end || '不限'}（北京时间，含起止日）`],[historyFilterDescription(data)],[historyFactNote],historyHeaders[i],...rows[i]];
    const sheet = XLSX.utils.aoa_to_sheet(values.map(row => row.map(v => typeof v === 'object' && v?.t ? v : asCell(v))));
    sheet['!cols'] = widths[i].map(wch => ({ wch }));
    sheet['!merges'] = [0,1,2,3].map(r => ({ s: { r, c: 0 }, e: { r, c: historyHeaders[i].length - 1 } }));
    const textLines = (value, width) => String(value ?? '').split('\n').reduce((n,line) => n + Math.max(1,Math.ceil([...line].reduce((total,ch) => total + (ch.charCodeAt(0) > 255 ? 2 : 1),0) / Math.max(8,width - 2))),0);
    const totalWidth = widths[i].reduce((n,w) => n + w,0);
    sheet['!rows'] = [{ hpt: 30 },{ hpt: 24 },{ hpt: Math.max(46,textLines(values[2][0],totalWidth)*15+10) },{ hpt: Math.max(40,textLines(historyFactNote,totalWidth)*15+10) },{ hpt: 28 },...rows[i].map(row => ({ hpt: Math.min(409,Math.max(24,...row.map((v,c) => (typeof v === 'object' ? 1 : textLines(v,widths[i][c])) * 15 + 8))) }))];
    sheet['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 4, c: 0 }, e: { r: Math.max(4, values.length - 1), c: historyHeaders[i].length - 1 } }) };
    XLSX.utils.book_append_sheet(wb, sheet, names[i]);
  }
  return wb;
}

// SheetJS CE does not write freeze panes. Apply the standard OOXML view and
// restrained wrapping/header styles through the already installed ZIP library.
export async function procurementHistoryExcelBytes(data) {
  const wb = createProcurementHistoryWorkbook(data);
  const zip = await JSZip.loadAsync(XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }));
  let styles = await zip.file('xl/styles.xml').async('string');
  const fontCount = Number(styles.match(/<fonts count="(\d+)"/)[1]);
  const fillCount = Number(styles.match(/<fills count="(\d+)"/)[1]);
  const xfCount = Number(styles.match(/<cellXfs count="(\d+)"/)[1]);
  styles = styles.replace(/<fonts count="\d+"/, `<fonts count="${fontCount + 2}"`).replace('</fonts>', '<font><sz val="16"/><color rgb="FF263445"/><name val="Microsoft YaHei"/><b/></font><font><sz val="11"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/><b/></font></fonts>');
  styles = styles.replace(/<fills count="\d+"/, `<fills count="${fillCount + 1}"`).replace('</fills>', '<fill><patternFill patternType="solid"><fgColor rgb="FFB94F73"/><bgColor indexed="64"/></patternFill></fill></fills>');
  const xf = (fontId, fillId) => `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>`;
  styles = styles.replace(/<cellXfs count="\d+"/, `<cellXfs count="${xfCount + 3}"`).replace('</cellXfs>', xf(fontCount,0) + xf(fontCount + 1,fillCount) + xf(0,0) + '</cellXfs>');
  zip.file('xl/styles.xml', styles);
  for (let i = 1; i <= 3; i++) {
    const file = `xl/worksheets/sheet${i}.xml`;
    let xml = await zip.file(file).async('string');
    const xSplit = i === 1 ? 4 : i === 2 ? 2 : 3;
    const topLeft = XLSX.utils.encode_cell({ r: 5, c: xSplit });
    const views = `<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane xSplit="${xSplit}" ySplit="5" topLeftCell="${topLeft}" activePane="bottomRight" state="frozen"/><selection pane="bottomRight" activeCell="${topLeft}" sqref="${topLeft}"/></sheetView></sheetViews>`;
    xml = /<sheetViews>/.test(xml) ? xml.replace(/<sheetViews>[\s\S]*?<\/sheetViews>/, views) : xml.replace(/(<dimension[^>]*\/>)/, '$1' + views);
    xml = xml.replace(/<c\b([^>]*)>/g, (tag, attrs) => {
      const row = Number(attrs.match(/\br="[A-Z]+(\d+)"/)?.[1]);
      if (row === 1 || row === 5 || row <= 4 || /\bt="s"|\bt="str"/.test(attrs)) return `<c${attrs.replace(/\s+s="\d+"/,'')} s="${row === 1 ? xfCount : row === 5 ? xfCount + 1 : xfCount + 2}">`;
      return tag;
    });
    zip.file(file, xml);
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
export async function exportProcurementHistory(data) {
  const bytes = await procurementHistoryExcelBytes(data);
  const { downloadFile } = await import('./downloadFile.js');
  const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  try { return await downloadFile({ dataUrl: url, mimeType, name: `budu-采购记录-${data.filters.start || '全部'}_${data.filters.end || '全部'}.xlsx` }); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
}
