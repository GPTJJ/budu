import crypto from 'node:crypto';
export const fail = (message, status = 400) => Object.assign(new Error(message), {
  status
});
export const id = prefix => prefix + '-' + crypto.randomUUID();
export const json = value => JSON.parse(JSON.stringify(value));
export const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function quantity(value) {
  if (typeof value !== 'string' || !/^\d{1,6}(\.\d{1,3})?$/.test(value)) throw fail('数量应为大于0且不超过999999.999的数字，最多3位小数');
  const [whole, fraction = ''] = value.split('.');
  const fixed = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
  if (fixed <= 0n || fixed > 999999999n) throw fail('数量应大于0且不超过999999.999');
  return whole.replace(/^0+(?=\d)/, '') + (fraction ? '.' + fraction : '');
}
export function unit(value) {
  const s = String(value || '').trim();
  if (!s || s.length > 20) throw fail('请填写单位（最多20字）');
  return s;
}
export function date(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw fail('请填写实际收货日期');
  const d = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(+d) || d.toISOString().slice(0, 10) !== value) throw fail('收货日期不正确');
  return d;
}
export function reason(value) {
  const s = String(value || '').trim();
  if (!s || s.length > 500) throw fail('请填写原因（最多500字）');
  return s;
}
export function key(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9:_-]{8,160}$/.test(value)) throw fail('请求标识不正确，请刷新后重试');
  return value;
}
export function version(actual, input) {
  if (!Number.isInteger(input) || input !== actual) throw fail('记录已变化，请刷新后重试', 409);
}
export function open(order) {
  if (!['ORDERED', 'RECEIVING'].includes(order.status)) throw fail(order.status === 'CLOSED' ? '请先说明原因重新打开收货' : '此单不能登记或处理收货', 409);
}
export function unique(rows, field) {
  if (new Set(rows.map(x => x[field])).size !== rows.length) throw fail('同一商品只能填写一次');
}
export function sum(values) {
  let n = 0n;
  for (const value of values) {
    const [a, b = ''] = String(value).split('.');
    n += BigInt(a) * 1000n + BigInt(b.padEnd(3, '0'));
  }
  const a = n / 1000n,
    b = (n % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return a.toString() + (b ? '.' + b : '');
}
