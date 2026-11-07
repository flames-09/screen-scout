import { useEffect, useRef } from 'react'
import { Crop, Send, Square, SquareDashedMousePointer } from 'lucide-react'

/** Multi-line composer with the screen-select control and Send/Stop button. */
export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  onSelect,
  canSend,
  busy,
  selecting
}: {
  value: string
  onChange: (text: string) => void
  onSend: () => void
  onStop: () => void
  onSelect: () => void
  canSend: boolean
  busy: boolean
  selecting: boolean
}): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null)

  // Auto-grow up to ~6 lines.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`
  }, [value])

  return (
    <div className="composer">
      <button
        type="button"
        className="composer-select"
        onClick={onSelect}
        disabled={busy || selecting}
        aria-label="Select screen area"
        title="Select screen area"
      >
        {selecting ? <SquareDashedMousePointer size={15} strokeWidth={2} /> : <Crop size={15} strokeWidth={2} />}
        <span>Select screen area</span>
      </button>
      <div className="composer-input-wrap glass-inset">
        <textarea
          ref={ref}
          className="composer-input"
          value={value}
          placeholder="Ask about this screen…"
          rows={1}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (canSend) onSend()
            }
          }}
          aria-label="Your question"
          disabled={busy}
        />
      </div>
      {busy ? (
        <button
          type="button"
          className="composer-send stop"
          onClick={onStop}
          aria-label="Stop generating"
          title="Stop generating"
        >
          <Square size={12} strokeWidth={2.6} />
        </button>
      ) : (
        <button
          type="button"
          className="composer-send"
          onClick={onSend}
          disabled={!canSend}
          aria-label="Send message"
          title="Send"
        >
          <Send size={14.5} strokeWidth={2.2} />
        </button>
      )}
    </div>
  )
}
