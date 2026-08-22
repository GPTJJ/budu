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

function hasRedisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN
  return Boolean(url && token)
}

/** 启动前校验：避免测试误连生产、生产缺库。 */
export function validateConfig() {
  if (APP_ENV === 'test' || APP_ENV === 'prod') {
    required('DATABASE_URL', true)
    required('POSTGRES_USER', APP_ENV === 'prod')
    required('POSTGRES_PASSWORD', APP_ENV === 'prod')
  }
  if (APP_ENV === 'prod') {
    const dataStore = String(process.env.DATA_STORE || '').trim().toLowerCase()
    if (dataStore && !['file', 'redis'].includes(dataStore)) {
      throw new Error('[config] DATA_STORE 仅支持 file/redis')
    }
    if (dataStore === 'file') {
      required('DATA_DIR', true)
    } else if (!hasRedisConfig()) {
      throw new Error('[config] 环境 prod 必须配置 Redis/KV，或显式设置 DATA_STORE=file 与 DATA_DIR')
    }
  }
}
