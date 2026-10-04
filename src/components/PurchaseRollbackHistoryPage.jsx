export default function PurchaseRollbackHistoryPage({ onBack = () => {} }) {
  return <section className="mx-auto max-w-5xl space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-xl font-black text-slate-800">采购入库</h2>
      <button className="min-h-11 rounded-xl border border-slate-200 bg-white px-4 py-2" onClick={onBack}>返回</button>
    </div>
    <p className="rounded-2xl bg-rose-50 p-4 text-slate-700">采购操作暂时停用。新采购与收货记录已保留，恢复后可继续处理。</p>
  </section>
}
