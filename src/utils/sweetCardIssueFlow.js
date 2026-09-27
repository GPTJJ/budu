const ISSUABLE_VIEW_SCOPES = new Set(['COMMERCIAL', 'ACCEPTANCE_TEST'])

export function retainSweetCardIssueAttempt(currentAttempt, payloadIdentity, createRequestKey = () => crypto.randomUUID()) {
  return currentAttempt || { requestKey: createRequestKey(), payloadIdentity }
}

export function sweetCardSuccessNavigation({ target, businessPurpose, batchId }) {
  if (!ISSUABLE_VIEW_SCOPES.has(businessPurpose)) throw new Error('发卡批次用途无法映射到运营视图')
  if (target !== 'batches' && target !== 'cards') throw new Error('发卡成功页目标无效')
  return { tab: target, viewScope: businessPurpose, batchId: target === 'cards' ? batchId : '' }
}
