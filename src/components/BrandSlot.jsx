import iconUrl from '../../brand/web/budu-brand-slot-icon.png'
import wordmarkUrl from '../../brand/web/budu-wordmark.svg'

const transparentBrandAsset = {
  background: 'transparent',
  border: 0,
  boxShadow: 'none',
  outline: 'none',
}

export default function BrandSlot({ className = '' }) {
  return (
    <div
      data-testid="brand-slot"
      className={`flex min-w-0 items-center gap-2.5 ${className}`}
    >
      <img
        data-testid="brand-slot-icon"
        src={iconUrl}
        alt=""
        aria-hidden="true"
        className="h-10 w-10 shrink-0 object-contain"
        style={transparentBrandAsset}
      />
      <img
        data-testid="brand-slot-wordmark"
        src={wordmarkUrl}
        alt="budu"
        className="h-auto w-24 shrink-0"
        style={transparentBrandAsset}
      />
    </div>
  )
}
