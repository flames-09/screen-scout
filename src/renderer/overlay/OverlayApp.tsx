import { useCallback, useEffect, useRef, useState } from 'react'

interface DragState {
  originX: number
  originY: number
}

/**
 * Fullscreen selection layer for one display. The user drags a rectangle;
 * the selected area stays crisp (undimmed), everything else darkens. Esc or
 * right-click cancels. Coordinates are reported in DIP *screen* coordinates
 * by adding the window's own screen offset.
 */
export function OverlayApp(): JSX.Element {
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const drag = useRef<DragState | null>(null)

  const cancel = useCallback((): void => {
    window.scout.overlay.cancel()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') cancel()
    }
    const onContext = (e: MouseEvent): void => {
      e.preventDefault()
      cancel()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('contextmenu', onContext)
    const offInvalid = window.scout.overlay.onInvalid((message) => {
      setHint(message)
      setTimeout(() => setHint(null), 1600)
    })
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('contextmenu', onContext)
      offInvalid()
    }
  }, [cancel])

  const localPoint = (e: PointerEvent | React.PointerEvent): { x: number; y: number } => ({
    x: e.clientX,
    y: e.clientY
  })

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    const p = localPoint(e)
    drag.current = { originX: p.x, originY: p.y }
    setRect({ x: p.x, y: p.y, w: 0, h: 0 })
    try {
      ;(e.target as Element).setPointerCapture?.(e.pointerId)
    } catch {
      // The pointer can vanish (canceled touch) before capture succeeds —
      // the drag still works through plain window events.
    }
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    const p = localPoint(e)
    setRect({
      x: Math.min(d.originX, p.x),
      y: Math.min(d.originY, p.y),
      w: Math.abs(p.x - d.originX),
      h: Math.abs(p.y - d.originY)
    })
  }

  const onPointerUp = (e: React.PointerEvent): void => {
    const d = drag.current
    drag.current = null
    if (!d) return
    const p = localPoint(e)
    const w = Math.abs(p.x - d.originX)
    const h = Math.abs(p.y - d.originY)
    if (w < 4 || h < 4) {
      // A click, not a drag — start over.
      setRect(null)
      return
    }
    const x = Math.min(d.originX, p.x)
    const y = Math.min(d.originY, p.y)
    // DIP screen coordinates: window position + client offset.
    window.scout.overlay.reportRect({
      x: window.screenX + x,
      y: window.screenY + y,
      width: w,
      height: h
    })
  }

  return (
    <div
      className="overlay-root"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {!rect && <div className="overlay-base-dim" />}
      {rect && (
        <div className="overlay-selection" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
          <div
            className={`overlay-dims${rect.x + rect.w > window.innerWidth - 130 ? ' flip' : ''}`}
          >
            {Math.round(rect.w)} × {Math.round(rect.h)}
          </div>
        </div>
      )}
      <div className="overlay-hint">
        <span className="overlay-hint-key">Drag</span> to select
        <span className="overlay-hint-sep">·</span>
        <span className="overlay-hint-key">Esc</span> to cancel
      </div>
      {hint && <div className="overlay-toast">{hint}</div>}
    </div>
  )
}
