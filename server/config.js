import { CHANGELOG } from './changelog.js'

/** 环境：dev / test / prod；未设置默认 dev（本地开发） */
export const APP_ENV = String(process.env.APP_ENV || 'dev').trim().toLowerCase()

export const GIT_SHA = String(
  process.env.GIT_SHA || process.env.GIT_COMMIT_SHA || process.env.GITHUB_SHA || '',
).slice(0, 12)

export const APP_VERSION = (CHANGELOG[0] && CHANGELOG[0].version) || 'V1.0'

function required(name, onlyWhen) {
  if (onlyWhen && !process.env[name]) {
    throw new Error(`[config] 环境 ${APP_ENV} 缺少必填变量：${name}`)
  }
}

/** 启动前校验：避免测试误连生产、生产缺库。 */
export function validateConfig() {
  if (APP_ENV === 'test' || APP_ENV === 'prod') {
    required('DATABASE_URL', true)
    required('POSTGRES_USER', APP_ENV === 'prod')
    required('POSTGRES_PASSWORD', APP_ENV === 'prod')
  }
  if (APP_ENV === 'prod') {
    required('KV_REST_API_URL', true)
    required('KV_REST_API_TOKEN', true)
  }
}
