import { Router } from 'express'
import { prisma, dbReady } from './pg.js'
import { httpError } from './pos-core.js'
import { ReportQueryService } from './report-center-query.js'
import { OperatingCostAuthority } from './operating-cost-authority.js'
import { hasReportCostView, hasReportLaborView } from '../shared/accountPermissions.js'

export const reportCenterRouter = Router()
export const reportQueryService = new ReportQueryService(prisma)
export const operatingCostAuthority = new OperatingCostAuthority(prisma, reportQueryService)

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
  const canViewProfit = hasReportCostView(req.user) && hasReportLaborView(req.user)
  res.json(await reportQueryService.dashboard(req.user, req.query, canViewProfit ? {
    profitProjector: ({ currentScope, comparisonScope, current, comparison }) => operatingCostAuthority.dashboardProjection(req.user, req.query, {
      scope: currentScope, summary: current, comparisonScope, comparisonSummary: comparison,
    }),
  } : {}))
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

reportCenterRouter.get('/report-center/operating-costs', wrap(async (req, res) => {
  requireDatabase()
  res.json(await operatingCostAuthority.report(req.user, req.query))
}))

reportCenterRouter.get('/report-center/operating-costs/export', wrap(async (req, res) => {
  requireDatabase()
  const result = await operatingCostAuthority.exportWorkbook(req.user, req.query)
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.fileName)}`)
  res.send(result.buffer)
}))

reportCenterRouter.get('/report-center/cost-settings', wrap(async (req, res) => {
  requireDatabase()
  res.json(await operatingCostAuthority.settings(req.user, req.query))
}))

reportCenterRouter.post('/report-center/cost-settings/rent', wrap(async (req, res) => {
  requireDatabase()
  res.status(201).json(await operatingCostAuthority.addRent(req.user, req.body || {}))
}))

reportCenterRouter.put('/report-center/cost-settings/utility', wrap(async (req, res) => {
  requireDatabase()
  res.json(await operatingCostAuthority.setUtility(req.user, req.body || {}))
}))

reportCenterRouter.post('/report-center/cost-settings/labor-period', wrap(async (req, res) => {
  requireDatabase()
  res.status(201).json(await operatingCostAuthority.confirmLaborPeriod(req.user, req.body || {}))
}))
