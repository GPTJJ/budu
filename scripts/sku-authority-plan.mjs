import fs from 'node:fs/promises'
import { buildProductSkuPlan } from '../server/product-sku-plan.js'

const args = process.argv.slice(2)
const value = (name) => {
  const i = args.indexOf(name)
  return i < 0 ? '' : args[i + 1] || ''
}
const input = value('--input')
const output = value('--output')
if (!input || !output) throw new Error('用法：--input 权威商品快照.json --output 映射.json --snapshot-id ID --actor ID --reason 原因 [--expected-count 178]')
const snapshot = JSON.parse(await fs.readFile(input, 'utf8'))
const rows = Array.isArray(snapshot) ? snapshot : snapshot.products
const plan = buildProductSkuPlan(rows, {
  snapshotId: value('--snapshot-id'), actorUserId: value('--actor'), reason: value('--reason'),
  expectedCount: value('--expected-count') ? Number(value('--expected-count')) : undefined,
})
await fs.writeFile(output, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
process.stdout.write(`${JSON.stringify({ counts: plan.counts, sha256: plan.sha256 })}\n`)
