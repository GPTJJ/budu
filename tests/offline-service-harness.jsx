import React from 'react'
import { createRoot } from 'react-dom/client'
import InvoicePage from '../src/components/InvoicePage'
import StoreMailingPage from '../src/components/StoreMailingPage'
import CustomerServiceQr from '../src/components/CustomerServiceQr'
import { OverlayStackManager } from '../src/components/overlay/OverlayPrimitives'
import { seedCachedDataForTest } from '../src/utils/userData'
import '../src/index.css'

const params = new URLSearchParams(location.search)
seedCachedDataForTest({ stores: [{ key: 'xidan', name: '北京西单店', active: true }], storesAuthority: 'postgresql' })
const invoice = params.get('page') === 'invoice'
const flash = params.has('flash')
const user = { id: 'synthetic-developer', username: 'synthetic-developer', role: params.has('staff') ? 'staff' : 'developer', storeKeys: ['xidan'] }
const record = invoice ? {
  id: 'inv-synthetic', serviceRequestId: 'csr-synthetic-invoice', customerBound: true, storeKey: 'xidan', titleType: 'company',
  companyName: '用于页面验证的合成测试企业有限公司', taxNo: 'TEST00000000000000', amountCents: '12900', category: '食品',
  email: 'long.synthetic.invoice.address@example.test', status: params.has('done') ? 'done' : 'pending', createdAt: '2026-10-24T02:00:00.000Z', createdBy: '合成员工',
} : {
  id: 'mlr-synthetic', serviceRequestId: 'csr-synthetic-mailing', customerBound: true, storeKey: 'xidan', recipient: '合成测试顾客', phone: '13800000000',
  address: '北京市示例区用于验证长地址换行的合成街道 108 号测试大厦 20 层 2001 室', remark: '合成资料，不用于真实寄件',
  method: flash ? '同城闪送' : '顺丰邮寄', postage: '包邮', shippingTier: 'STANDARD', shippingPaymentMode: 'FREE',
  status: 'pending', createdAt: '2026-10-24T02:00:00.000Z',
}
const service = { id: record.serviceRequestId, type: invoice ? 'INVOICE' : 'MAILING', customerBound: true, notifications: [] }
if (params.has('legacy')) { record.customerBound = false; record.serviceRequestId = null }
const actions = []
const qrBodies = []
let qrCount = 0
window.__offlineServiceTest = { record, service, actions, qrBodies }
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
window.fetch = async (url, options = {}) => {
  const parsed = new URL(url, location.origin), path = parsed.pathname
  if (path === '/api/v2/invoices') return json({ rows: parsed.searchParams.get('status') === record.status ? [record] : [] })
  if (path === '/api/v2/mailing-records') return json({ rows: [record] })
  if (path === '/api/v2/customer-requests' && options.method === 'POST') {
    qrBodies.push(JSON.parse(options.body)); qrCount++
    return json({ ok: true, request: { id: `csr-generated-${qrCount}`, expiresAt: '2026-10-24T12:00:00Z' }, publicUrl: `https://example.test/customer-request#token=${'a'.repeat(43)}` })
  }
  if (path.endsWith('/regenerate')) { qrCount++; return json({ ok: true, request: { id: `csr-generated-${qrCount}`, expiresAt: '2026-10-24T12:00:00Z' }, publicUrl: `https://example.test/customer-request#token=${'b'.repeat(43)}` }) }
  if (path.endsWith('/cancel')) return json({ ok: true })
  if (/\/mailing-records\/[^/]+\/ship$/.test(path)) { actions.push({ action: 'legacy-ship' }); record.status = 'shipped'; record.shippedAt = '2026-10-24T10:00:00Z'; return json({ ok: true }) }
  if (path.endsWith('/service-capabilities')) return json({ ok: true, enabled: true, qrEnabled: !params.has('qr-off') })
  if (path.endsWith('/mini-code')) return params.has('qr-error') ? json({ error: 'Synthetic provider unavailable' }, 503) : json({ ok: true, envVersion: 'trial', imageDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGZkAAAAASUVORK5CYII=' })
  if (path.endsWith('/service')) return json({ ok: true, request: service })
  if (path.endsWith('/conversion')) return json({ ok: true, data: {
    scannedCustomers: 17, submittedCustomers: 12, mallVisitors: 8, anonymousVisits: 0,
    asOf: '2026-10-24T10:00:00Z', coverageNote: '合成测试样例；旧渠道历史不完整，不推定首次线上购买。',
    windows: [7, 30].map((days) => ({ days, customers: days === 7 ? 2 : 3, orders: days === 7 ? 3 : 5, paidCents: days === 7 ? '38700' : '64500', refundCents: '12900', immatureApplications: 4, firstPurchaseCustomers: 0, returningCustomers: 1, unknownHistoryCustomers: days === 7 ? 1 : 2 })),
  } })
  if (/\/(confirm-receipt|confirm-shipment|correct-shipment)$/.test(path)) {
    const action = path.split('/').at(-1), body = JSON.parse(options.body || '{}')
    actions.push({ action, body })
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (action === 'confirm-receipt') { service.receiptConfirmedAt = '2026-10-24T10:00:00Z'; service.receiptConfirmedBy = user.username }
    else { service.shipmentConfirmedAt = '2026-10-24T10:00:00Z'; Object.assign(service, body); record.status = 'shipped' }
    if (action !== 'correct-shipment') service.notifications = [{ id: 'synthetic-task', status: params.has('unknown') ? 'UNKNOWN' : 'PENDING' }]
    if (params.has('lost-response')) throw Error('Synthetic response lost after commit')
    return json({ ok: true })
  }
  if (/\/invoices\/[^/]+\/status$/.test(path)) { record.status = JSON.parse(options.body).status; return json({ ok: true }) }
  return json({ error: 'Synthetic endpoint not provided' }, 404)
}
const request = { request: { id: 'csr-synthetic', expiresAt: '2026-10-24T12:00:00Z' }, publicUrl: `https://example.test/customer-request#token=${'a'.repeat(43)}` }
createRoot(document.getElementById('root')).render(<>
  <OverlayStackManager />
  <main style={{ maxWidth: 1120, margin: '0 auto', padding: 12, paddingBottom: 100 }}>
    <p style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>合成测试资料 · 未连接真实顾客或微信发送接口</p>
    {params.get('page') === 'qr' ? <CustomerServiceQr request={request} /> : invoice ? <InvoicePage currentUser={user} onBack={() => {}} /> : <StoreMailingPage currentUser={user} onBack={() => {}} />}
  </main>
</>)
