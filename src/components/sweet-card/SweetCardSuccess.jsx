import { CheckCircle2, Download, Gift, LayoutGrid, Plus } from 'lucide-react'

export default function SweetCardSuccess({ result, onViewBatches, onViewCards, onContinue }) {
  const batchId = result?.batchId
  const cardCount = Array.isArray(result?.cards) ? result.cards.length : 0
  return <div className="mt-4 rounded-3xl bg-white p-6 shadow-card sm:p-10">
    <div className="flex flex-col items-center text-center">
      <div className="grid h-14 w-14 place-items-center rounded-3xl bg-emerald-50 text-emerald-600"><CheckCircle2 className="h-8 w-8" /></div>
      <h2 className="mt-4 text-xl font-black text-slate-900">甜意卡批次创建成功</h2>
      <p className="mt-2 text-sm text-slate-500">已创建 {cardCount} 张卡，每张卡含使用凭证与发卡账务记录。</p>
      <div className="mt-4 flex items-center gap-2 rounded-full bg-budu-50 px-4 py-2 text-sm font-bold text-budu-700"><Gift className="h-4 w-4" />批次 {batchId}</div>
    </div>
    <div className="mt-6 grid gap-2 sm:grid-cols-2">
      <button onClick={onViewBatches} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-budu-500 px-4 font-bold text-white"><LayoutGrid className="h-4 w-4" />查看批次</button>
      <button onClick={onViewCards} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-budu-200 px-4 font-bold text-budu-600">查看卡片</button>
      <a href={`/api/v2/sweet-cards/batches/${batchId}/export`} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-budu-200 px-4 font-bold text-budu-600"><Download className="h-4 w-4" />下载 QR 包</a>
      <button onClick={onContinue} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-slate-200 px-4 font-bold text-slate-600"><Plus className="h-4 w-4" />继续发卡</button>
    </div>
  </div>
}
