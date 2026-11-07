import { ClipboardPaste, Crop, Scan, KeyRound, MousePointerClick, Cloud } from 'lucide-react'
import { BrandMark } from './BrandMark'

/** Idle / first-run empty states. */
export function EmptyState({
  canSend,
  hosted = false,
  hasMessages,
  onOpenSettings,
  onSelect
}: {
  /** True when the current access mode can actually reach a model. */
  canSend: boolean
  /** True when the app is in the free hosted mode (changes the setup copy). */
  hosted?: boolean
  hasMessages: boolean
  onOpenSettings: () => void
  onSelect: () => void
}): JSX.Element | null {
  if (hasMessages) return null

  if (!canSend) {
    return (
      <div className="empty-state rise-in">
        <div className="empty-icon">
          {hosted ? <Cloud size={22} strokeWidth={1.8} /> : <KeyRound size={22} strokeWidth={1.8} />}
        </div>
        <div className="empty-title">{hosted ? 'Free mode is unavailable' : 'Add your NVIDIA API key'}</div>
        <p className="empty-text">
          {hosted
            ? 'This build has no hosted relay configured. Open Settings to use your own NVIDIA key instead.'
            : 'Screen Scout uses your own NVIDIA NIM account. Save your API key once and ask about anything on your screen.'}
        </p>
        <button type="button" className="btn btn-primary" onClick={onOpenSettings}>
          Open Settings
        </button>
      </div>
    )
  }

  return (
    <div className="empty-state rise-in">
      <div className="empty-brand">
        <BrandMark size={34} />
      </div>
      <div className="empty-title">Ask about anything on your screen</div>
      <p className="empty-text">
        Capture a region, then ask a question about it. Nothing is uploaded until you press Send.
      </p>
      <button type="button" className="btn" onClick={onSelect}>
        <Crop size={14} strokeWidth={2} />
        Select screen area
      </button>
      <div className="empty-hints">
        <span className="hint-row">
          <Scan size={12} strokeWidth={2} />
          Drag to select any region
        </span>
        <span className="hint-row">
          <ClipboardPaste size={12} strokeWidth={2} />
          Or paste (Ctrl+V) / drop an image
        </span>
        <span className="hint-row">
          <MousePointerClick size={12} strokeWidth={2} />
          Nothing is sent until you press Send
        </span>
      </div>
    </div>
  )
}
