export async function lockSweetCardAccount(tx, accountId) {
  if (!accountId) throw Object.assign(new Error('SWEET_CARD_ACCOUNT_REQUIRED'), { status: 400 })
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${String(accountId)}, 0))`
}
