import { Router } from 'express'
import { paymentService } from './payments/index.js'

export const paymentCallbackRouter = Router()

const PROVIDER_ALIASES = {
  mock: 'mock',
  cash: 'cash',
  wechat: 'wechat_pay',
  wechat_pay: 'wechat_pay',
  alipay: 'alipay',
}

const handle = async (req, res, rawProvider) => {
  try {
    const provider = PROVIDER_ALIASES[String(rawProvider || '').toLowerCase()] || ''
    if (!provider) return res.status(404).json({ error: '接口不存在' })
    if (provider === 'mock' && process.env.ENABLE_MOCK_CALLBACK_API !== '1' && process.env.NODE_ENV !== 'test') {
      return res.status(404).json({ error: '接口不存在' })
    }
    const result = await paymentService.handleCallback(provider, req.body || {})
    res.json({ ok: true, paymentId: result.payment.id, status: result.payment.status })
  } catch (error) {
    const status = error.status || 500
    if (status >= 500) console.error('[payment-callback]', error)
    res.status(status).json({ error: error.message || '支付回调处理失败' })
  }
}

paymentCallbackRouter.post('/callback/:provider', (req, res) => handle(req, res, req.params.provider))
paymentCallbackRouter.post('/wechat/callback', (req, res) => handle(req, res, 'wechat'))
paymentCallbackRouter.post('/alipay/callback', (req, res) => handle(req, res, 'alipay'))
paymentCallbackRouter.post('/mock/callback', (req, res) => handle(req, res, 'mock'))
