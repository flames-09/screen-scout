import { Eraser, RotateCcw, X } from 'lucide-react'
import type { Attachment } from '../assistant/chat-state'

/** Attachment strip: the captured crop with Redact / Retake / Remove actions. */
export function ScreenshotAttachment({
  attachment,
  busy,
  onRedact,
  onRetake,
  onRemove
}: {
  attachment: Attachment
  busy: boolean
  onRedact: () => void
  onRetake: () => void
  onRemove: () => void
}): JSX.Element {
  const sizeLabel =
    attachment.bytes > 1024 * 1024
      ? `${(attachment.bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.round(attachment.bytes / 1024)} KB`
  return (
    <div className="attachment glass-inset">
      <div className="attachment-thumb-wrap">
        <img
          className="attachment-thumb"
          src={attachment.dataUrl}
          alt="Captured screen region preview"
          draggable={false}
        />
      </div>
      <div className="attachment-meta">
        <div className="attachment-title">Screen capture</div>
        <div className="attachment-dims">
          {attachment.width}×{attachment.height} · {sizeLabel}
        </div>
      </div>
      <div className="attachment-actions">
        <button
          type="button"
          className="btn btn-sm"
          onClick={onRedact}
          disabled={busy}
          aria-label="Redact the attached image"
          title="Cover private areas before sending"
        >
          <Eraser size={12.5} strokeWidth={2} />
          Redact
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={onRetake}
          disabled={busy}
          aria-label="Retake screen capture"
        >
          <RotateCcw size={12.5} strokeWidth={2} />
          Retake
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={onRemove}
          disabled={busy}
          aria-label="Remove screen capture"
        >
          <X size={12.5} strokeWidth={2.2} />
          Remove
        </button>
      </div>
    </div>
  )
}
