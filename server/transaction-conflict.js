// P2010 metadata verified with Prisma 6.19.3 on native PostgreSQL 16.14.
// No message matching: unrelated raw-query errors must retain their error path.
export function isRetryableTransactionConflict(error, { allowDirectDeadlock = false } = {}) {
  if (!error || typeof error !== 'object') return false
  if (error.code === 'P2034' || error.code === '40001') return true
  if (allowDirectDeadlock && error.code === '40P01') return true
  return error.code === 'P2010'
    && error.meta !== null
    && typeof error.meta === 'object'
    && !Array.isArray(error.meta)
    && Object.hasOwn(error.meta, 'code')
    && error.meta.code === '40001'
}
