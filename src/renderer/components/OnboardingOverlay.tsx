import { useState } from 'react'

/**
 * First-run gate: the chat is locked until the user picks how to power the
 * assistant — the free hosted service (Google sign-in) or their own API key.
 * Both paths set `onboarded` in main; the overlay disappears as soon as
 * settings reflect the choice. The main process independently refuses hosted
 * sends while `onboarded` is false (renderer is untrusted).
 */
export function OnboardingOverlay({
  hostedAvailable,
  onGoogle,
  onOwnKey
}: {
  hostedAvailable: boolean
  /** Runs the Google flow; returns an error message, or null on success. */
  onGoogle: () => Promise<string | null>
  onOwnKey: () => void
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleGoogle = (): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    void onGoogle().then((err) => {
      if (err) {
        setError(err)
        setBusy(false)
      }
      // On success settings flip → parent stops rendering the overlay.
    })
  }

  return (
    <div className="onboard-overlay" role="dialog" aria-modal="true" aria-label="Set up Screen Scout">
      <div className="onboard-card">
        <h2>Welcome to Screen Scout</h2>
        <p className="onboard-lede">Choose how the assistant answers. You can change this anytime in Settings.</p>

        <button
          type="button"
          className="onboard-option"
          disabled={busy || !hostedAvailable}
          onClick={handleGoogle}
        >
          <strong>Use the free hosted service</strong>
          <span>
            Sign in with Google — 5 screenshots and 50 chats per day, no API key. Only the
            screenshots you send leave your device.
          </span>
        </button>

        <button type="button" className="onboard-option" disabled={busy} onClick={onOwnKey}>
          <strong>Use my own API key</strong>
          <span>Bring your own key. Requests go straight from this device to the provider.</span>
        </button>

        {!hostedAvailable && (
          <p className="onboard-note">
            The free service isn&apos;t reachable right now — you can still add your own API key.
          </p>
        )}
        {busy && <p className="onboard-note">Waiting for Google sign-in to finish…</p>}
        {error && (
          <p className="onboard-note warn" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
