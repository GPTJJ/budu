import { verifyToken } from './auth.js'
import { resolveInternalPrincipal } from './principals.js'

function denied(message, status) {
  return Object.assign(new Error(message), { status })
}

export async function authenticateInternalToken({ token, secret, getUserById }) {
  const payload = token ? verifyToken(token, secret) : null
  if (!payload?.sub) throw denied('未登录或登录已过期', 401)
  const user = await getUserById(payload.sub)
  if (!user) throw denied('账号不存在', 401)
  const principal = resolveInternalPrincipal(user)
  if (!principal) throw denied('账号已停用，请联系开发者', 403)
  return { user, principal }
}
