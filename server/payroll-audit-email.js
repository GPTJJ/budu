import fs from 'node:fs'
import path from 'node:path'

export const PAYROLL_AUDIT_RECIPIENTS = Object.freeze([
  'yuegu1995@gmail.com',
  '970701330@qq.com',
  'korea_jing@163.com',
])

const base64url = (value) => Buffer.from(value).toString('base64url')

const credentialPath = () => process.env.PAYROLL_AUDIT_GMAIL_CREDENTIAL_FILE || path.join(process.env.DATA_DIR || path.join(process.cwd(), 'server/data'), 'payroll-audit-gmail.json')
export const payrollAuditEmailConfigured = () => fs.existsSync(credentialPath())

const safeCauseCode = (error) => String(error?.cause?.code || error?.code || '').replace(/[^A-Z0-9_]/gi, '').slice(0, 80)
const retryableStatus = (status) => status === 408 || status === 429 || status >= 500

function transportError(message, { code, stage, phase, httpStatus = null, retryable = false, cause } = {}) {
  const error = new Error(message, cause ? { cause } : undefined)
  Object.assign(error, { code, emailStage: stage, emailProvider: 'GMAIL_API', emailTransport: 'HTTPS', emailPhase: phase, httpStatus, retryable })
  return error
}

export function payrollAuditEmailFailureDiagnostic(error) {
  const httpStatus = Number.isInteger(error?.httpStatus) ? error.httpStatus : null
  return {
    stage: String(error?.emailStage || 'UNKNOWN'),
    provider: String(error?.emailProvider || 'GMAIL_API'),
    transport: String(error?.emailTransport || 'HTTPS'),
    errorClass: String(error?.name || 'Error'),
    safeErrorCode: String(error?.code || 'PAYROLL_AUDIT_EMAIL_FAILED'),
    causeCode: safeCauseCode(error),
    httpStatus,
    phase: String(error?.emailPhase || 'UNKNOWN'),
    retryable: error?.retryable === true,
    timestamp: new Date().toISOString(),
  }
}

function credentials(filePath = credentialPath()) {
  if (!fs.existsSync(filePath)) throw transportError('Payroll audit Gmail credential file is not configured', { code: 'PAYROLL_AUDIT_EMAIL_NOT_CONFIGURED', stage: 'CREDENTIAL_LOAD', phase: 'CONFIG', retryable: false })
  let value
  try { value = JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch (cause) {
    throw transportError('Payroll audit Gmail credential file is invalid', { code: 'PAYROLL_AUDIT_EMAIL_CONFIG_INVALID', stage: 'CREDENTIAL_LOAD', phase: 'CONFIG', retryable: false, cause })
  }
  for (const key of ['clientId', 'clientSecret', 'refreshToken', 'from']) {
    if (!String(value[key] || '').trim()) throw transportError('Payroll audit Gmail credential is incomplete', { code: 'PAYROLL_AUDIT_EMAIL_CONFIG_INVALID', stage: 'CREDENTIAL_LOAD', phase: 'CONFIG', retryable: false })
  }
  return value
}

async function fetchAccessToken(cfg, request) {
  let response
  try {
    response = await request('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: cfg.refreshToken, grant_type: 'refresh_token' }),
      signal: AbortSignal.timeout(20000),
    })
  } catch (cause) {
    throw transportError('Gmail OAuth refresh request failed', { code: 'PAYROLL_AUDIT_EMAIL_AUTH_NETWORK_FAILED', stage: 'OAUTH_TOKEN_REFRESH', phase: 'NETWORK', retryable: true, cause })
  }
  if (!response.ok) throw transportError('Gmail OAuth refresh failed', { code: 'PAYROLL_AUDIT_EMAIL_AUTH_FAILED', stage: 'OAUTH_TOKEN_REFRESH', phase: 'AUTH', httpStatus: response.status, retryable: retryableStatus(response.status) })
  const token = await response.json()
  if (!token.access_token) throw transportError('Gmail OAuth response missing access token', { code: 'PAYROLL_AUDIT_EMAIL_AUTH_FAILED', stage: 'OAUTH_TOKEN_REFRESH', phase: 'AUTH', httpStatus: response.status, retryable: false })
  return token.access_token
}

export async function checkPayrollAuditEmailTransport(options = {}) {
  const cfg = options.credentials || credentials(options.credentialFile)
  const request = options.fetch || fetch
  const accessToken = await fetchAccessToken(cfg, request)
  let response
  try {
    response = await request('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20000),
    })
  } catch (cause) {
    throw transportError('Gmail profile request failed', { code: 'PAYROLL_AUDIT_EMAIL_HEALTH_NETWORK_FAILED', stage: 'GMAIL_PROFILE', phase: 'NETWORK', retryable: true, cause })
  }
  if (!response.ok) throw transportError('Gmail profile validation failed', { code: 'PAYROLL_AUDIT_EMAIL_HEALTH_FAILED', stage: 'GMAIL_PROFILE', phase: 'AUTH', httpStatus: response.status, retryable: retryableStatus(response.status) })
  const profile = await response.json()
  if (profile.emailAddress && String(profile.emailAddress).toLowerCase() !== String(cfg.from).toLowerCase()) {
    throw transportError('Gmail authenticated account does not match configured sender', { code: 'PAYROLL_AUDIT_EMAIL_ACCOUNT_MISMATCH', stage: 'GMAIL_PROFILE', phase: 'AUTH', httpStatus: response.status, retryable: false })
  }
  return { provider: 'GMAIL_API', transport: 'HTTPS', account: String(profile.emailAddress || cfg.from), authenticated: true }
}

function mimeMessage(payload, sender) {
  const boundary = `budu-payroll-${Date.now().toString(36)}`
  const lines = [
    `From: ${sender}`,
    `To: ${PAYROLL_AUDIT_RECIPIENTS.join(', ')}`,
    `Subject: =?UTF-8?B?${Buffer.from(payload.subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '',
    Buffer.from(payload.body).toString('base64'),
  ]
  for (const filePath of payload.attachments || []) {
    const fileName = filePath.split('/').pop()
    lines.push(`--${boundary}`, `Content-Type: application/octet-stream; name="${fileName}"`,
      'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${fileName}"`, '',
      fs.readFileSync(filePath).toString('base64'))
  }
  lines.push(`--${boundary}--`, '')
  return lines.join('\r\n')
}

export async function sendPayrollAuditEmail(payload, options = {}) {
  const cfg = options.credentials || credentials(options.credentialFile)
  const request = options.fetch || fetch
  const accessToken = await fetchAccessToken(cfg, request)
  let sendResponse
  try {
    sendResponse = await request('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: base64url(mimeMessage(payload, cfg.from)) }), signal: AbortSignal.timeout(30000),
    })
  } catch (cause) {
    throw transportError('Gmail delivery request failed', { code: 'PAYROLL_AUDIT_EMAIL_SEND_NETWORK_FAILED', stage: 'GMAIL_SEND', phase: 'NETWORK', retryable: true, cause })
  }
  if (!sendResponse.ok) throw transportError('Gmail delivery failed', { code: 'PAYROLL_AUDIT_EMAIL_SEND_FAILED', stage: 'GMAIL_SEND', phase: 'SEND', httpStatus: sendResponse.status, retryable: retryableStatus(sendResponse.status) })
  const sent = await sendResponse.json()
  return { messageId: String(sent.id || ''), recipients: [...PAYROLL_AUDIT_RECIPIENTS], provider: 'GMAIL_API', transport: 'HTTPS' }
}
