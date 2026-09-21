#!/usr/bin/env node
import { claimPayrollConnectedDelivery, completePayrollConnectedDelivery, preparePayrollConnectedDelivery } from '../server/payroll-audit-delivery-bridge.js'

const options = {}
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index]
  if (key.startsWith('--')) options[key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = process.argv[++index]
}
const common = { jobKey: options.jobKey, deliveryId: options.deliveryId, actorId: options.actorId || 'automation:local-mac' }
let result
if (options.action === 'prepare') result = await preparePayrollConnectedDelivery({ ...common, mode: options.mode, recipients: String(options.recipients || '').split(','), expectedModel: options.expectedModel, expectedReasoning: options.expectedReasoning })
else if (options.action === 'claim') result = await claimPayrollConnectedDelivery(common)
else if (options.action === 'complete') result = await completePayrollConnectedDelivery({ ...common, status: options.status, messageId: options.messageId, safeErrorCode: options.safeErrorCode })
else throw Object.assign(new Error('Expected --action prepare, claim or complete'), { code: 'PAYROLL_DELIVERY_ACTION_INVALID' })
process.stdout.write(`${JSON.stringify(result)}\n`)
