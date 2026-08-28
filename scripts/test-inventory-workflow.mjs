import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  inventoryQuantity,
  setInventoryQuantity,
  transitionInventoryRequest,
} from '../src/utils/inventory.js'

const actor = { username: 'tester' }
let inventory = setInventoryQuantity([], 'tongying', '榛子生巧', 20, actor)
inventory = setInventoryQuantity(inventory, 'guanshe', '榛子生巧', 2, actor)
let requests = [{
  id: 'transfer-1',
  type: 'transfer',
  fromStoreKey: 'tongying',
  storeKey: 'guanshe',
  items: [{ category: 'product', productName: '榛子生巧', quantity: 5 }],
  status: 'pending',
  createdBy: 'tester',
  createdAt: new Date().toISOString(),
  history: [],
}]

let result = transitionInventoryRequest({ requests, inventory, id: 'transfer-1', action: 'ship', actor })
requests = result.requests
inventory = result.inventory
if (requests[0].status !== 'shipped') throw new Error('发货后状态错误')
if (requests[0].shippedBy !== 'tester' || !requests[0].shippedAt) throw new Error('发货留痕缺失')
if (inventoryQuantity(inventory, 'tongying', '榛子生巧') !== 20) throw new Error('调拨发货不得扣减调出库存')
if (inventoryQuantity(inventory, 'guanshe', '榛子生巧') !== 2) throw new Error('调拨发货不得增加调入库存')

const cancelTarget = { ...requests[0], id: 'transfer-2', status: 'pending', shippedBy: '', shippedAt: null, history: [] }
result = transitionInventoryRequest({ requests: [cancelTarget], inventory, id: 'transfer-2', action: 'cancel', actor })
if (result.requests[0].status !== 'canceled' || result.requests[0].withdrawnBy !== 'tester') throw new Error('撤回必须保留状态与操作人')
if (result.inventory !== inventory) throw new Error('调拨撤回不得创建库存副本或修改库存')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-inventory-'))
process.env.DATA_DIR = dataDir
// Data Authority DA-2：账号权威 = PostgreSQL → 测试使用一次性 PG schema（全量迁移）
import { createDisposablePgSchema } from './helpers/test-pg-schema.mjs'
process.env.DATABASE_URL = await createDisposablePgSchema('da_inv')
const { createApp } = await import('../server/app.js')
const server = createApp().listen(0)
try {
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api`
  const register = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: '123456' }),
  })
  const cookie = register.headers.get('set-cookie')?.split(';')[0]
  const save = await fetch(`${base}/userdata`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ inventory, inventoryRequests: requests }),
  })
  if (!save.ok) throw new Error(`库存 API 保存失败：${save.status} ${await save.text()}`)
  const read = await fetch(`${base}/userdata`, { headers: { Cookie: cookie } })
  const data = await read.json()
  if (data.inventory?.length !== 2 || data.inventoryRequests?.[0]?.status !== 'shipped') {
    throw new Error('库存 API 读取结果错误')
  }

  const sameStore = await fetch(`${base}/v2/transfer-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      fromStoreKey: 'guanshe',
      toStoreKey: 'guanshe',
      items: [{ name: 'NO.1树莓', quantity: 2, category: 'product' }],
    }),
  })
  if (sameStore.status !== 400 || (await sameStore.json()).error !== '调出门店不能与调入门店相同') throw new Error('同店调拨未按合同拒绝')

  const createdResponse = await fetch(`${base}/v2/transfer-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      fromStoreKey: 'guanshe',
      toStoreKey: 'tongying',
      items: [
        { name: 'NO.1树莓', quantity: 2, category: 'product' },
        { name: '冰袋', quantity: 3, category: 'material' },
      ],
      note: '2.0 正式调拨',
    }),
  })
  if (!createdResponse.ok) throw new Error(`调拨创建失败：${createdResponse.status} ${await createdResponse.text()}`)
  const created = (await createdResponse.json()).request
  if (created.status !== 'pending' || created.items.length !== 2 || created.items.some((item) => !item.itemCode)) throw new Error('调拨正式记录字段缺失')

  const transferRead = await fetch(`${base}/v2/transfer-requests`, { headers: { Cookie: cookie } })
  const transferData = await transferRead.json()
  const persisted = transferData.rows?.find((row) => row.id === created.id)
  if (!persisted || persisted.fromStoreKey !== 'guanshe' || persisted.storeKey !== 'tongying') throw new Error('调拨未从 PostgreSQL 永久读取')

  const editedShip = await fetch(`${base}/v2/transfer-requests/${created.id}/ship`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ items: [{ name: 'NO.1树莓', quantity: 999 }] }),
  })
  if (editedShip.status !== 400 || !(await editedShip.text()).includes('发货不允许修改调拨明细')) throw new Error('发货修改明细未被拒绝')

  const shipResponse = await fetch(`${base}/v2/transfer-requests/${created.id}/ship`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}',
  })
  if (!shipResponse.ok) throw new Error(`确认发货失败：${shipResponse.status} ${await shipResponse.text()}`)
  const shipped = (await shipResponse.json()).request
  if (shipped.status !== 'shipped' || shipped.shippedBy !== 'tester' || !shipped.shippedAt || shipped.items.length !== 2) throw new Error('发货留痕或明细保护失败')

  const shippedDelete = await fetch(`${base}/v2/transfer-requests/${created.id}`, { method: 'DELETE', headers: { Cookie: cookie } })
  if (shippedDelete.status !== 400) throw new Error('已发货调拨不应允许撤回')

  const withdrawCreate = await fetch(`${base}/v2/transfer-requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ fromStoreKey: 'guanshe', toStoreKey: 'tongying', items: [{ name: 'NO.2柠檬', quantity: 1, category: 'product' }] }),
  })
  const withdrawId = (await withdrawCreate.json()).request.id
  const withdrawResponse = await fetch(`${base}/v2/transfer-requests/${withdrawId}`, { method: 'DELETE', headers: { Cookie: cookie } })
  const withdrawn = (await withdrawResponse.json()).request
  if (withdrawn.status !== 'canceled' || withdrawn.withdrawnBy !== 'tester' || !withdrawn.withdrawnAt) throw new Error('撤回没有保留审计事实')
  const afterWithdraw = await fetch(`${base}/v2/transfer-requests`, { headers: { Cookie: cookie } }).then((response) => response.json())
  if (!afterWithdraw.rows.some((row) => row.id === withdrawId && row.status === 'canceled')) throw new Error('撤回记录被物理删除')

  const storesRead = await fetch(`${base}/v2/stores`, { headers: { Cookie: cookie } })
  const storesData = await storesRead.json()
  if ((storesData.rows || []).some((store) => !['guanshe', 'tongying', 'chaowai', 'xidan'].includes(store.key))) throw new Error('正式门店目录出现未知门店')
} finally {
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(dataDir, { recursive: true, force: true })
}

console.log('INVENTORY WORKFLOW TEST OK')
