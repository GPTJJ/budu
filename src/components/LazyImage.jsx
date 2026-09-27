import { useEffect, useRef, useState } from 'react'

export default function LazyImage({ src, alt = '', rootMargin = '80px 0px', ...props }) {
  const imageRef = useRef(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    setVisible(false)
    const image = imageRef.current
    if (!image || !src) return undefined
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return undefined
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      setVisible(true)
      observer.disconnect()
    }, { rootMargin, threshold: 0.01 })
    observer.observe(image)
    return () => observer.disconnect()
  }, [src, rootMargin])

  return <img ref={imageRef} src={visible ? src : undefined} data-src={visible ? undefined : src} data-lazy-state={visible ? 'loaded' : 'pending'} alt={alt} loading="lazy" decoding="async" {...props} />
}
