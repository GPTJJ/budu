/**
 * CLI 包装：CloudBase `orders` → `online_order_archive`。
 *
 * 容器内：node /app/scripts/import-mp-orders.mjs
 * 生产每天 03:10 由 crontab 兜底；管理台打开「历史订单」时会实时同步一次。
 */
import { syncOrderArchive } from '../server/order-archive-sync.js'

const result = await syncOrderArchive()
console.log(JSON.stringify(result, null, 1))
process.exit(0)
