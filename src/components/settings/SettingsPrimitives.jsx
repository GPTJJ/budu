import { createPortal } from 'react-dom'
import { ArrowLeft, ChevronRight, X } from 'lucide-react'
import {
  OverlayFooter,
  OverlayHeader,
  OverlayPanel,
  OverlayScrollRegion,
  OverlayViewport,
} from '../overlay/OverlayPrimitives'

export function SettingsSection({ title, children, className = '' }) {
  return (
    <section className={`min-w-0 ${className}`}>
      <h3 className="mb-2 px-1 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">{title}</h3>
      <div className="overflow-hidden rounded-[20px] border border-slate-200/75 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.025)]">
        {children}
      </div>
    </section>
  )
}

export function SettingsStatus({ tone = 'neutral', children }) {
  const tones = {
    success: 'bg-emerald-50 text-emerald-700 ring-emerald-600/10',
    warning: 'bg-amber-50 text-amber-700 ring-amber-600/10',
    danger: 'bg-rose-50 text-rose-700 ring-rose-600/10',
    brand: 'bg-budu-50 text-budu-700 ring-budu-600/10',
    neutral: 'bg-slate-100 text-slate-600 ring-slate-600/10',
  }
  return (
    <span className={`inline-flex max-w-[7.5rem] shrink-0 items-center truncate rounded-full px-2.5 py-1 text-[11px] font-bold ring-1 ring-inset ${tones[tone] || tones.neutral}`}>
      {children}
    </span>
  )
}

export function SettingsRow({ icon: Icon, iconTone = 'slate', title, subtitle, status, onClick, last = false, testId }) {
  const iconTones = {
    brand: 'bg-budu-50 text-budu-600',
    blue: 'bg-sky-50 text-sky-600',
    green: 'bg-emerald-50 text-emerald-600',
    amber: 'bg-amber-50 text-amber-600',
    violet: 'bg-violet-50 text-violet-600',
    slate: 'bg-slate-100 text-slate-600',
  }
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={`group flex min-h-[68px] w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-slate-50/80 active:bg-slate-100/80 ${last ? '' : 'border-b border-slate-100'}`}
    >
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${iconTones[iconTone] || iconTones.slate}`}>
        <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-semibold text-slate-800">{title}</span>
        {subtitle && <span className="mt-0.5 block line-clamp-2 text-[11px] leading-4 text-slate-400 sm:text-xs">{subtitle}</span>}
      </span>
      {status}
      <ChevronRight className="h-4 w-4 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-400" />
    </button>
  )
}

export function SettingsDetailPage({ title, subtitle, onBack, children, actions }) {
  return (
    <section data-testid="settings-detail-page" className="mx-auto w-full max-w-4xl overflow-hidden rounded-[22px] border border-slate-200/70 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.035)]">
      <header className="flex min-h-[68px] items-center gap-3 border-b border-slate-100 px-3 py-3 sm:px-5">
        <button type="button" aria-label="返回设置" onClick={onBack} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-budu-600 transition hover:bg-budu-50">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1 text-center sm:text-left">
          <h2 className="truncate text-[17px] font-bold text-slate-900">{title}</h2>
          {subtitle && <p className="mt-0.5 hidden truncate text-xs text-slate-400 sm:block">{subtitle}</p>}
        </div>
        <div className="w-11 shrink-0 sm:w-auto">{actions}</div>
      </header>
      <div className="space-y-5 p-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:p-6">{children}</div>
    </section>
  )
}

export function SettingsConfirmDialog({ open, title, description, busy, onCancel, onConfirm }) {
  if (!open) return null
  return createPortal(
    <OverlayViewport className="fixed inset-0 z-[240] flex items-end justify-center bg-slate-950/35 backdrop-blur-[2px] sm:items-center sm:p-4">
      <OverlayPanel as="section" role="dialog" aria-modal="true" aria-labelledby="settings-confirm-title" className="flex max-h-[min(92dvh,34rem)] w-full flex-col overflow-hidden rounded-t-[28px] bg-white shadow-2xl sm:max-w-md sm:rounded-[24px]">
        <OverlayHeader className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h3 id="settings-confirm-title" className="text-base font-bold text-slate-900">{title}</h3>
          <button type="button" aria-label="关闭" disabled={busy} onClick={onCancel} className="grid h-10 w-10 place-items-center rounded-full bg-slate-100 text-slate-500 disabled:opacity-40">
            <X className="h-4 w-4" />
          </button>
        </OverlayHeader>
        <OverlayScrollRegion className="px-5 py-5 text-sm leading-6 text-slate-600">{description}</OverlayScrollRegion>
        <OverlayFooter className="grid grid-cols-2 gap-3 border-t border-slate-100 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:px-5">
          <button type="button" disabled={busy} onClick={onCancel} className="min-h-12 rounded-xl bg-slate-100 text-sm font-bold text-slate-600 disabled:opacity-40">取消</button>
          <button type="button" disabled={busy} onClick={onConfirm} className="min-h-12 rounded-xl bg-rose-600 text-sm font-bold text-white disabled:opacity-40">{busy ? '处理中…' : '确认解绑'}</button>
        </OverlayFooter>
      </OverlayPanel>
    </OverlayViewport>,
    document.body,
  )
}
