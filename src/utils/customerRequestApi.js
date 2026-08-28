export function customerRequestTokenFromLocation(locationLike = window.location) {
  const params = new URLSearchParams(String(locationLike.hash || '').replace(/^#/, ''))
  return params.get('token') || ''
}

export async function publicCustomerRequestApi(token, path = '', options = {}) {
  const res = await fetch(`/api/public/customer-request${path}`, {
    method: options.method || 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: {
      'X-Customer-Request-Token': token,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const error = new Error(data.error || `请求失败（${res.status}）`)
    error.status = res.status
    throw error
  }
  return data
}
