/**
 * 一次性数据修正：通盈店 2026-11-17 大单奖按当天值班两人平分。
 *
 * 事实：
 *   - 门店：tongying（北京通盈中心店）
 *   - 订单：11-17 17:42 结账，¥1794，支付宝；大单奖 5% = ¥89.70
 *   - 当天在岗：叶芷辰（emp-6ec93d71…）、史璐璐（emp-58c68115…），各 8 小时
 *   - 原记录只挂在叶芷辰名下（bb-mwkiymf2-9hbtzu）
 *
 * 拆法（保持「奖金 = 订单金额 × 5%」这条不变量，且汇总不失真）：
 *   - 原记录：amountCents 179400 → 89700，bonusCents 8970 → 4485
 *   - 新记录：史璐璐 amountCents 89700，bonusCents 4485，同一张小票
 *   - 合计仍是 订单 179400 / 奖金 8970
 *
 * 只改这一天的这两行，默认预演，`--apply` 才写。
 * 运行：docker cp 到容器后 `node /tmp/fix-bonus-split.mjs [--apply]`
 */
import { prisma } from '/app/server/pg.js'

const APPLY = process.argv.includes('--apply')
const ORIGINAL_ID = 'bb-mwkiymf2-9hbtzu'
const STORE = 'tongying'
const DATE = '2026-11-17'
const SHARE_AMOUNT = 89700n
const SHARE_BONUS = 4485n
const OTHER = {
  employeeId: 'emp-58c68115-f0f2-4731-9951-2050d2e7229f',
  staffName: '史璐璐',
}

const rows = await prisma.bigOrderBonus.findMany({ where: { storeKey: STORE, date: new Date(`${DATE}T00:00:00.000Z`) } })
console.log('当前记录：')
for (const row of rows) {
  console.log(` - ${row.id} ${row.staffName} amount=${row.amountCents} bonus=${row.bonusCents} by=${row.createdBy}`)
}

const original = rows.find((row) => row.id === ORIGINAL_ID)
if (!original) throw new Error('原记录不存在，可能已被修改')
if (original.amountCents === SHARE_AMOUNT && original.bonusCents === SHARE_BONUS && rows.some((row) => row.staffName === OTHER.staffName)) {
  console.log('已经是平分状态，无需处理')
  process.exit(0)
}
if (original.amountCents !== 179400n || original.bonusCents !== 8970n) {
  throw new Error(`原记录金额不是 1794/89.70（${original.amountCents}/${original.bonusCents}），停止`)
}
if (rows.some((row) => row.staffName === OTHER.staffName)) {
  throw new Error('史璐璐当天已有大单奖记录，停止')
}

const newId = `bb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
console.log(`\n计划：原记录改为 ${SHARE_AMOUNT}/${SHARE_BONUS}；新增 ${newId} 给 ${OTHER.staffName}`)
if (!APPLY) {
  console.log('预演结束，未写入。加 --apply 执行。')
  process.exit(0)
}

await prisma.$transaction([
  prisma.bigOrderBonus.update({
    where: { id: ORIGINAL_ID },
    data: { amountCents: SHARE_AMOUNT, bonusCents: SHARE_BONUS },
  }),
  prisma.bigOrderBonus.create({
    data: {
      id: newId,
      employeeId: OTHER.employeeId,
      staffKey: `${STORE}::${OTHER.staffName}`,
      staffName: OTHER.staffName,
      storeKey: STORE,
      date: new Date(`${DATE}T00:00:00.000Z`),
      amountCents: SHARE_AMOUNT,
      bonusCents: SHARE_BONUS,
      receipt: original.receipt,
      createdBy: 'budu',
    },
  }),
])

const after = await prisma.bigOrderBonus.findMany({ where: { storeKey: STORE, date: new Date(`${DATE}T00:00:00.000Z`) } })
console.log('\n处理结果：')
let bonusSum = 0n
let amountSum = 0n
for (const row of after) {
  bonusSum += row.bonusCents
  amountSum += row.amountCents
  console.log(` - ${row.id} ${row.staffName} amount=${row.amountCents} bonus=${row.bonusCents} by=${row.createdBy}`)
}
console.log(`合计 amount=${amountSum} bonus=${bonusSum}`)
process.exit(0)
