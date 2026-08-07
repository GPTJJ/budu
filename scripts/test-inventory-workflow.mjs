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
if (requests[0].status !== 'in_transit') throw new Error('发货后状态错误')
if (inventoryQuantity(inventory, 'tongying', '榛子生巧') !== 15) throw new Error('调出库存扣减错误')
if (inventoryQuantity(inventory, 'guanshe', '榛子生巧') !== 2) throw new Error('收货前不应增加调入库存')

result = transitionInventoryRequest({ requests, inventory, id: 'transfer-1', action: 'receive', actor })
requests = result.requests
inventory = result.inventory
if (requests[0].status !== 'completed') throw new Error('收货后状态错误')
if (inventoryQuantity(inventory, 'guanshe', '榛子生巧') !== 7) throw new Error('调入库存增加错误')

const insufficient = { ...requests[0], id: 'transfer-2', status: 'pending', items: [{ productName: '榛子生巧', quantity: 999 }], history: [] }
let blocked = false
try {
  transitionInventoryRequest({ requests: [insufficient], inventory, id: 'transfer-2', action: 'ship', actor })
} catch (error) {
  blocked = error.message.includes('库存不足')
}
if (!blocked) throw new Error('库存不足时未禁止发货')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-inventory-'))
process.env.DATA_DIR = dataDir
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
  if (data.inventory?.length !== 2 || data.inventoryRequests?.[0]?.status !== 'completed') {
    throw new Error('库存 API 读取结果错误')
  }
} finally {
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(dataDir, { recursive: true, force: true })
}

console.log('INVENTORY WORKFLOW TEST OK')
