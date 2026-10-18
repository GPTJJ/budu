import { Router } from 'express'
import { prisma } from './pg.js'
import { httpError } from './pos-core.js'
import { CHAOWAI_BUSINESS_CLOSED_ON } from '../shared/storeOperationDates.js'
import { setManagedStoreStatus } from './store-management.js'

export { CHAOWAI_BUSINESS_CLOSED_ON }
const developer = (actor) => {
  if (!actor?.id || actor.role !== 'developer' || actor.status !== 'active') {
    throw httpError('仅在职开发者可办理门店停用', 403)
  }
}

// This explicit authenticated command is never called by startup, migration or
// a seed. It changes one flag and its audit only; historical identities stay put.
export async function disableChaowai(db, { actor, confirmation, reason }) {
  developer(actor)
  if (confirmation !== '停用朝外') throw httpError('请明确确认“停用朝外”', 400)
  const explanation = typeof reason === 'string' ? reason.trim() : ''
  if (!explanation || explanation.length > 500) throw httpError('请填写停用原因（最多500字）', 400)
  return setManagedStoreStatus(db, { actor, key: 'chaowai', active: false, reason: explanation, legacyClosedOn: CHAOWAI_BUSINESS_CLOSED_ON })
}

export const storeClosureRouter = Router()
storeClosureRouter.post('/stores/chaowai/disable', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  try {
    res.json(await disableChaowai(prisma, { actor: req.user, confirmation: req.body?.confirmation, reason: req.body?.reason }))
  } catch (error) {
    res.status(error.status || 503).json({ error: error.status ? error.message : '门店停用未完成，请核实后重试' })
  }
})
