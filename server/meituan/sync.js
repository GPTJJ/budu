import { prisma } from '../pg.js'
import { meituanConfig, meituanReady } from './config.js'
import { fetchMeituanDay, mockMeituanDay, uid } from './client.js'

let syncing = false

/** 将一天的美团数据写入 DailySales + DishDaily（幂等；不覆盖手工值班人员） */
export async function applyMeituanDay({ storeKey, day, summary }) {
  const date = new Date(`${day}T00:00:00.000Z`)
  await prisma.store.upsert({ where: { key: storeKey }, update: {}, create: { key: storeKey, name: storeKey } })
  await prisma.dailySales.upsert({
    where: { storeKey_date: { storeKey, date } },
    update: {
      incCents: BigInt(summary.incCents),
      ord: summary.ord,
      refundCents: BigInt(summary.refundCents),
      channels: summary.channels,
      source: 'meituan',
      updatedAt: new Date(),
    },
    create: {
      id: uid('ds'),
      storeKey,
      date,
      incCents: BigInt(summary.incCents),
      ord: summary.ord,
      refundCents: BigInt(summary.refundCents),
      channels: summary.channels,
      source: 'meituan',
    },
  })

  const dishMappings = await prisma.dishMapping.findMany()
  const items = await prisma.inventoryItem.findMany({ select: { name: true } })
  const itemNames = new Set(items.map((i) => i.name))
  const mapDish = (name) => {
    const m = dishMappings.find((x) => x.dishName === name)
    if (m) return m.productName
    return itemNames.has(name) ? name : ''
  }

  for (const dish of summary.dishes || []) {
    const name = String(dish.name || dish.dishName || '').trim()
    if (!name) continue
    const sales = Number(dish.sales) || 0
    const rawAmount = Number(dish.amount ?? dish.amountCents ?? 0) || 0
    const amountCents = dish.amount !== undefined ? Math.round(rawAmount * 100) : Math.round(rawAmount)
    await prisma.dishDaily.upsert({
      where: { storeKey_date_dishName: { storeKey, date, dishName: name } },
      update: { productName: mapDish(name), sales, amountCents: BigInt(amountCents) },
      create: {
        id: uid('dd'),
        storeKey,
        date,
        dishName: name,
        productName: mapDish(name),
        sales,
        amountCents: BigInt(amountCents),
      },
    })
  }
}

/** 执行一次同步（真实模式）；未配置凭证时返回模拟预览且不写库 */
export async function runMeituanSync() {
  const cfg = meituanConfig()
  if (!meituanReady(cfg)) {
    return { ok: true, mock: true, message: '模拟模式：未配置美团凭证，未拉取/写入真实数据' }
  }
  if (syncing) return { ok: false, message: '同步进行中，请稍后再试' }
  syncing = true
  const started = Date.now()
  const logs = []
  try {
    const mappings = await prisma.meituanStoreMapping.findMany({ where: { enabled: true } })
    if (mappings.length === 0) return { ok: true, message: '暂无启用的美团门店映射' }

    const today = new Date()
    const todayStr = today.toISOString().slice(0, 10)
    const days = []
    for (let i = cfg.backfillDays - 1; i >= 0; i -= 1) {
      const d = new Date(today)
      d.setDate(d.getDate() - i)
      days.push(d.toISOString().slice(0, 10))
    }

    for (const mapping of mappings) {
      for (const day of days) {
        const date = new Date(`${day}T00:00:00.000Z`)
        if (day !== todayStr) {
          const existing = await prisma.dailySales.findUnique({
            where: { storeKey_date: { storeKey: mapping.storeKey, date } },
          })
          if (existing) continue
        }
        const t0 = Date.now()
        try {
          const summary = await fetchMeituanDay({
            apiBase: cfg.apiBase,
            appId: cfg.appId,
            appSecret: cfg.appSecret,
            orderApi: cfg.orderApi,
            meituanStoreId: mapping.meituanStoreId,
            date: day,
          })
          await applyMeituanDay({ storeKey: mapping.storeKey, day, summary })
          logs.push({
            id: uid('ml'),
            meituanStoreId: mapping.meituanStoreId,
            storeKey: mapping.storeKey,
            day,
            status: 'ok',
            message: `营业 ¥${(summary.incCents / 100).toFixed(2)} / 订单 ${summary.ord}`,
            durationMs: Date.now() - t0,
          })
        } catch (e) {
          logs.push({
            id: uid('ml'),
            meituanStoreId: mapping.meituanStoreId,
            storeKey: mapping.storeKey,
            day,
            status: 'error',
            message: String(e.message || e).slice(0, 300),
            durationMs: Date.now() - t0,
          })
        }
      }
    }

    if (logs.length > 0) await prisma.meituanSyncLog.createMany({ data: logs })
    const recent = await prisma.meituanSyncLog.count()
    if (recent > 500) {
      const old = await prisma.meituanSyncLog.findMany({ orderBy: { createdAt: 'asc' }, take: recent - 500, select: { id: true } })
      await prisma.meituanSyncLog.deleteMany({ where: { id: { in: old.map((x) => x.id) } } })
    }
    return { ok: true, message: `同步完成：成功 ${logs.filter((l) => l.status === 'ok').length} / 失败 ${logs.filter((l) => l.status === 'error').length}`, durationMs: Date.now() - started }
  } finally {
    syncing = false
  }
}

export function isMeituanSyncing() {
  return syncing
}
