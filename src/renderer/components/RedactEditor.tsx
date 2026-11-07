import { useCallback, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Attachment } from '../assistant/chat-state'
import {
  averageColor,
  boxFromDrag,
  chooseExportFormat,
  isMeaningfulBox,
  mosaicBlockSize,
  type RectBox
} from './redact-math'

type RedactMode = 'solid' | 'pixelate'

/**
 * In-popup redaction editor: drag boxes over anything private, then bake the
 * patches into a NEW image (the original crop is dropped from memory by the
 * caller). Everything happens locally — nothing leaves the machine here.
 * `limit` is the max encoded payload the send path will accept; the editor
 * keeps the ORIGINAL attachment if it cannot produce a fitting result.
 */
export function RedactEditor({
  attachment,
  limit,
  onApply,
  onCancel
}: {
  attachment: Attachment
  limit: number
  onApply: (next: Attachment) => void
  onCancel: () => void
}): JSX.Element {
  const imgRef = useRef<HTMLImageElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const dragStart = useRef<{ x: number; y: number } | null>(null)
  const [mode, setMode] = useState<RedactMode>('solid')
  const [boxes, setBoxes] = useState<RectBox[]>([])
  const [draft, setDraft] = useState<RectBox | null>(null)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [applying, setApplying] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  /** Maps client coordinates onto image pixel coordinates via the live <img>. */
  const metrics = useCallback((): { originX: number; originY: number; scale: number; w: number; h: number } | null => {
    const img = imgRef.current
    if (!img || !img.complete || img.naturalWidth === 0) return null
    const rect = img.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    return {
      originX: rect.left,
      originY: rect.top,
      scale: img.naturalWidth / rect.width,
      w: img.naturalWidth,
      h: img.naturalHeight
    }
  }, [])

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (!e.isPrimary) return
      const m = metrics()
      if (!m) return
      dragStart.current = { x: e.clientX, y: e.clientY }
      setDraft({ x: 0, y: 0, w: 0, h: 0 })
      try {
        ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
      } catch {
        // The pointer can vanish (canceled touch) before capture succeeds.
      }
      e.preventDefault()
    },
    [metrics]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      const start = dragStart.current
      const m = metrics()
      if (!start || !m) return
      setDraft(
        boxFromDrag(start, { x: e.clientX, y: e.clientY }, { x: m.originX, y: m.originY }, m.scale, {
          width: m.w,
          height: m.h
        })
      )
    },
    [metrics]
  )

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      const start = dragStart.current
      const m = metrics()
      dragStart.current = null
      setDraft(null)
      if (!start || !m) return
      const box = boxFromDrag(
        start,
        { x: e.clientX, y: e.clientY },
        { x: m.originX, y: m.originY },
        m.scale,
        { width: m.w, height: m.h }
      )
      if (!isMeaningfulBox(box)) return
      setBoxes((prev) => [...prev, box])
    },
    [metrics]
  )

  const apply = useCallback((): void => {
    const img = imgRef.current
    if (!img || !img.complete || img.naturalWidth === 0 || boxes.length === 0) return
    setApplying(true)
    setNote(null)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no-canvas')
      // JPEG fallback has no alpha — lay an opaque matte first regardless.
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0)
      for (const box of boxes) {
        if (mode === 'solid') {
          const region = ctx.getImageData(box.x, box.y, box.w, box.h)
          const avg = averageColor(region.data)
          ctx.fillStyle = `rgb(${avg.r},${avg.g},${avg.b})`
          ctx.fillRect(box.x, box.y, box.w, box.h)
        } else {
          const block = mosaicBlockSize(box)
          const cols = Math.max(1, Math.ceil(box.w / block))
          const rows = Math.max(1, Math.ceil(box.h / block))
          const small = document.createElement('canvas')
          small.width = cols
          small.height = rows
          const sctx = small.getContext('2d')
          if (!sctx) throw new Error('no-canvas')
          sctx.drawImage(img, box.x, box.y, box.w, box.h, 0, 0, cols, rows)
          ctx.imageSmoothingEnabled = false
          ctx.drawImage(small, 0, 0, cols, rows, box.x, box.y, box.w, box.h)
          ctx.imageSmoothingEnabled = true
        }
      }
      // Export ladder: the attachment must stay under the SEND cap or
      // chat:send would reject it after the original was already replaced.
      // PNG first (crisp text), then JPEG, then downscaled JPEG — the last
      // canvas that produced a fitting data URL wins.
      const fits = (source: HTMLCanvasElement, mime: 'image/png' | 'image/jpeg', quality?: number): { dataUrl: string; width: number; height: number } | null => {
        const dataUrl = source.toDataURL(mime, quality)
        return dataUrl.length <= limit ? { dataUrl, width: source.width, height: source.height } : null
      }
      const png = fits(canvas, 'image/png')
      let out: { dataUrl: string; width: number; height: number } | null = png
      if (!out) {
        const jpegPlan = chooseExportFormat(png ? png.dataUrl.length : Number.MAX_SAFE_INTEGER, limit)
        out = fits(canvas, 'image/jpeg', jpegPlan.quality ?? 0.85)
      }
      for (const scale of [0.7, 0.45]) {
        if (out) break
        const smaller = document.createElement('canvas')
        smaller.width = Math.max(1, Math.round(canvas.width * scale))
        smaller.height = Math.max(1, Math.round(canvas.height * scale))
        const sctx = smaller.getContext('2d')
        if (!sctx) break
        sctx.fillStyle = '#ffffff'
        sctx.fillRect(0, 0, smaller.width, smaller.height)
        sctx.drawImage(canvas, 0, 0, smaller.width, smaller.height)
        out = fits(smaller, 'image/jpeg', 0.85) ?? fits(smaller, 'image/jpeg', 0.7)
      }
      if (!out) {
        // Keep the editor open with the ORIGINAL attachment untouched —
        // never swap in an attachment the send path would reject.
        setNote('The redacted image is too large to send even compressed. Try covering a smaller area or recapturing.')
        return
      }
      onApply({
        dataUrl: out.dataUrl,
        width: out.width,
        height: out.height,
        bytes: out.dataUrl.length,
        mime: out.dataUrl.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png'
      })
    } catch {
      setNote("Couldn't apply the redactions. Try again.")
    } finally {
      setApplying(false)
    }
  }, [boxes, mode, onApply, limit])

  const pct = (value: number, total: number): string => `${(value / total) * 100}%`
  const boxStyle = (b: RectBox): CSSProperties =>
    natural
      ? { left: pct(b.x, natural.w), top: pct(b.y, natural.h), width: pct(b.w, natural.w), height: pct(b.h, natural.h) }
      : { display: 'none' }

  return (
    <div className="redact-editor" role="dialog" aria-label="Redact the attached image">
      <div className="redact-toolbar">
        <div className="redact-modes" role="group" aria-label="Redaction style">
          <button
            type="button"
            className={`btn btn-sm ${mode === 'solid' ? 'btn-primary' : ''}`}
            onClick={() => setMode('solid')}
            aria-pressed={mode === 'solid'}
          >
            Solid
          </button>
          <button
            type="button"
            className={`btn btn-sm ${mode === 'pixelate' ? 'btn-primary' : ''}`}
            onClick={() => setMode('pixelate')}
            aria-pressed={mode === 'pixelate'}
          >
            Pixelate
          </button>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => setBoxes((b) => b.slice(0, -1))} disabled={boxes.length === 0}>
          Undo
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setBoxes([])} disabled={boxes.length === 0}>
          Reset
        </button>
        <span className="redact-count" aria-live="polite">
          {boxes.length === 0 ? 'No patches' : `${boxes.length} patch${boxes.length === 1 ? '' : 'es'}`}
        </span>
        <div className="redact-spacer" />
        <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel} disabled={applying}>
          Cancel
        </button>
        <button type="button" className="btn btn-sm btn-primary" onClick={apply} disabled={boxes.length === 0 || applying}>
          Apply
        </button>
      </div>
      <div className="redact-stage">
        <img
          ref={imgRef}
          className="redact-img"
          src={attachment.dataUrl}
          alt="Captured screen region being redacted"
          draggable={false}
          onLoad={() => {
            const img = imgRef.current
            if (img && img.naturalWidth > 0) setNatural({ w: img.naturalWidth, h: img.naturalHeight })
          }}
        />
        <div
          ref={overlayRef}
          className="redact-overlay"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {boxes.map((b, i) => (
            <div key={i} className="redact-box" style={boxStyle(b)} />
          ))}
          {draft && <div className="redact-box drafting" style={boxStyle(draft)} />}
        </div>
      </div>
      <div className="redact-hint">
        Drag over anything private. Patches are baked in before the image is sent — the untouched original never
        leaves this machine.
      </div>
      {note && (
        <div className="settings-note warn" role="alert">
          {note}
        </div>
      )}
    </div>
  )
}
