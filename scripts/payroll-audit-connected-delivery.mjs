#!/usr/bin/env node
import { readPayrollDeliveryPdf, reviewPayrollConnectedDelivery, claimPayrollConnectedDelivery, completePayrollConnectedDelivery, preparePayrollConnectedDelivery } from '../server/payroll-audit-delivery-bridge.js'
import { deliverPayrollAuditFailureAlert } from '../server/payroll-audit-failure-alert.js'

const options = {}
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index]
  if (key.startsWith('--')) options[key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = process.argv[++index]
}
const common = { jobKey: options.jobKey, deliveryId: options.deliveryId, actorId: options.actorId || 'automation:local-mac' }
let result
if (options.action === 'prepare') result = await preparePayrollConnectedDelivery({ ...common, mode: options.mode, recipients: String(options.recipients || '').split(','), expectedModel: options.expectedModel, expectedReasoning: options.expectedReasoning })
else if (options.action === 'read-pdf') result = readPayrollDeliveryPdf({...common,reportId:options.reportId,canonicalHash:options.canonicalHash,pdfHash:options.pdfHash,periodStart:options.periodStart,periodEnd:options.periodEnd})
else if (options.action === 'review') result = await reviewPayrollConnectedDelivery({...common,reportId:options.reportId,canonicalHash:options.canonicalHash,pdfHash:options.pdfHash,periodStart:options.periodStart,periodEnd:options.periodEnd,recipients:String(options.recipients||'').split(','),reviewerThreadId:options.reviewerThreadId,preparationThreadId:options.preparationThreadId,decision:options.decision,evidence:options.evidence})
else if (options.action === 'claim') result = await claimPayrollConnectedDelivery(common)
else if (options.action === 'complete') result = await completePayrollConnectedDelivery({ ...common, status: options.status, messageId: options.messageId, safeErrorCode: options.safeErrorCode })
else if (options.action === 'alert') result = await deliverPayrollAuditFailureAlert({ reportType: options.reportType, periodStart: options.periodStart, periodEnd: options.periodEnd, reportId: options.reportId, stage: options.stage, safeErrorCode: options.safeErrorCode, formalStatus: options.formalStatus })
else throw Object.assign(new Error('Expected --action prepare, claim, complete or alert'), { code: 'PAYROLL_DELIVERY_ACTION_INVALID' })
if(options.action==='read-pdf') process.stdout.write(result.bytes)
else process.stdout.write(`${JSON.stringify(result)}\n`)
