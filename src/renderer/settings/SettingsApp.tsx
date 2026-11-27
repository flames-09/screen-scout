import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { Eye, EyeOff, KeyRound, Loader2, X, CheckCircle2, AlertTriangle, Keyboard, ShieldCheck, Power, Cloud, RefreshCw, Download, Droplet } from 'lucide-react'
import type {
  AccessMode,
  AppSettings,
  ConnectionTestResult,
  HostedQuotaInfo,
  PublicSettings,
  UpdateStateSnapshot
} from '@shared/types'
import { SUGGESTED_VISION_MODELS } from '@shared/model-config'
import { HOSTED_RELAY_URL } from '@shared/hosted'
import { acceleratorFromEvent } from './shortcut-recorder'

type KeyState = 'none' | 'secure' | 'session'

/**
 * Link to a page on the hosted relay (privacy notice, terms). Opens in the
 * user's browser after an explicit confirmation dialog (app:openExternal).
 */
function RelayLink({ path, children }: { path: string; children: string }): JSX.Element {
  const url = `${HOSTED_RELAY_URL}${path}`
  return (
    <a
      href={url}
      onClick={(e) => {
        e.preventDefault()
        void window.scout.app.openExternal(url)
      }}
    >
      {children}
    </a>
  )
}

/** Settings window: NVIDIA connection, model, shortcut, startup, privacy. */
export function SettingsApp(): JSX.Element {
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [keyVisible, setKeyVisible] = useState(false)
  const [keyState, setKeyState] = useState<KeyState>('none')
  const [keyMessage, setKeyMessage] = useState<{ text: string; kind: 'ok' | 'warn' } | null>(null)
  const [modelDraft, setModelDraft] = useState('')
  const [customModel, setCustomModel] = useState(false)
  const [baseUrlDraft, setBaseUrlDraft] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)
  const [shortcutDraft, setShortcutDraft] = useState<string | null>(null)
  const [captureDraft, setCaptureDraft] = useState<string>('')
  const [peekDraft, setPeekDraft] = useState<string>('')
  const [recording, setRecording] = useState<null | 'assistant' | 'capture' | 'peek'>(null)
  const [shortcutMessage, setShortcutMessage] = useState<string | null>(null)
  const [captureMessage, setCaptureMessage] = useState<string | null>(null)
  const [diagMessage, setDiagMessage] = useState<string | null>(null)
  const [peekMessage, setPeekMessage] = useState<string | null>(null)
  const [quota, setQuota] = useState<HostedQuotaInfo | null>(null)
  const [quotaFailed, setQuotaFailed] = useState(false)

  const loadQuota = useCallback((): void => {
    void window.scout.settings
      .getHostedQuota()
      .then((value) => {
        setQuota(value)
        setQuotaFailed(value === null)
      })
      .catch(() => {
        setQuota(null)
        setQuotaFailed(true)
      })
  }, [])

  const load = useCallback((): void => {
    void window.scout.settings.get().then((s) => {
      setSettings(s)
      setKeyState(s.hasApiKey ? (s.keyStorageSecure ? 'secure' : 'session') : 'none')
      setModelDraft(s.model)
      setCustomModel(!SUGGESTED_VISION_MODELS.some((m) => m.id === s.model))
      setBaseUrlDraft(s.baseUrl)
      setShortcutDraft(s.shortcut)
      setCaptureDraft(s.captureShortcut)
      setPeekDraft(s.peekShortcut)
      if (s.hostedQuota) {
        setQuota(s.hostedQuota)
        setQuotaFailed(false)
      }
      if (s.accessMode === 'hosted' && s.hostedAvailable) loadQuota()
    })
  }, [loadQuota])

  useEffect(() => {
    load()
  }, [load])

  const [saveError, setSaveError] = useState<string | null>(null)
  const [backdrop, setBackdrop] = useState<string | null>(null)

  // Frosted-glass backdrop (desktop behind the window, sent pre-show); the
  // screenshot is dropped from memory when the window hides. Showing the
  // window also re-reads settings + quota, since it stays alive between opens.
  useEffect(() => {
    return window.scout.window.onVisibility((payload) => {
      if (payload.visible) {
        load()
      } else {
        setBackdrop(null)
        // Drop an uncommitted tint drag and restore the saved var: the var
        // effect below is keyed on value equality, so a stale preview could
        // otherwise survive into the next open.
        setTintDraft(null)
        document.documentElement.style.setProperty('--glass-tint', String(settings?.glassTint ?? 50))
      }
    })
  }, [load, settings?.glassTint])
  useEffect(() => {
    return window.scout.window.onBackdrop(setBackdrop)
  }, [])

  const guard = useCallback(async (fn: () => Promise<void>): Promise<void> => {
    try {
      setSaveError(null)
      await fn()
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Something went wrong. Try again.')
    }
  }, [])

  const setAccessMode = useCallback(
    async (mode: AccessMode): Promise<void> => {
      await guard(async () => {
        const updated = await window.scout.settings.save({ accessMode: mode })
        setSettings(updated)
        setQuota(null)
        setQuotaFailed(false)
        if (mode === 'hosted') loadQuota()
      })
    },
    [guard, loadQuota]
  )

  const saveKey = useCallback(async (): Promise<void> => {
    if (!keyDraft.trim()) return
    await guard(async () => {
      const result = await window.scout.settings.saveApiKey(keyDraft)
      setKeyDraft('')
      setKeyVisible(false)
      if (result.ok && result.secure) {
        setKeyMessage({
          text: 'Key saved on this machine — Screen Scout will remember it next time you launch it.',
          kind: 'ok'
        })
      } else if (result.message) {
        setKeyMessage({ text: result.message, kind: 'warn' })
      } else {
        setKeyMessage(null)
      }
      load()
    })
  }, [guard, keyDraft, load])

  const removeKey = useCallback(async (): Promise<void> => {
    await guard(async () => {
      await window.scout.settings.removeApiKey()
      setKeyMessage(null)
      load()
    })
  }, [guard, load])

  const testConnection = useCallback(async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.scout.settings.testConnection({
        baseUrl: baseUrlDraft.trim(),
        model: modelDraft.trim()
      })
      setTestResult(result)
    } catch (error) {
      setTestResult({
        ok: false,
        message: 'The test request could not be started.',
        detail: error instanceof Error ? error.message : undefined
      })
    } finally {
      setTesting(false)
    }
  }, [baseUrlDraft, modelDraft])

  const saveConnection = useCallback(async (): Promise<void> => {
    await guard(async () => {
      const patch: Partial<AppSettings> = {
        model: modelDraft.trim(),
        baseUrl: baseUrlDraft.trim()
      }
      const updated = await window.scout.settings.save(patch)
      setSettings(updated)
      setShortcutMessage(null)
    })
  }, [baseUrlDraft, guard, modelDraft])

  const applyShortcut = useCallback(
    async (accelerator: string, target: 'assistant' | 'capture' | 'peek'): Promise<void> => {
      await guard(async () => {
        const patch =
          target === 'assistant'
            ? { shortcut: accelerator }
            : target === 'capture'
              ? { captureShortcut: accelerator }
              : { peekShortcut: accelerator }
        const updated = await window.scout.settings.save(patch)
        setSettings(updated)
        setShortcutDraft(updated.shortcut)
        setCaptureDraft(updated.captureShortcut)
        setPeekDraft(updated.peekShortcut)
        setRecording(null)
        if (target === 'assistant') {
          setShortcutMessage(
            updated.shortcutStatus === 'failed'
              ? (updated.shortcutError ?? 'The shortcut could not be registered.')
              : null
          )
        } else if (target === 'capture') {
          setCaptureMessage(
            updated.captureShortcutStatus === 'failed'
              ? (updated.captureShortcutError ?? 'The shortcut could not be registered.')
              : null
          )
        } else {
          setPeekMessage(
            updated.peekShortcutStatus === 'failed'
              ? (updated.peekShortcutError ?? 'The shortcut could not be registered.')
              : null
          )
        }
      })
    },
    [guard]
  )

  const disableCaptureShortcut = useCallback(async (): Promise<void> => {
    await guard(async () => {
      const updated = await window.scout.settings.save({ captureShortcut: '' })
      setSettings(updated)
      setCaptureDraft('')
      setRecording(null)
      setCaptureMessage(null)
    })
  }, [guard])

  const disablePeekShortcut = useCallback(async (): Promise<void> => {
    await guard(async () => {
      const updated = await window.scout.settings.save({ peekShortcut: '' })
      setSettings(updated)
      setPeekDraft('')
      setRecording(null)
      setPeekMessage(null)
    })
  }, [guard])

  // Glass tint: publish the user's tint strength as a CSS variable so this
  // window's glass restyles live while the slider moves.
  useEffect(() => {
    if (typeof settings?.glassTint === 'number') {
      document.documentElement.style.setProperty('--glass-tint', String(settings.glassTint))
    }
  }, [settings?.glassTint])

  /** Slider position while dragging (null = resting on the saved value). */
  const [tintDraft, setTintDraft] = useState<number | null>(null)
  const [zoomDraft, setZoomDraft] = useState<number | null>(null)

  const saveTint = useCallback(
    async (value: number): Promise<void> => {
      let committed = false
      await guard(async () => {
        const updated = await window.scout.settings.save({ glassTint: value })
        setSettings(updated)
        committed = true
      })
      // Release the draft only after the save resolves: clearing it early
      // makes the thumb flick back to the saved value mid-save.
      setTintDraft(null)
      if (!committed) {
        // Save failed: snap the preview var back to the saved value so the
        // DOM can't desync from settings (the var effect skips equal values).
        document.documentElement.style.setProperty('--glass-tint', String(settings?.glassTint ?? 50))
      }
    },
    [guard, settings?.glassTint]
  )

  const saveZoom = useCallback(
    async (percent: number): Promise<void> => {
      await guard(async () => {
        const updated = await window.scout.settings.save({ zoom: Math.round(percent) / 100 })
        setSettings(updated)
      })
      setZoomDraft(null)
    },
    [guard]
  )

  const toggleStartup = useCallback(async (): Promise<void> => {
    if (!settings) return
    await guard(async () => {
      const updated = await window.scout.settings.save({ launchOnStartup: !settings.launchOnStartup })
      setSettings(updated)
    })
  }, [guard, settings])

  // --- Updates -----------------------------------------------------------------
  // State arrives from the main process (initial fetch + push on every change),
  // so the section always reflects the real service phase, including auto-checks.
  const [updateSnapshot, setUpdateSnapshot] = useState<UpdateStateSnapshot | null>(null)
  useEffect(() => {
    let alive = true
    void window.scout.updates.state().then((snapshot) => {
      if (alive) setUpdateSnapshot(snapshot)
    })
    const off = window.scout.updates.onState((snapshot) => setUpdateSnapshot(snapshot))
    return () => {
      alive = false
      off()
    }
  }, [])

  const updatePhase = updateSnapshot?.phase.kind ?? 'idle'
  const updatesBusy = updatePhase === 'checking' || updatePhase === 'downloading'

  const updateStatusText = ((): string => {
    const phase = updateSnapshot?.phase
    if (!phase || !updateSnapshot?.updatesAvailable) {
      return 'Updates are not configured in this build.'
    }
    const current = `Version ${updateSnapshot.appVersion}`
    switch (phase.kind) {
      case 'checking':
        return 'Checking for updates…'
      case 'current':
        return `You're up to date (version ${phase.version}).`
      case 'available':
        return `Update available: version ${phase.version}.`
      case 'downloading':
        return `Downloading update… ${phase.percent}%`
      case 'verified': {
        // Accuracy: install-on-quit is Windows-only and only while auto
        // updates are on; mac installs via the DMG, disabled auto-updates
        // install via the button.
        if (!(settings?.updatesEnabled ?? true)) {
          return `Version ${phase.version} downloaded and verified — choose Install update.`
        }
        return navigator.platform.startsWith('Mac')
          ? `Version ${phase.version} downloaded and verified — open the downloaded DMG to install.`
          : `Version ${phase.version} downloaded and verified — it installs automatically when you quit.`
      }
      case 'installing':
        return 'Installing… Screen Scout will restart.'
      case 'error':
        return phase.message
      default:
        return current
    }
  })()

  // Shortcut recording: capture the next keydown for whichever row is recording.
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const result = acceleratorFromEvent(e)
      if (result.ok && result.accelerator) {
        void applyShortcut(result.accelerator, recording)
      } else if (result.reason) {
        if (recording === 'assistant') setShortcutMessage(result.reason)
        else if (recording === 'capture') setCaptureMessage(result.reason)
        else setPeekMessage(result.reason)
        if (result.cancelled) setRecording(null)
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true } as EventListenerOptions)
  }, [recording, applyShortcut])

  const isSuggested = SUGGESTED_VISION_MODELS.some((m) => m.id === modelDraft)

  const [accountMessage, setAccountMessage] = useState<string | null>(null)

  const handleGoogleSignIn = useCallback(async (): Promise<void> => {
    setAccountMessage(null)
    try {
      const result = await window.scout.settings.hostedSignInWithGoogle()
      if (result.ok) {
        load()
        if (result.persisted === false) {
          setAccountMessage("Secure storage is unavailable — you'll need to sign in again after restarting.")
        }
      } else {
        setAccountMessage(result.message ?? 'Google sign-in failed.')
      }
    } catch (error) {
      setAccountMessage(error instanceof Error ? error.message : 'Google sign-in failed.')
    }
  }, [load])

  const handleSignOut = useCallback(async (): Promise<void> => {
    setAccountMessage(null)
    try {
      await window.scout.settings.hostedSignOut()
      load()
    } catch (error) {
      setAccountMessage(error instanceof Error ? error.message : 'Sign-out failed.')
    }
  }, [load])

  // Removes the account (or device) record and all usage counters from the
  // relay, then signs out. Nothing is deleted from the Google account itself.
  const handleDeleteAccount = useCallback(async (): Promise<void> => {
    setAccountMessage(null)
    try {
      // Native dialog via main: renderer window.confirm() loses focus (electron#19977).
      if (!(await window.scout.settings.confirmDeleteData())) return
      const result = await window.scout.settings.hostedDeleteAccount()
      if (result.ok) {
        setAccountMessage('Deleted your data on the relay. A fresh record starts on next use.')
        load()
      } else {
        setAccountMessage(result.message ?? 'Deletion failed.')
      }
    } catch (error) {
      setAccountMessage(error instanceof Error ? error.message : 'Deletion failed.')
    }
  }, [load])

  const quotaSummary = quota
    ? quota.kind === 'account'
      ? `${quota.quota.imagesRemaining} of ${quota.quota.imagesLimit} screenshots and ${quota.quota.chatsRemaining} of ${quota.quota.chatsLimit} chats left today`
      : `${quota.quota.dayRemaining} of ${quota.quota.dayLimit} questions left today · ${quota.quota.windowRemaining} of ${quota.quota.windowLimit} in this window`
    : quotaFailed
      ? 'Free quota is unavailable right now — the relay did not answer.'
      : 'Checking your free quota…'
  const quotaReset = quota
    ? quota.kind === 'account'
      ? `Resets at ${new Date(quota.quota.dayResetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (midnight UTC).`
      : `Today resets at ${new Date(quota.quota.dayResetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}; this window at ${new Date(quota.quota.windowResetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
    : ''

  return (
    <div className="glass-root settings-root">
      {backdrop && (
        <div
          className="glass-backdrop"
          style={{ ['--backdrop-image' as string]: `url("${backdrop}")` } as CSSProperties}
          aria-hidden="true"
        />
      )}
      <header className="app-header">
        <div className="header-drag settings-title-drag">
          <span className="header-name">Settings</span>
          <span className="chip">Screen Scout</span>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="icon-btn danger"
            onClick={() => void window.scout.window.hide()}
            aria-label="Close settings"
            title="Close"
          >
            <X size={15} strokeWidth={2.2} />
          </button>
        </div>
      </header>

      <div className="settings-scroll">
        {saveError && <div className="settings-note warn" role="alert">{saveError}</div>}

        {/* ---------------------------------------------------- Access mode */}
        {settings && (settings.hostedAvailable || settings.accessMode === 'hosted') && (
          <section className="settings-section">
            <h2 className="settings-heading">
              <Cloud size={13} strokeWidth={2} />
              Access
            </h2>
            {!settings.hostedAvailable && (
              <div className="settings-note warn">
                Free hosted mode isn&apos;t available in this build. Choose your own NVIDIA key to keep asking
                questions.
              </div>
            )}
            <div className="access-options" role="radiogroup" aria-label="Access mode">
              {settings.hostedAvailable && (
                <button
                  type="button"
                  role="radio"
                  aria-checked={settings.accessMode === 'hosted'}
                  className={`access-card ${settings.accessMode === 'hosted' ? 'active' : ''}`}
                  onClick={() => void setAccessMode('hosted')}
                >
                  <span className="access-title">Free hosted mode</span>
                  <span className="access-desc">
                    No API key needed. Questions go through Screen Scout&apos;s relay and are answered by a
                    free-tier vision model. Limited per device.
                  </span>
                </button>
              )}
              <button
                type="button"
                role="radio"
                aria-checked={settings.accessMode === 'byok'}
                className={`access-card ${settings.accessMode === 'byok' ? 'active' : ''}`}
                onClick={() => void setAccessMode('byok')}
              >
                <span className="access-title">My own NVIDIA key</span>
                <span className="access-desc">
                  The app talks directly to NVIDIA with the key stored on this machine. The relay is never
                  contacted.
                </span>
              </button>
            </div>
            {settings.hostedAvailable && settings.accessMode === 'hosted' && (
              <div className="quota-meter" role="status" aria-live="polite">
                <div className="quota-line">{quotaSummary}</div>
                {quotaReset && <div className="quota-reset">{quotaReset}</div>}
              </div>
            )}
            {settings.hostedAvailable && (
              <div className="account-row">
                <span className="account-email">
                  {settings.authMethod === 'google'
                    ? `Google account: ${settings.authEmail || 'signed in'}`
                    : 'Anonymous device (no sign-in)'}
                </span>
                {settings.authMethod === 'google' ? (
                  <button type="button" className="btn" onClick={() => void handleSignOut()}>
                    Sign out
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void handleGoogleSignIn()}
                    title="Sign in with Google for higher free limits (5 screenshots and 50 chats per day, per account)"
                  >
                    Sign in with Google
                  </button>
                )}
              </div>
            )}
            {settings.hostedAvailable && (
              <div className="account-row">
                <span className="account-email">
                  <RelayLink path="/guidelines">Safety guidelines</RelayLink>
                  {' · includes crisis resources'}
                </span>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void handleDeleteAccount()}
                  title="Delete the account/device record and all usage counters stored on the relay"
                >
                  Delete my data on the relay
                </button>
              </div>
            )}
            {accountMessage && (
              <div className="settings-note warn" role="alert">
                {accountMessage}
              </div>
            )}
            {settings.accessMode === 'byok' && (
              <div className="settings-note">Using your own key — the key section below applies to this mode.</div>
            )}
          </section>
        )}

        {/* ---------------------------------------------- NVIDIA connection */}
        <section className="settings-section">
          <h2 className="settings-heading">
            <KeyRound size={13} strokeWidth={2} />
            NVIDIA API key
          </h2>
          <div className="settings-note">
            The key is stored encrypted on this machine with Windows secure storage (DPAPI) — never in
            plaintext, never in the chat window, never in logs. Screen Scout remembers it across
            restarts until you press <strong>Remove key</strong>.
          </div>
          <div className="key-row">
            <input
              className="text-input"
              type={keyVisible ? 'text' : 'password'}
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder="nvapi-…"
              aria-label="NVIDIA API key"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="icon-btn"
              onClick={() => setKeyVisible((v) => !v)}
              aria-label={keyVisible ? 'Hide key' : 'Show key'}
              title={keyVisible ? 'Hide' : 'Show'}
              disabled={!keyDraft}
            >
              {keyVisible ? <EyeOff size={14} strokeWidth={2} /> : <Eye size={14} strokeWidth={2} />}
            </button>
          </div>
          <div className="settings-row">
            <button type="button" className="btn btn-primary" onClick={() => void saveKey()} disabled={!keyDraft.trim()}>
              Save key securely
            </button>
            <button type="button" className="btn btn-danger" onClick={() => void removeKey()} disabled={keyState === 'none'}>
              Remove key
            </button>
          </div>
          <div className={`key-status ${keyState}`}>
            <span className="dot idle" />
            {keyState === 'secure' &&
              'Key saved on this machine — protected by OS-backed secure storage and remembered across restarts.'}
            {keyState === 'session' &&
              'Key kept in memory for this session only (OS encryption unavailable) — it will be forgotten when Screen Scout quits.'}
            {keyState === 'none' && 'No key saved yet.'}
          </div>
          {keyMessage && (
            <div className={`settings-note ${keyMessage.kind}`} role="status">
              {keyMessage.text}
            </div>
          )}
        </section>

        {/* ---------------------------------------------- Model & endpoint */}
        <section className="settings-section">
          <h2 className="settings-heading">
            <CheckCircle2 size={13} strokeWidth={2} />
            Vision model
          </h2>
          <div className="settings-note">
            Suggested models accept image input on the NVIDIA API Catalog — press <strong>Test connection</strong> to
            verify against your account.
          </div>
          <select
            className="text-input"
            value={isSuggested ? modelDraft : '__custom'}
            onChange={(e) => {
              if (e.target.value === '__custom') {
                setCustomModel(true)
                setModelDraft('')
              } else {
                setCustomModel(false)
                setModelDraft(e.target.value)
              }
            }}
            aria-label="Model"
          >
            {SUGGESTED_VISION_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} — {m.id}
              </option>
            ))}
            <option value="__custom">Custom model ID…</option>
          </select>
          {customModel && (
            <input
              className="text-input"
              value={modelDraft}
              onChange={(e) => setModelDraft(e.target.value)}
              placeholder="org/model-name"
              aria-label="Custom model id"
              spellCheck={false}
            />
          )}
          <label className="settings-label" htmlFor="endpoint">
            Chat-completions endpoint
          </label>
          <input
            id="endpoint"
            className="text-input"
            value={baseUrlDraft}
            onChange={(e) => setBaseUrlDraft(e.target.value)}
            spellCheck={false}
            aria-label="Endpoint URL"
          />
          <div className="settings-row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void saveConnection()}
              disabled={!modelDraft.trim() || !baseUrlDraft.trim()}
            >
              Save model
            </button>
            <button type="button" className="btn" onClick={() => void testConnection()} disabled={testing || !modelDraft.trim()}>
              {testing ? <Loader2 size={13} className="spin" strokeWidth={2} /> : null}
              {testing ? 'Testing…' : 'Test connection'}
            </button>
          </div>
          {testResult && (
            <div className={`test-result ${testResult.ok ? 'ok' : 'fail'}`} role="status">
              {testResult.ok ? <CheckCircle2 size={14} strokeWidth={2} /> : <AlertTriangle size={14} strokeWidth={2} />}
              <div>
                <div>{testResult.message}</div>
                {testResult.detail && <div className="test-detail">{testResult.detail}</div>}
              </div>
            </div>
          )}
        </section>

        {/* ---------------------------------------------- Shortcut */}
        <section className="settings-section">
          <h2 className="settings-heading">
            <Keyboard size={13} strokeWidth={2} />
            Global shortcuts
          </h2>
          <div className="settings-note">
            Work from any application. Default: <strong>Shift+R</strong> opens or hides the assistant,{' '}
            <strong>Shift+C</strong> jumps straight to a new screen capture.
          </div>
          <div className="shortcut-row">
            <span className="shortcut-display glass-inset">{shortcutDraft ?? '…'}</span>
            <button
              type="button"
              className="btn"
              onClick={() => setRecording('assistant')}
              disabled={recording !== null}
            >
              {recording === 'assistant' ? 'Press a key combination…' : 'Change shortcut'}
            </button>
            {recording === 'assistant' && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setRecording(null)
                  setShortcutMessage(null)
                }}
              >
                Cancel
              </button>
            )}
          </div>
          {shortcutMessage && <div className="settings-note warn">{shortcutMessage}</div>}
          {settings && settings.shortcutStatus === 'failed' && !shortcutMessage && (
            <div className="settings-note warn">{settings.shortcutError}</div>
          )}
          <div className="shortcut-row capture-row">
            <span className="shortcut-display glass-inset">{captureDraft === '' ? 'Off' : captureDraft}</span>
            <button
              type="button"
              className="btn"
              onClick={() => setRecording('capture')}
              disabled={recording !== null}
              title="Capture a screen region without opening the popup first"
            >
              {recording === 'capture' ? 'Press a key combination…' : 'Change capture shortcut'}
            </button>
            {recording === 'capture' && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setRecording(null)
                  setCaptureMessage(null)
                }}
              >
                Cancel
              </button>
            )}
            {captureDraft !== '' && (
              <button type="button" className="btn btn-ghost" onClick={() => void disableCaptureShortcut()} disabled={recording !== null}>
                Disable
              </button>
            )}
          </div>
          {captureMessage && <div className="settings-note warn">{captureMessage}</div>}
          {settings && settings.captureShortcutStatus === 'failed' && !captureMessage && (
            <div className="settings-note warn">{settings.captureShortcutError}</div>
          )}
          {settings && settings.captureShortcutStatus === 'disabled' && !captureMessage && (
            <div className="settings-note">The direct-capture shortcut is currently off.</div>
          )}
          <div className="shortcut-row capture-row">
            <span className="shortcut-display glass-inset">{peekDraft === '' ? 'Off' : peekDraft}</span>
            <button
              type="button"
              className="btn"
              onClick={() => setRecording('peek')}
              disabled={recording !== null}
              title="Hide without clearing — reopen exactly where you left off"
            >
              {recording === 'peek' ? 'Press a key combination…' : 'Change peek shortcut'}
            </button>
            {recording === 'peek' && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setRecording(null)
                  setPeekMessage(null)
                }}
              >
                Cancel
              </button>
            )}
            {peekDraft !== '' && (
              <button type="button" className="btn btn-ghost" onClick={() => void disablePeekShortcut()} disabled={recording !== null}>
                Disable
              </button>
            )}
          </div>
          {peekMessage && <div className="settings-note warn">{peekMessage}</div>}
          {settings && settings.peekShortcutStatus === 'failed' && !peekMessage && (
            <div className="settings-note warn">{settings.peekShortcutError}</div>
          )}
          {settings && settings.peekShortcutStatus === 'disabled' && !peekMessage && (
            <div className="settings-note">The peek shortcut is currently off.</div>
          )}
        </section>

        {/* ---------------------------------------------- Startup */}
        <section className="settings-section">
          <h2 className="settings-heading">
            <Power size={13} strokeWidth={2} />
            Startup
          </h2>
          <label className="toggle-row">
            <input
              type="checkbox"
              className="toggle-input"
              checked={settings?.launchOnStartup ?? false}
              onChange={() => void toggleStartup()}
              disabled={!settings}
            />
            <span className="toggle-track" aria-hidden="true">
              <span className="toggle-thumb" />
            </span>
            <span className="toggle-label">
              Launch Screen Scout when you sign in
              <span className="toggle-sub">Runs quietly in the tray; no window opens.</span>
            </span>
          </label>
        </section>

        {/* ---------------------------------------------- Appearance */}
        <section className="settings-section">
          <h2 className="settings-heading">
            <Droplet size={13} strokeWidth={2} />
            Appearance
          </h2>
          <label className="toggle-label" htmlFor="tint-slider">
            Liquid glass tint
            <span className="toggle-sub">How dark the frosted glass sits over your desktop.</span>
          </label>
          <div className="slider-line">
            <input
              id="tint-slider"
              type="range"
              className="tint-slider"
              data-testid="tint-slider"
              min={0}
              max={100}
              step={1}
              value={tintDraft ?? (settings?.glassTint ?? 50)}
              onInput={(e) => {
                const value = Number((e.target as HTMLInputElement).value)
                setTintDraft(value)
                // Live preview without touching settings — commit happens on release.
                document.documentElement.style.setProperty('--glass-tint', String(value))
              }}
              onPointerUp={(e) => void saveTint(Number((e.target as HTMLInputElement).value))}
              onPointerCancel={(e) => void saveTint(Number((e.target as HTMLInputElement).value))}
              onKeyUp={(e) => void saveTint(Number((e.target as HTMLInputElement).value))}
              disabled={!settings}
            />
            <span className="slider-value" data-testid="tint-value">
              {tintDraft ?? (settings?.glassTint ?? 50)}
            </span>
          </div>

          <label className="toggle-label" htmlFor="zoom-slider">
            Assistant zoom
            <span className="toggle-sub">How large the popup content renders.</span>
          </label>
          <div className="slider-line">
            <input
              id="zoom-slider"
              type="range"
              className="tint-slider"
              data-testid="zoom-slider"
              min={70}
              max={160}
              step={5}
              value={zoomDraft ?? Math.round((settings?.zoom ?? 1) * 100)}
              onInput={(e) => setZoomDraft(Number((e.target as HTMLInputElement).value))}
              onPointerUp={(e) => void saveZoom(Number((e.target as HTMLInputElement).value))}
              onPointerCancel={(e) => void saveZoom(Number((e.target as HTMLInputElement).value))}
              onKeyUp={(e) => void saveZoom(Number((e.target as HTMLInputElement).value))}
              disabled={!settings}
            />
            <span className="slider-value" data-testid="zoom-value">
              {zoomDraft ?? Math.round((settings?.zoom ?? 1) * 100)}%
            </span>
          </div>
        </section>

        {/* ---------------------------------------------- Updates */}
        <section className="settings-section">
          <h2 className="settings-heading">
            <RefreshCw size={13} strokeWidth={2} />
            Updates
          </h2>
          <div className="settings-note" data-testid="updates-status">
            {updateStatusText}
          </div>
          <div className="settings-row">
            <button
              type="button"
              className="btn"
              data-testid="updates-check"
              onClick={() => void window.scout.updates.check()}
              disabled={updatesBusy || !updateSnapshot?.updatesAvailable}
            >
              Check for updates
            </button>
            {updatePhase === 'available' && (
              <button
                type="button"
                className="btn btn-primary"
                data-testid="updates-download"
                onClick={() => void window.scout.updates.download()}
                disabled={updatesBusy}
              >
                <Download size={13} strokeWidth={2} />
                Download update
              </button>
            )}
            {updatePhase === 'verified' && (
              <button
                type="button"
                className="btn btn-primary"
                data-testid="updates-install"
                onClick={() => void window.scout.updates.install()}
              >
                Install update
              </button>
            )}
          </div>
          <label className="toggle-row">
            <input
              type="checkbox"
              className="toggle-input"
              checked={settings?.updatesEnabled ?? true}
              onChange={async () => {
                if (!settings) return
                await guard(async () => {
                  const updated = await window.scout.settings.save({ updatesEnabled: !settings.updatesEnabled })
                  setSettings(updated)
                })
              }}
              disabled={!settings}
            />
            <span className="toggle-track" aria-hidden="true">
              <span className="toggle-thumb" />
            </span>
            <span className="toggle-label">
              Check for updates automatically
              <span className="toggle-sub">
                New versions download in the background and install when Screen Scout quits (automatic on Windows).
                Checks at launch and every 6 hours.
              </span>
            </span>
          </label>
        </section>

        {/* ---------------------------------------------- Privacy */}
        <section className="settings-section">
          <h2 className="settings-heading">
            <ShieldCheck size={13} strokeWidth={2} />
            Privacy
          </h2>
          <div className="settings-note">
            {settings?.accessMode === 'hosted' ? (
              <>
                When you press <strong>Send</strong>, the selected screenshot crop and your question are sent
                to Screen Scout&apos;s relay and forwarded to a free-tier model provider (NVIDIA, Cloudflare,
                or Groq). Nothing is uploaded
                before that, no account is created, and the relay stores no screenshots or prompts — only an
                anonymous device id and usage counters. Prefer direct access? Choose{' '}
                <strong>My own NVIDIA key</strong> above.
                <br />
                <RelayLink path="/privacy">Hosted privacy notice</RelayLink>
                {' · '}
                <RelayLink path="/terms">hosted terms</RelayLink>
              </>
            ) : (
              <>
                When you press <strong>Send</strong>, the selected screenshot crop and your question are sent
                to the configured NVIDIA endpoint. Nothing is uploaded before that. Screen Scout never
                captures in the background, keeps conversations in memory only, and discards the capture
                when the popup closes.
              </>
            )}
          </div>
          <div className="settings-row">
            <button
              type="button"
              className="btn"
              data-testid="logs-open"
              onClick={() => void window.scout.app.openLogs()}
            >
              Open log folder
            </button>
            <button
              type="button"
              className="btn"
              data-testid="diagnostics-copy"
              onClick={async () => {
                const result = await window.scout.app.copyDiagnostics()
                setDiagMessage(result.ok ? 'Diagnostics copied to the clipboard.' : (result.message ?? 'Could not copy diagnostics.'))
              }}
            >
              Copy diagnostics
            </button>
          </div>
          {diagMessage && <div className="settings-note ok">{diagMessage}</div>}
        </section>
      </div>
    </div>
  )
}
