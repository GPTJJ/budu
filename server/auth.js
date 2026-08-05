import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'

/** 密码哈希：scrypt（Node 内置，无需原生依赖） */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':')
  if (parts.length !== 2) return false
  const [salt, hash] = parts
  const test = crypto.scryptSync(String(password), salt, 64)
  const expected = Buffer.from(hash, 'hex')
  return test.length === expected.length && crypto.timingSafeEqual(test, expected)
}

export function signToken(user, secret) {
  return jwt.sign({ sub: user.id, name: user.username, role: user.role }, secret, { expiresIn: '30d' })
}

export function verifyToken(token, secret) {
  try {
    return jwt.verify(token, secret)
  } catch {
    return null
  }
}