import { api } from './api.js'

export async function loginAccount({ username, password }) {
  const options = { method: 'POST', body: JSON.stringify({ username: username.trim(), password }) }
  try {
    return await api('/auth/login', options)
  } catch (error) {
    if (error.status !== 403 || error.data?.code !== 'PARTNER_LOGIN_REQUIRED') throw error
    // Only the dedicated endpoint may validate Partner state and issue its scoped cookie.
    return api('/partner/auth/login', options)
  }
}
