import BuduWordmark from '../../brand/BuduWordmark'
import { formatCents } from '../../../utils/pos'

/**
 * 丝绒酒红主卡（#9E345B → #681B38）。
 * 排版铁律：压印的 budu 字标与 A LITTLE SWEETNESS. 必须整体位于水平分割线上方，
 * 不得与分割线、底部三栏指标重叠——因此三段结构固定为 header / 额度区 / 分割线后的指标区。
 */
export default function SweetCardHero({ balanceCents = '0', totalCents = '0', consumedCents = '0', claimedCount = 0, loading = false }) {
  return (
    <section
      aria-label="甜意卡额度概览"
      className="relative overflow-hidden rounded-[26px] text-white shadow-[0_18px_40px_-24px_rgba(104,27,56,0.9)]"
      style={{ background: 'linear-gradient(140deg, #9E345B 0%, #7C2547 46%, #681B38 100%)' }}
    >
      <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-20 h-52 w-52 rounded-full" style={{ background: 'radial-gradient(circle at 30% 30%, rgba(255,255,255,0.20), rgba(255,255,255,0) 70%)' }} />
      <div aria-hidden="true" className="pointer-events-none absolute -bottom-24 -left-10 h-48 w-48 rounded-full" style={{ background: 'radial-gradient(circle at 60% 40%, rgba(255,255,255,0.10), rgba(255,255,255,0) 72%)' }} />

      <div className="relative px-5 pb-4 pt-4">
        <div className="flex items-start justify-between">
          <BuduWordmark height={12} className="text-white/60" />
          <span className="text-[9px] font-black tracking-[0.34em] text-white/45">SWEET CARD</span>
        </div>

        <p className="mt-7 text-[10px] font-bold tracking-[0.26em] text-white/55">剩余可用额度</p>
        <p className="mt-1.5 break-all text-[34px] font-black leading-none tracking-tight tabular-nums sm:text-[38px]">
          {loading ? '—' : formatCents(balanceCents)}
        </p>
        <p className="mt-2.5 text-[9px] font-semibold tracking-[0.3em] text-white/40">A LITTLE SWEETNESS.</p>
      </div>

      <div aria-hidden="true" className="relative mx-5 h-px bg-white/20" />

      <dl className="relative grid grid-cols-3 px-3 py-3.5">
        {[['总发行额度', loading ? '—' : formatCents(totalCents)], ['已核销', loading ? '—' : formatCents(consumedCents)], ['已领出', loading ? '—' : `${claimedCount} 张`]].map(([label, value]) => (
          <div key={label} className="px-2 text-center">
            <dt className="text-[10px] font-semibold tracking-wide text-white/50">{label}</dt>
            <dd className="mt-1 break-all text-[13px] font-black tabular-nums text-white/95">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
