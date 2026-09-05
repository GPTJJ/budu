import crypto from 'node:crypto'
import fs from 'node:fs'
import { httpError } from './pos-core.js'

export const SWEET_CARD_NAMESPACE = 'budu:sc:v1:'
export const SWEET_CARD_MAX_CENTS = 10_000_000n

export function sweetCardEnabled() {
  return ['1', 'true', 'on', 'yes'].includes(String(process.env.SWEET_CARD_ENABLED || '').trim().toLowerCase())
}

export function sweetCardCommercialEnabled() {
  return ['1', 'true', 'on', 'yes'].includes(String(process.env.XIDAN_SWEET_CARD_COMMERCIAL || '').trim().toLowerCase())
}

export function assertSweetCardEnabled() {
  if (!sweetCardEnabled()) throw httpError('budu 甜意卡尚未启用', 503)
}

export function isSweetCardToken(value) {
  return String(value || '').startsWith(SWEET_CARD_NAMESPACE)
}

export function parseAmount(value, label = '金额') {
  let amount
  try { amount = BigInt(value) } catch { throw httpError(`${label}不正确`) }
  if (amount <= 0n || amount > SWEET_CARD_MAX_CENTS) throw httpError(`${label}超出安全范围`)
  return amount
}

export function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

function credentialKey() {
  let source = String(process.env.SWEET_CARD_CREDENTIAL_KEY || '').trim()
  const path = String(process.env.SWEET_CARD_CREDENTIAL_KEY_FILE || '').trim()
  if (!source && path) source = fs.readFileSync(path, 'utf8').trim()
  if (!/^[a-f0-9]{64}$/i.test(source)) throw httpError('甜意卡 credential 加密密钥未配置', 503)
  return Buffer.from(source, 'hex')
}

export function encryptToken(token) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', credentialKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
}

export function decryptToken(credential) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', credentialKey(), Buffer.from(credential.tokenIv, 'base64'))
  decipher.setAuthTag(Buffer.from(credential.tokenTag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(credential.tokenCiphertext, 'base64')), decipher.final()]).toString('utf8')
}

export function newCredential() {
  const publicTokenId = crypto.randomBytes(12).toString('base64url')
  const secret = crypto.randomBytes(32).toString('base64url')
  const token = `${SWEET_CARD_NAMESPACE}${publicTokenId}.${secret}`
  return { publicTokenId, token, tokenHash: tokenHash(token), ...encryptToken(token) }
}

export function expiryFor(validityType, from = new Date()) {
  if (validityType === 'LONG_TERM') return null
  const expires = new Date(from)
  expires.setUTCFullYear(expires.getUTCFullYear() + (validityType === 'THREE_YEARS' ? 3 : 1))
  return expires
}

export function allocateCents(total, lines) {
  let left = BigInt(total)
  return [...lines].sort((a, b) => String(a.id).localeCompare(String(b.id))).map((line) => {
    const amount = left > 0n ? (left < BigInt(line.eligibleAmountCents) ? left : BigInt(line.eligibleAmountCents)) : 0n
    left -= amount
    return { ...line, redeemedAmountCents: amount }
  })
}

export const SWEET_CARD_PRESENTATION_CONTRACT = Object.freeze({
  version: 1,
  templateKey: 'minimal-v1',
  slots: ['canonicalLogo', 'title', 'tagline', 'faceValue', 'expiryCopy', 'qr', 'publicCardNo', 'recipient', 'message'],
})
