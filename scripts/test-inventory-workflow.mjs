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
  // The legacy /userdata compatibility store normalizes "shipped" to its
  // historical "in_transit" value. Canonical v2 transfer records stay shipped.
  if (data.inventory?.length !== 2 || data.inventoryRequests?.[0]?.status !== 'in_transit') {
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

  const createMaster = async (body) => {
    const response = await fetch(`${base}/v2/transfer-master-items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`产品物料主数据创建失败：${response.status} ${await response.text()}`)
    return (await response.json()).item
  }
  const categoryResponse = await fetch(`${base}/v2/product-categories`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: '糖果', sortOrder: 1, isActive: true }),
  })
  if (!categoryResponse.ok) throw new Error(`产品分类创建失败：${categoryResponse.status} ${await categoryResponse.text()}`)
  let productCategory = (await categoryResponse.json()).category
  const productOne = await createMaster({ category: 'product', code: 'NO.1', name: 'NO.1树莓', productCategoryId: productCategory.id, sortOrder: 1, enabled: true })
  const productTwo = await createMaster({ category: 'product', code: 'NO.2', name: 'NO.2柠檬', sortOrder: 2, enabled: true })
  await createMaster({ category: 'material', name: '冰袋', sortOrder: 1, enabled: true })
  const bulkCategory = await fetch(`${base}/v2/transfer-master-items/bulk-category`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ ids: [productTwo.id], productCategoryId: productCategory.id }),
  })
  if (!bulkCategory.ok || (await bulkCategory.json()).updated !== 1) throw new Error('产品批量归类失败')
  const renameCategory = await fetch(`${base}/v2/product-categories/${productCategory.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ ...productCategory, name: '糖果新版' }),
  })
  if (!renameCategory.ok) throw new Error(`产品分类编辑失败：${renameCategory.status} ${await renameCategory.text()}`)
  productCategory = (await renameCategory.json()).category
  const activeMaster = await fetch(`${base}/v2/transfer-master-items?active=true`, { headers: { Cookie: cookie } }).then((response) => response.json())
  if (activeMaster.rows?.length !== 3 || activeMaster.rows.some((item) => !item.enabled) || activeMaster.rows.filter((item) => item.category === 'product').some((item) => item.productCategory?.name !== '糖果新版')) throw new Error('调拨启用主数据或分类读取错误')

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
  if (persisted.items.find((item) => item.itemId === productOne.id)?.productCategory !== '糖果新版') throw new Error('新调拨未冻结产品分类快照')

  const disableCategory = await fetch(`${base}/v2/product-categories/${productCategory.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ ...productCategory, name: '糖果最终', isActive: false }),
  })
  if (!disableCategory.ok) throw new Error(`产品分类停用失败：${disableCategory.status} ${await disableCategory.text()}`)

  const disableResponse = await fetch(`${base}/v2/transfer-master-items/${productOne.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ ...productOne, name: 'NO.1树莓（新版）', enabled: false }),
  })
  if (!disableResponse.ok) throw new Error(`产品编辑停用失败：${disableResponse.status} ${await disableResponse.text()}`)
  const activeAfterDisable = await fetch(`${base}/v2/transfer-master-items?active=true`, { headers: { Cookie: cookie } }).then((response) => response.json())
  if (activeAfterDisable.rows.some((item) => item.id === productOne.id)) throw new Error('停用产品仍出现在新建调拨主数据')
  const historicalAfterRename = await fetch(`${base}/v2/transfer-requests`, { headers: { Cookie: cookie } }).then((response) => response.json())
  const frozen = historicalAfterRename.rows.find((row) => row.id === created.id)?.items.find((item) => item.itemId === productOne.id)
  if (frozen?.productName !== 'NO.1树莓') throw new Error('编辑主数据改写了历史调拨名称')
  if (frozen?.productCategory !== '糖果新版') throw new Error('编辑或停用分类改写了历史调拨分类')
  const disabledCreate = await fetch(`${base}/v2/transfer-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ fromStoreKey: 'guanshe', toStoreKey: 'tongying', items: [{ name: 'NO.1树莓（新版）', quantity: 1, category: 'product' }] }),
  })
  if (disabledCreate.status !== 409 || !(await disabledCreate.text()).includes('货品已停用或不存在')) throw new Error('服务端允许停用产品创建新调拨')

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
