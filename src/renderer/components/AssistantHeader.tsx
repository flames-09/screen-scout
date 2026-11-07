import { useState } from 'react'
import { Eraser, Settings, X } from 'lucide-react'
import { BrandMark } from './BrandMark'

/** Popup header: brand, model chip, new chat, settings, hide. Draggable region. */
export function AssistantHeader({
  model,
  busy,
  canClear,
  onClear,
  onOpenSettings,
  onHide
}: {
  model: string
  busy: boolean
  canClear: boolean
  onClear: () => void
  onOpenSettings: () => void
  onHide: () => void
}): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const shortModel = model.includes('/') ? model.split('/')[1] : model

  const clearClicked = (): void => {
    if (canClear) setConfirming(true)
    else onClear()
  }

  const confirmClear = (): void => {
    setConfirming(false)
    onClear()
  }

  return (
    <header className="app-header" role="banner">
      <div className="header-drag">
        <BrandMark size={18} />
        <span className="header-name">Screen Scout</span>
        <span className="chip header-model" title={`Model: ${model}`}>
          {shortModel}
        </span>
        {busy && <span className="dot pulse header-dot" aria-label="Request in progress" />}
      </div>
      <div className="header-actions">
        {confirming ? (
          <span className="header-confirm" role="alert">
            Clear this chat?
            <button type="button" className="btn btn-sm btn-danger" onClick={confirmClear}>
              Clear
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirming(false)}>
              Keep
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="icon-btn"
            onClick={clearClicked}
            aria-label="New chat"
            title="New chat (clears messages and the capture)"
          >
            <Eraser size={14.5} strokeWidth={2} />
          </button>
        )}
        <button
          type="button"
          className="icon-btn"
          onClick={onOpenSettings}
          aria-label="Open settings"
          title="Settings"
        >
          <Settings size={14.5} strokeWidth={2} />
        </button>
        <button
          type="button"
          className="icon-btn danger"
          onClick={onHide}
          aria-label="Hide assistant"
          title="Hide (app keeps running)"
        >
          <X size={15} strokeWidth={2.2} />
        </button>
      </div>
    </header>
  )
}
