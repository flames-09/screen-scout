import { useCallback, useEffect, useRef, useState } from 'react'
import { Maximize2 } from 'lucide-react'

/**
 * Custom resize affordance for the transparent frameless window (native edge
 * resizing is unreliable for transparent windows). Drag grows the window via
 * the main process, clamped to min/max bounds.
 */
export function ResizeGrip(): JSX.Element {
  const dragging = useRef(false)
  const last = useRef({ x: 0, y: 0 })

  const onMove = useCallback((e: PointerEvent): void => {
    if (!dragging.current) return
    const dx = Math.round(e.clientX - last.current.x)
    const dy = Math.round(e.clientY - last.current.y)
    if (dx === 0 && dy === 0) return
    last.current = { x: e.clientX, y: e.clientY }
    void window.scout.window.resizeBy(dx, dy)
  }, [])

  useEffect(() => {
    const stop = (): void => {
      dragging.current = false
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
    }
  }, [onMove])

  return (
    <button
      type="button"
      className="resize-grip"
      aria-label="Resize window"
      title="Resize"
      onPointerDown={(e) => {
        e.preventDefault()
        dragging.current = true
        last.current = { x: e.clientX, y: e.clientY }
      }}
    >
      <Maximize2 size={11} strokeWidth={2.4} aria-hidden="true" />
    </button>
  )
}

/** Hook that keeps the latest message scrolled into view unless the user scrolled up. */
export function useAutoScroll(dependency: unknown): [React.RefObject<HTMLDivElement>, () => void] {
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  const onScroll = useCallback((): void => {
    const el = ref.current
    if (!el) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }, [])

  useEffect(() => {
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [dependency])

  return [ref, onScroll]
}

/** Small helper for transient toasts (capture failures etc.). */
export function useTimedFlag(timeoutMs = 3200): [string | null, (message: string) => void] {
  const [message, setMessage] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const show = useCallback(
    (msg: string): void => {
      setMessage(msg)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setMessage(null), timeoutMs)
    },
    [timeoutMs]
  )
  return [message, show]
}
