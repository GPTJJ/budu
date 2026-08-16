import { createApp } from './app.js'
import { validateConfig, APP_ENV, APP_VERSION, GIT_SHA } from './config.js'
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
})
