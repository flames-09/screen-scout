import { ShieldAlert } from 'lucide-react'
import type { AccessMode } from '@shared/types'

/**
 * Explicit confirmation before the FIRST image upload: the crop + prompt leave
 * the machine. "Always allow" remembers the choice in settings
 * (noticeAcknowledged). Copy adapts to the access mode, because in hosted mode
 * the data goes through the relay rather than straight to NVIDIA.
 */
export function PrivacyNotice({
  mode = 'byok',
  onSendOnce,
  onAlwaysAllow,
  onCancel
}: {
  mode?: AccessMode
  onSendOnce: () => void
  onAlwaysAllow: () => void
  onCancel: () => void
}): JSX.Element {
  const hosted = mode === 'hosted'
  return (
    <div className="privacy-notice rise-in" role="alertdialog" aria-label="Confirm image upload">
      <div className="privacy-icon">
        <ShieldAlert size={16} strokeWidth={2} />
      </div>
      <div className="privacy-copy">
        <strong>{hosted ? 'Send this screenshot to the free service?' : 'Send this screenshot to NVIDIA?'}</strong>
        <span>
          {hosted ? (
            <>
              The selected crop and your question go to Screen Scout&apos;s relay and are forwarded to a
              free-tier model provider. The relay stores no screenshots or prompts.
            </>
          ) : (
            <>
              The selected crop and your question will be sent to your configured NVIDIA NIM endpoint. They
              are not stored by Screen Scout.
            </>
          )}
        </span>
      </div>
      <div className="privacy-actions">
        <button type="button" className="btn btn-sm btn-primary" onClick={onSendOnce}>
          Send once
        </button>
        <button type="button" className="btn btn-sm" onClick={onAlwaysAllow}>
          Always allow
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
