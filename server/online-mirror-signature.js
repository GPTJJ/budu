import crypto from 'node:crypto'

// OS -> CloudBase financial mirror only; independent of customer auth and the
// existing CloudBase -> OS gateway. Transport must preserve rawBody exactly.
export function createOnlineMirrorSigner({ environment, appId, keyId, privateKey, now = Date.now }) {
  const bounded = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
  if (!bounded(environment) || !/^wx[A-Za-z0-9]{16}$/.test(appId || '') || !bounded(keyId) || typeof now !== 'function') throw Error('ONLINE_MIRROR_CONFIG_INVALID')
  let key
  try { key = crypto.createPrivateKey(privateKey) } catch { throw Error('ONLINE_MIRROR_KEY_INVALID') }
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) throw Error('ONLINE_MIRROR_KEY_INVALID')
  return message => {
    let rawBody
    try {
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw Error()
      rawBody = Buffer.from(JSON.stringify(message))
    } catch { throw Error('ONLINE_MIRROR_MESSAGE_INVALID') }
    if (rawBody.length > 256 * 1024) throw Error('ONLINE_MIRROR_MESSAGE_TOO_LARGE')
    const timestamp = String(now())
    if (!/^\d{13}$/.test(timestamp)) throw Error('ONLINE_MIRROR_CLOCK_INVALID')
    const authorization = { scope: 'budu-online-financial-mirror:v1', principal: 'budu-os-financial-outbox', capability: 'financial-mirror:write',
      environment, appId, keyId, timestamp, nonce: crypto.randomBytes(24).toString('base64url') }
    const a = authorization
    const payload = [a.scope, a.principal, a.capability, environment, appId, keyId, timestamp, a.nonce,
      crypto.createHash('sha256').update(rawBody).digest('hex')].join('\n')
    authorization.signature = crypto.sign('RSA-SHA256', Buffer.from(payload), key).toString('base64')
    return { rawBody, authorization }
  }
}
