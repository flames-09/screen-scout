import { memo } from 'react'
import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import type { UIMessage } from '@shared/types'
import { MarkdownView } from './MarkdownView'

/** A single conversation bubble: user prompt, assistant answer, or error. */
export const ChatMessage = memo(function ChatMessage({
  message,
  busy,
  onRetry,
  onOpenSettings
}: {
  message: UIMessage
  busy: boolean
  onRetry: () => void
  onOpenSettings: () => void
}): JSX.Element {
  const [copied, setCopied] = useState(false)

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      // Clipboard can fail when the window loses focus; silent is fine.
    }
  }

  if (message.role === 'user') {
    return (
      <div className="msg-row user">
        <div className="msg user-msg">
          {message.attachment && (
            <img
              className="msg-capture"
              src={message.attachment.dataUrl}
              alt="Captured screen region"
              draggable={false}
            />
          )}
          {message.content && <div className="msg-text">{message.content}</div>}
        </div>
      </div>
    )
  }

  if (message.kind === 'error' && message.error) {
    const e = message.error
    return (
      <div className="msg-row assistant">
        <div className="msg assistant-msg error-msg" role="alert">
          <div className="msg-text error-text">
            {e.message}
          </div>
          {e.detail && (
            <details className="error-details">
              <summary>Technical details</summary>
              <div className="error-detail-body">{e.detail}</div>
            </details>
          )}
          <div className="msg-actions">
            <button type="button" className="btn btn-sm" onClick={onRetry} disabled={busy}>
              Try again
            </button>
            {(e.code === 'no-key' ||
              e.code === 'invalid-key' ||
              e.code === 'quota-exceeded' ||
              e.code === 'hosted-unavailable') && (
              <button type="button" className="btn btn-sm btn-primary" onClick={onOpenSettings}>
                Open Settings
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (message.kind === 'cancelled') {
    return (
      <div className="msg-row assistant">
        <div className="msg assistant-msg cancelled-msg">
          <span className="cancelled-text">Request cancelled.</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onRetry} disabled={busy}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  const isPending = message.pending === true && message.content.length === 0
  const isStreaming = message.pending === true && message.content.length > 0

  return (
    <div className="msg-row assistant">
      <div className="msg assistant-msg">
        {isPending ? (
          <div className="thinking" aria-label="Waiting for the model">
            <span className="thinking-dot" />
            <span className="thinking-dot" />
            <span className="thinking-dot" />
            <span className="thinking-label">Thinking…</span>
          </div>
        ) : (
          <MarkdownView content={message.content} />
        )}
        {(isStreaming || (!message.pending && message.content.length > 0)) && (
          <div className="msg-footer">
            <button
              type="button"
              className="icon-btn small"
              onClick={() => void copy()}
              aria-label={copied ? 'Response copied' : 'Copy response'}
              title="Copy response"
            >
              {copied ? <Check size={13} strokeWidth={2.2} /> : <Copy size={13} strokeWidth={2} />}
            </button>
            {isStreaming && <span className="stream-caret" aria-hidden="true" />}
          </div>
        )}
      </div>
    </div>
  )
})
