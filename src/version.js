import { CHANGELOG } from './data/changelog'

/** 系统当前版本号：自动取 changelog 最新一条，随每次更新记录自动递增 */
export const APP_VERSION = CHANGELOG[0]?.version || 'V1.0'
