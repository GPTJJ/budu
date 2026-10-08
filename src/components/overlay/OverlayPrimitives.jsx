import { useEffect } from 'react'

// Legacy BUDU overlays consistently use Tailwind's fixed + inset-0 pair.
// Transparent click-away layers used by popovers opt out explicitly: they are not
// modal roots and locking the page for them breaks WebKit's anchored positioning.
const overlaySelector = '[data-budu-overlay-root], [role="dialog"][aria-modal="true"], .fixed.inset-0:not([data-budu-overlay-ignore])'

// A fixed overlay inside an unrendered responsive/hidden ancestor must never
// lock the document. getComputedStyle(element) alone does not detect a display:none
// ancestor, so check layout and the complete element chain.
function visibleOverlayCount() {
  return [...document.querySelectorAll(overlaySelector)].filter((element) => {
    if (!element.isConnected || element.getClientRects().length === 0) return false
    for (let node = element; node instanceof Element; node = node.parentElement) {
      if (node.hidden || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true') return false
      const style = window.getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
    }
    return true
  }).length
}

/** One application-level scroll lock shared by every modal implementation. */
export function OverlayStackManager() {
  useEffect(() => {
    let restore = null

    const lock = () => {
      if (restore) return
      const scrollX = window.scrollX
      const scrollY = window.scrollY
      const body = document.body
      const html = document.documentElement
      restore = {
        scrollX,
        scrollY,
        body: {
          overflow: body.style.overflow,
          position: body.style.position,
          top: body.style.top,
          left: body.style.left,
          right: body.style.right,
          width: body.style.width,
        },
        htmlOverflow: html.style.overflow,
        htmlOverscrollBehavior: html.style.overscrollBehavior,
      }
      html.classList.add('budu-overlay-open')
      // Preserve the scrollbar width across WebKit responsive breakpoints while locked.\n      html.style.overflow = window.innerWidth > html.clientWidth ? 'hidden scroll' : 'hidden'
      html.style.overscrollBehavior = 'none'
      body.style.overflow = 'hidden'
      body.style.position = 'fixed'
      body.style.top = `-${scrollY}px`
      body.style.left = `-${scrollX}px`
      body.style.right = '0'
      body.style.width = '100%'
    }

    const unlock = () => {
      if (!restore) return
      const previous = restore
      restore = null
      const body = document.body
      const html = document.documentElement
      html.classList.remove('budu-overlay-open')
      html.style.overflow = previous.htmlOverflow
      html.style.overscrollBehavior = previous.htmlOverscrollBehavior
      Object.assign(body.style, previous.body)
      const inlineScrollBehavior = html.style.scrollBehavior
      html.style.scrollBehavior = 'auto'
      window.scrollTo(previous.scrollX, previous.scrollY)
      html.style.scrollBehavior = inlineScrollBehavior
    }

    const sync = () => {
      if (visibleOverlayCount() > 0) lock()
      else unlock()
    }

    // The drawer may be hidden by a breakpoint or a parent class change
    // without being removed. Coalesce notifications to avoid relocking on
    // every unrelated class change during normal page updates.
    let pendingFrame = 0
    const scheduleSync = () => {
      if (pendingFrame) return
      pendingFrame = window.requestAnimationFrame(() => {
        pendingFrame = 0
        sync()
      })
    }
    const observer = new MutationObserver((records) => {
      const affectsOverlay = records.some((record) => {
        if (record.type === 'childList') return true
        const target = record.target
        return target instanceof Element && (
          target.matches(overlaySelector) ||
          target.closest(overlaySelector) ||
          target.querySelector(overlaySelector)
        )
      })
      if (affectsOverlay) scheduleSync()
    })
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-modal', 'data-budu-overlay-root', 'hidden', 'aria-hidden', 'inert', 'class', 'style'],
    })
    window.addEventListener('resize', scheduleSync, { passive: true })
    window.addEventListener('orientationchange', scheduleSync, { passive: true })
    window.addEventListener('pageshow', scheduleSync)
    sync()
    return () => {
      window.removeEventListener('resize', scheduleSync)
      window.removeEventListener('orientationchange', scheduleSync)
      window.removeEventListener('pageshow', scheduleSync)
      observer.disconnect()
      if (pendingFrame) window.cancelAnimationFrame(pendingFrame)
      unlock()
    }
  }, [])

  return null
}

export function OverlayViewport({ className = '', children, ...props }) {
  return <div data-budu-overlay-root className={`budu-overlay-viewport ${className}`} {...props}>{children}</div>
}

export function OverlayPanel({ as: Component = 'section', className = '', children, ...props }) {
  return <Component className={`budu-overlay-panel ${className}`} {...props}>{children}</Component>
}

export function OverlayHeader({ as: Component = 'header', className = '', children, ...props }) {
  return <Component className={`budu-overlay-header ${className}`} {...props}>{children}</Component>
}

export function OverlayScrollRegion({ className = '', children, ...props }) {
  return <div className={`budu-overlay-scroll ${className}`} {...props}>{children}</div>
}

export function OverlayFooter({ as: Component = 'footer', className = '', children, ...props }) {
  return <Component className={`budu-overlay-footer ${className}`} {...props}>{children}</Component>
}
