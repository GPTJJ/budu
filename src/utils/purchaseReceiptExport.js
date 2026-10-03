import { downloadFile } from './downloadFile.js';
export function purchaseImageRows(data) {
  return [data.supplier, data.store, ...data.items.map(x => [x.name, x.quantity + ' ' + x.unit])];
}
function wrap(ctx, value, width) {
  const rows = [];
  let line = '';
  for (const ch of String(value)) {
    if (line && ctx.measureText(line + ch).width > width) {
      rows.push(line);
      line = ch;
    } else line += ch;
  }
  if (line) rows.push(line);
  return rows;
}
export async function renderPurchaseImage(data) {
  if (document.fonts?.ready) await document.fonts.ready;
  const width = 750,
    pad = 40,
    font = '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = '28px ' + font;
  const header = [...wrap(measure, data.supplier, width - pad * 2), ...wrap(measure, data.store, width - pad * 2)];
  const rows = data.items.map(x => ({
    names: wrap(measure, x.name, 390),
    quantities: wrap(measure, x.quantity + ' ' + x.unit, 230)
  }));
  const height = pad * 2 + header.length * 42 + 24 + rows.reduce((n, x) => n + Math.max(x.names.length, x.quantities.length) * 40 + 28, 0);
  const canvas = document.createElement('canvas');
  const scale = Math.min(2, Math.sqrt(8000000 / (width * height)));
  canvas.width = Math.floor(width * scale);
  canvas.height = Math.floor(height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.font = '28px ' + font;
  ctx.fillStyle = '#334155';
  let y = pad + 30;
  for (const text of header) {
    ctx.fillText(text, pad, y);
    y += 42;
  }
  y += 24;
  for (const row of rows) {
    for (let i = 0; i < row.names.length; i++) ctx.fillText(row.names[i], pad, y + i * 40);
    for (let i = 0; i < row.quantities.length; i++) ctx.fillText(row.quantities[i], width - pad - 230, y + i * 40);
    y += Math.max(row.names.length, row.quantities.length) * 40 + 28;
  }
  return canvas.toDataURL('image/png');
}
export async function exportPurchaseImage(data, name) {
  const dataUrl = await renderPurchaseImage(data);
  const result = await downloadFile({
    dataUrl,
    name,
    mimeType: 'image/png'
  });
  return {
    dataUrl,
    ...result
  };
}
