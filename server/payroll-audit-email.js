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

function credentials(filePath = credentialPath()) {
  if (!fs.existsSync(filePath)) throw Object.assign(new Error('Payroll audit Gmail credential file is not configured'), { code: 'PAYROLL_AUDIT_EMAIL_NOT_CONFIGURED' })
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  for (const key of ['clientId', 'clientSecret', 'refreshToken', 'from']) {
    if (!String(value[key] || '').trim()) throw Object.assign(new Error(`Payroll audit Gmail credential is missing ${key}`), { code: 'PAYROLL_AUDIT_EMAIL_CONFIG_INVALID' })
  }
  return value
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
  const tokenResponse = await request('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: cfg.refreshToken, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(20000),
  })
  if (!tokenResponse.ok) throw Object.assign(new Error('Gmail OAuth refresh failed'), { code: 'PAYROLL_AUDIT_EMAIL_AUTH_FAILED' })
  const token = await tokenResponse.json()
  if (!token.access_token) throw Object.assign(new Error('Gmail OAuth response missing access token'), { code: 'PAYROLL_AUDIT_EMAIL_AUTH_FAILED' })
  const sendResponse = await request('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: base64url(mimeMessage(payload, cfg.from)) }), signal: AbortSignal.timeout(30000),
  })
  if (!sendResponse.ok) throw Object.assign(new Error('Gmail delivery failed'), { code: 'PAYROLL_AUDIT_EMAIL_SEND_FAILED' })
  const sent = await sendResponse.json()
  return { messageId: String(sent.id || ''), recipients: [...PAYROLL_AUDIT_RECIPIENTS] }
}
