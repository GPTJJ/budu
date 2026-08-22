import { createApp } from './app.js'
import { validateConfig, APP_ENV, APP_VERSION, GIT_SHA } from './config.js'
import { paymentService } from './payments/index.js'
import { startWechatReconciler } from './payments/payment-reconciler.js'
import { wechatPayStatus } from './payments/wechat-config.js'
import * as Sentry from '@sentry/node'

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: APP_ENV,
    release: `${APP_VERSION}${GIT_SHA ? `-${GIT_SHA}` : ''}`,
    tracesSampleRate: 0,
  })
  process.on('uncaughtException', (error) => {
    Sentry.captureException(error)
    console.error('[uncaughtException]', error)
  })
  process.on('unhandledRejection', (reason) => {
    Sentry.captureException(reason)
    console.error('[unhandledRejection]', reason)
  })
}

try {
  validateConfig()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

const PORT = Number(process.env.PORT || 3000)
createApp().listen(PORT, '0.0.0.0', () => {
  console.log(`BUDU server: http://localhost:${PORT}`)
  console.log(`env=${APP_ENV} version=${APP_VERSION} sha=${GIT_SHA || 'local'}`)
  console.log(`局域网访问: http://<本机IP>:${PORT}（可用 ipconfig 查看）`)
  // 微信付款码支付：仅当显式开启且配置完整时启动未决支付后台核对。
  // 启动即扫描，覆盖服务重启后的未决支付恢复。
  const wechat = wechatPayStatus()
  if (wechat.enabled) {
    startWechatReconciler({ service: paymentService })
    console.log('微信付款码支付后台核对已启动')
  } else {
    console.log(`微信付款码支付未启用（configured=${wechat.configured} enabled=${wechat.enabled}）`)
  }
})
