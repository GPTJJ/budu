import express, { Router } from 'express'
import { paymentService } from './payments/index.js'

const PROVIDER_ALIASES = {
  mock: 'mock',
  cash: 'cash',
  wechat: 'wechat_pay',
  wechat_pay: 'wechat_pay',
  alipay: 'alipay',
}

const handle = async (service, req, res, rawProvider) => {
  try {
    const provider = PROVIDER_ALIASES[String(rawProvider || '').toLowerCase()] || ''
    if (!provider) return res.status(404).json({ error: '接口不存在' })
    // L：MICROPAY 阶段依赖同步响应 + 主动查询/撤销，不依赖异步回调。
    // 微信支付公开回调在本阶段显式关闭（fail closed），绝不参与订单完成判定。
    if (provider === 'wechat_pay') {
      return res.status(404).json({ error: '微信支付回调未启用（当前为 MICROPAY 查询/撤销阶段）' })
    }
    if (provider === 'mock' && process.env.ENABLE_MOCK_CALLBACK_API !== '1' && process.env.NODE_ENV !== 'test') {
      return res.status(404).json({ error: '接口不存在' })
    }
    const result = await service.handleCallback(provider, req.body || {})
    if (provider === 'alipay') return res.type('text/plain').send('success')
    res.json({ ok: true, paymentId: result.payment.id, status: result.payment.status })
  } catch (error) {
    const status = error.status || 500
    if (status >= 500) console.error('[payment-callback]', error)
    if (String(rawProvider || '').toLowerCase() === 'alipay') return res.status(status).type('text/plain').send('failure')
    res.status(status).json({ error: error.message || '支付回调处理失败' })
  }
}

export function createPaymentCallbackRouter(service = paymentService) {
  const router = Router()
  router.post('/callback/:provider', (req, res) => handle(service, req, res, req.params.provider))
  router.post('/wechat/callback', (req, res) => handle(service, req, res, 'wechat'))
  router.post('/alipay/callback', express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 80 }), (req, res) => handle(service, req, res, 'alipay'))
  router.post('/mock/callback', (req, res) => handle(service, req, res, 'mock'))
  return router
}

export const paymentCallbackRouter = createPaymentCallbackRouter()
