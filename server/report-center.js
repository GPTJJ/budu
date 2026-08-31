import { Router } from 'express'
import { prisma, dbReady } from './pg.js'
import { httpError } from './pos-core.js'
import { ReportQueryService } from './report-center-query.js'

export const reportCenterRouter = Router()
export const reportQueryService = new ReportQueryService(prisma)

const wrap = (handler) => async (req, res) => {
  try {
    await handler(req, res)
  } catch (error) {
    const status = error.status || 500
    if (status >= 500) console.error('[report-center]', error)
    res.status(status).json({ error: status >= 500 ? '报表查询失败，请稍后重试' : (error.message || '报表请求不正确') })
  }
}

function requireDatabase() {
  if (!dbReady()) throw httpError('数据库未配置', 503)
}

reportCenterRouter.get('/report-center/summary', wrap(async (req, res) => {
  requireDatabase()
  res.json(await reportQueryService.summary(req.user, req.query))
}))

reportCenterRouter.get('/report-center/dashboard', wrap(async (req, res) => {
  requireDatabase()
  res.json(await reportQueryService.dashboard(req.user, req.query))
}))

reportCenterRouter.get('/report-center/orders', wrap(async (req, res) => {
  requireDatabase()
  res.json(await reportQueryService.orders(req.user, req.query))
}))

reportCenterRouter.get('/report-center/orders/:id', wrap(async (req, res) => {
  requireDatabase()
  res.json(await reportQueryService.orderDetail(req.user, req.params.id))
}))

reportCenterRouter.get('/report-center/products', wrap(async (req, res) => {
  requireDatabase()
  res.json(await reportQueryService.products(req.user, req.query))
}))
