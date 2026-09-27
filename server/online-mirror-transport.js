import { createOnlineMirrorSigner } from './online-mirror-signature.js'

const failure = () => Error('ONLINE_MIRROR_DELIVERY_FAILED')
export function createOnlineMirrorTransport(configuration, { fetchImpl = fetch, deadlineMs = 9000 } = {}) {
  const sign = createOnlineMirrorSigner(configuration)
  let endpoint
  try { endpoint = new URL(configuration.endpoint) } catch { throw Error('ONLINE_MIRROR_ENDPOINT_INVALID') }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port || endpoint.search || endpoint.hash
    || endpoint.pathname !== '/online-financial-mirror' || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(endpoint.hostname)
    || /(^|\.)(localhost|example\.(com|org|net)|invalid)$/i.test(endpoint.hostname)) throw Error('ONLINE_MIRROR_ENDPOINT_INVALID')
  if (typeof fetchImpl !== 'function' || !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 9000) throw Error('ONLINE_MIRROR_TRANSPORT_INVALID')
  return async (event, { signal } = {}) => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (signal?.aborted) throw failure()
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, deadlineMs)
    let reader
    try {
      const { rawBody, authorization } = sign(event)
      const headers = { 'content-type': 'application/json; charset=utf-8', 'accept': 'application/json', 'accept-encoding': 'identity',
        ...Object.fromEntries(Object.entries(authorization).map(([k,v]) => [`x-budu-mirror-${k.toLowerCase()}`,v])) }
      const reply = await fetchImpl(endpoint.toString(), { method: 'POST', headers, body: rawBody, signal: controller.signal, redirect: 'manual' })
      if (reply.status !== 200 || (reply.headers.get('content-encoding') && reply.headers.get('content-encoding') !== 'identity')
        || !/^application\/json(?:\s*;.*)?$/i.test(reply.headers.get('content-type') || '')) throw failure()
      const length = reply.headers.get('content-length')
      if (length != null && (!/^\d+$/.test(length) || Number(length) > 16384)) throw failure()
      if (!reply.body) throw failure()
      reader = reply.body.getReader()
      const chunks = []; let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 16384) throw failure()
        chunks.push(Buffer.from(value))
      }
      if (controller.signal.aborted) throw failure()
      const ack = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!ack || ack.eventKey !== event.eventKey || ack.version !== event.version
        || !['APPLIED','ALREADY_APPLIED','SUPERSEDED'].includes(ack.status)) throw failure()
      return { eventKey: ack.eventKey, version: ack.version, status: ack.status }
    } catch { throw failure() }
    finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
      controller.abort()
      if (reader) { try { await reader.cancel() } catch {} }
    }
  }
}
