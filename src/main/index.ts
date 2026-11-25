import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, safeStorage, shell } from 'electron'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type {
  GoogleSignInResult,
  AppSettings,
  HostedQuotaInfo,
  ImageImportResult,
  PublicSettings,
  SendMessageResult
} from '@shared/types'
import { HOSTED_GOOGLE_CLIENT_ID, HOSTED_RELAY_URL } from '@shared/hosted'
import {
  apiKeySchema,
  openExternalSchema,
  requestIdSchema,
  resizeSchema,
  sendMessageSchema,
  testConnectionSchema,
  formatZodError
} from '@shared/schemas'
import { SettingsStore, assertSettingsPatch } from './settings/settings-store'
import { SecretStore } from './security/secrets'
import { ChatService } from './ai/chat-service'
import { HostedClient } from './ai/hosted-client'
import { GoogleAuthManager } from './ai/google-auth-manager'
import { UpdateService, type UpdatePhase } from './updates/update-service'
import { Logger } from './logging/logger'
import { startE2eRelay, type E2eRelayHandle } from './e2e-relay'
import { CaptureService } from './capture/capture-service'
import { captureBackdrop } from './backdrop'
import { importClipboardImage, importImageBytes } from './images/image-import'
import { ShortcutManager } from './shortcuts'
import {
  ASSISTANT_MIN,
  ASSISTANT_MAX,
  createAssistantWindow,
  createSettingsWindow,
  createOverlayWindow,
  placeOnPointerDisplayCorner
} from './windows'
import { createTray } from './tray'
import { runE2eTest, setupE2eSurveillance } from './e2e'

/**
 * Screen Scout — background lifecycle + IPC wiring.
 *
 * The app starts into the tray (no foreground window). `Shift+R` (editable)
 * toggles a compact always-on-top glass assistant. Closing the popup only
 * hides it and discards the unsent crop; quitting from the tray fully
 * unregisters the shortcut and disposes of everything.
 */

const SMOKE_TEST = process.argv.includes('--smoke-test')
const INTEGRATION_TEST = process.argv.includes('--integration-test')
const E2E_TEST = process.argv.includes('--e2e')

// E2E drives the real app end-to-end, but in an ISOLATED userData dir so the
// user's real key and settings are never touched — and so the E2E instance
// can run while the user's own instance is live (its own single-instance lock).
if (E2E_TEST) {
  // Anchored to the app dir (not cwd) so launches from any shell land in the
  // same place; fresh state every run — a leftover key would change the paths
  // under test (e.g. a saved fake key turns the no-key error into a 401).
  const e2eDir = path.join(app.getAppPath(), '.e2e-userdata')
  try {
    fs.rmSync(e2eDir, { recursive: true, force: true })
    fs.mkdirSync(e2eDir, { recursive: true })
    app.setPath('userData', e2eDir)
  } catch (error) {
    // A zombie process from a crashed run can hold the dir (EBUSY/EPERM on
    // Windows). Fall back to a unique dir rather than dying without diagnostics.
    const fallback = `${e2eDir}-${process.pid}`
    console.error(`E2E_SETUP_FAILED on ${e2eDir} (${error instanceof Error ? error.message : error}); using ${fallback}`)
    fs.mkdirSync(fallback, { recursive: true })
    app.setPath('userData', fallback)
  }
}

// `--persistence-test=<save|check|clear>` probes API-key persistence across
// real process restarts, in an ISOLATED userData dir so the user's actual
// key is never touched. Must run before the single-instance lock is keyed.
const PERSISTENCE_ARG = process.argv.find((a) => a.startsWith('--persistence-test='))
const PERSISTENCE_PHASE = PERSISTENCE_ARG ? PERSISTENCE_ARG.split('=')[1] : undefined
const PERSISTENCE_PROBE_KEY = 'nvapi-persistence-probe-0123456789abcdef-DO-NOT-USE'
if (PERSISTENCE_PHASE) {
  const probeDir = path.join(app.getAppPath(), '.persistence-test-userdata')
  fs.mkdirSync(probeDir, { recursive: true })
  app.setPath('userData', probeDir)
}

// --- Single instance guard -------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  bootstrap()
}

function bootstrap(): void {
  app.setAppUserModelId('com.screenscout.app')
  app.setName('Screen Scout')

  let assistantWindow: BrowserWindow | null = null
  let settingsWindow: BrowserWindow | null = null
  let tray: Electron.Tray | null = null
  let quitting = false

  const settingsStore = new SettingsStore(
    {
      existsSync: (p) => fs.existsSync(p),
      readFileSync: (p) => fs.readFileSync(p, 'utf8'),
      writeFileSync: (p, data) => fs.writeFileSync(p, data),
      mkdirSync: (d) => fs.mkdirSync(d, { recursive: true })
    },
    path.join(app.getPath('userData'), 'settings.json')
  )
  const secrets = new SecretStore()

  // --- Logging & crash reporting (local files only, opt-in telemetry later) ---
  // Only developer-defined event strings and error messages are logged here —
  // never prompts, screenshots, keys, or device ids (see logging/logger.ts).
  const logger = new Logger({ logDir: path.join(app.getPath('userData'), 'logs') })
  logger.info(`screen scout ${app.getVersion()} starting (electron ${process.versions.electron})`)

  let crashDialogShown = false
  process.on('uncaughtException', (error) => {
    logger.error(`uncaughtException: ${error.stack ?? error.message}`)
    if (crashDialogShown) return
    crashDialogShown = true
    void dialog
      .showMessageBox({
        type: 'error',
        title: 'Screen Scout',
        message: 'Something went wrong',
        detail: 'An internal error occurred, but Screen Scout keeps running in the tray. Details were written to the log folder (Settings → Privacy → Open log folder).',
        buttons: ['OK']
      })
      .catch(() => undefined)
  })
  process.on('unhandledRejection', (reason) => {
    logger.error(`unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`)
  })
  app.on('render-process-gone', (_event, webContents, details) => {
    if (details.reason === 'clean-exit') return
    logger.error(`render-process-gone (${details.reason}): ${webContents.getURL() || 'about:blank'}`)
    // A crashed popup/settings window is recreated on next show; drop the
    // stale reference so ensureAssistant()/openSettings() build fresh ones.
    if (assistantWindow && webContents === assistantWindow.webContents) {
      assistantWindow.destroy()
      assistantWindow = null
    } else if (settingsWindow && webContents === settingsWindow.webContents) {
      settingsWindow.destroy()
      settingsWindow = null
    } else {
      // A crashed selection overlay is not tracked here: cancel the active
      // capture so the dead overlay is destroyed and selections unblock.
      captureService.cancelIfActive()
    }
  })
  app.on('child-process-gone', (_event, details) => {
    // Renderers surface through 'render-process-gone' above; this catches the
    // auxiliary processes (GPU, utility, zygote) dying unexpectedly.
    logger.warn(`child-process-gone (${details.type}, ${details.reason})`)
  })

  // --- Hosted free tier ------------------------------------------------------
  // The relay URL is baked in at release time; the env override exists for the
  // E2E suite and local relay development. An empty URL hides hosted mode.
  const relayUrl = (): string => {
    const override = (process.env.SCREEN_SCOUT_RELAY_URL ?? '').trim()
    return (override || HOSTED_RELAY_URL).trim()
  }

  let hostedQuotaCache: HostedQuotaInfo | null = null

  const ensureDeviceId = (): string => {
    const existing = settingsStore.load().deviceId
    if (existing) return existing
    // Random, URL-safe, no PII — only used to count questions per install.
    const id = randomUUID().replace(/-/g, '')
    settingsStore.update({ deviceId: id })
    return id
  }

  /**
   * Upgrades from a pre-hosted build: an install that already has a working
   * BYOK key keeps it; everyone else gets the build's default mode.
   */
  const migrateAccessMode = (): void => {
    try {
      const file = path.join(app.getPath('userData'), 'settings.json')
      if (!fs.existsSync(file)) return
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
      if (!raw || typeof raw !== 'object') return
      // A build (or a `--clear` run) without a relay URL must not leave the app
      // permanently stuck in hosted mode: fall back to BYOK, where the key
      // controls are always visible.
      if (raw.accessMode === 'hosted' && relayUrl() === '') {
        settingsStore.update({ accessMode: 'byok' })
        return
      }
      if (raw.accessMode !== undefined) return
      if (secrets.getApiKey()) settingsStore.update({ accessMode: 'byok' })
    } catch {
      // Unreadable settings fall back to defaults; nothing to migrate.
    }
  }

  migrateAccessMode()
  ensureDeviceId()
  if (E2E_TEST || INTEGRATION_TEST) {
    // Test harnesses must be deterministic AND must never touch the production
    // relay: BYOK mode keeps the legacy no-key assertions meaningful (the E2E
    // hosted section switches mode explicitly through the real Settings UI).
    settingsStore.update({ accessMode: 'byok' })
  }

  /**
   * Upgrades from a pre-onboarding build: installs that already used the app
   * keep working without a forced gate — they land as anonymous + onboarded,
   * and see the dismissible "sign in for more" nudge instead.
   */
  const migrateOnboarding = (): void => {
    if (E2E_TEST || INTEGRATION_TEST) {
      settingsStore.update({ onboarded: true })
      return
    }
    try {
      const file = path.join(app.getPath('userData'), 'settings.json')
      if (!fs.existsSync(file)) return
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
      if (raw && typeof raw === 'object' && raw.onboarded === undefined) {
        settingsStore.update({ onboarded: true })
      }
    } catch {
      // Unreadable settings fall back to defaults; nothing to migrate.
    }
  }
  migrateOnboarding()

  // E2E: Google sign-in is driven without a real browser or network. The fake
  // openExternal parses the flow's loopback auth URL and "completes" consent by
  // fetching the redirect with a synthetic code; the token exchange is answered
  // locally with a fake JWT. Nothing here reaches Google.
  const e2eGoogleOpenExternal = async (url: string): Promise<void> => {
    try {
      const parsed = new URL(url)
      const redirect = parsed.searchParams.get('redirect_uri') ?? ''
      const state = parsed.searchParams.get('state') ?? ''
      if (redirect) {
        await net.fetch(`${redirect}?code=e2e-fake-code&state=${encodeURIComponent(state)}`)
      }
    } catch {
      // The flow surfaces its own timeout/errors; nothing to log here.
    }
  }
  const e2eFakeIdToken = (): string => {
    const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url')
    return [
      b64({ alg: 'none', typ: 'JWT' }),
      b64({
        sub: 'e2e-sub-1',
        email: 'e2e-tester@screenscout.test',
        exp: Math.floor(Date.now() / 1000) + 3600
      }),
      'sig'
    ].join('.')
  }
  const e2eGoogleTokenFetch = async (
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string }
  ): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> => {
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id_token: e2eFakeIdToken(),
          refresh_token: 'e2e-refresh-token',
          access_token: 'e2e-access-token'
        })
      }
    }
    return net.fetch(url, init) as unknown as Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
  }

  // --- Google account sign-in (free tier with higher, per-account limits) ----
  // The refresh token lives in the OS secure store; only short-lived id tokens
  // ever touch memory. The manager is created before HostedClient so hosted
  // registration can pull a fresh id token when authMethod is 'google'.
  const googleAuth = new GoogleAuthManager({
    clientId: () => HOSTED_GOOGLE_CLIENT_ID,
    getRefreshToken: () => secrets.getGoogleRefreshToken(),
    saveRefreshToken: (token) => {
      const result = secrets.saveGoogleRefreshToken(token)
      return result.secure
    },
    clearRefreshToken: () => secrets.removeGoogleRefreshToken(),
    openExternal: E2E_TEST
      ? e2eGoogleOpenExternal
      : (url) => {
          void shell.openExternal(url)
        },
    fetchImpl: E2E_TEST
      ? e2eGoogleTokenFetch
      : (url, init) =>
          net.fetch(url, init) as unknown as Promise<{
            ok: boolean
            status: number
            json(): Promise<unknown>
          }>
  })

  const hostedClient = new HostedClient({
    relayUrl,
    deviceId: ensureDeviceId,
    getStoredToken: () => secrets.getDeviceToken(),
    saveToken: (token) => {
      secrets.saveDeviceToken(token)
    },
    clearToken: () => secrets.removeDeviceToken(),
    appVersion: () => app.getVersion(),
    authMode: () => {
      const s = settingsStore.load()
      return googleAuth.isConfigured() && s.authMethod === 'google' ? 'google' : 'anonymous'
    },
    getGoogleIdToken: (signal) => googleAuth.getIdToken(signal)
  })

  // --- Update feed ------------------------------------------------------------
  // Served by the relay under /updates (same host as hosted mode, same
  // runtime override for the E2E mock). An empty relay URL disables updates.
  // The feed currently points at the Windows installer, so on macOS the
  // feature stays off rather than offering the wrong binary. Revisit when
  // the manifest becomes per-platform.
  const updateFeedUrl = (): string => (process.platform === 'win32' ? relayUrl() : '')
  const updateStateSnapshot = (): { phase: UpdatePhase; appVersion: string; updatesAvailable: boolean } => ({
    phase: updateService.currentPhase(),
    appVersion: app.getVersion(),
    updatesAvailable: updateFeedUrl() !== ''
  })
  const broadcastUpdateState = (): void => {
    const snapshot = updateStateSnapshot()
    for (const win of [assistantWindow, settingsWindow]) {
      if (win && !win.isDestroyed()) win.webContents.send('updates:state', snapshot)
    }
  }
  const updateService = new UpdateService({
    fetch: (input, init) => net.fetch(input, init) as unknown as Promise<{ ok: boolean; status: number }>,
    baseUrl: updateFeedUrl,
    currentVersion: () => app.getVersion(),
    tempDir: () => app.getPath('temp'),
    joinPath: (...parts) => path.join(...parts),
    fs: {
      createWriteStream: (p) => fs.createWriteStream(p),
      unlink: (p) => fs.unlinkSync(p),
      exists: (p) => fs.existsSync(p)
    },
    spawn: (file, args) => spawn(file, args, { detached: true, stdio: 'ignore' }),
    onState: (phase) => {
      if (phase.kind === 'available') logger.info(`update available: ${phase.version}`)
      else if (phase.kind === 'verified') logger.info(`update verified: ${phase.version}`)
      else if (phase.kind === 'error') logger.warn(`update: ${phase.message}`)
      broadcastUpdateState()
    }
  })

  const shortcuts = new ShortcutManager()
  // The direct-capture shortcut gets its own slot so a failed registration of
  // one never clobbers the other's honest status.
  const captureShortcuts = new ShortcutManager()
  // The peek shortcut hides the popup WITHOUT resetting the session —
  // showing again restores the conversation/attachment/draft mid-stream.
  const peekShortcuts = new ShortcutManager()
  const captureService = new CaptureService({
    getSettingsMaxImageBytes: () => settingsStore.load().maxImageBytes,
    presentWithFrost: (win, present) => captureFrostThenPresent(win, 200, present)
  })
  const chatService = new ChatService({
    getSettings: () => settingsStore.load(),
    getApiKey: () => secrets.getApiKey(),
    getHosted: () => hostedClient,
    onHostedQuota: (quota) => {
      hostedQuotaCache = quota
      pushSettingsToAssistant()
    }
  })

  // --- Public settings (never the key) --------------------------------------

  const publicSettings = (): PublicSettings => {
    const s = settingsStore.load()
    const captureStatus = captureShortcuts.currentStatus()
    const peekStatus = peekShortcuts.currentStatus()
    return {
      ...s,
      hasApiKey: secrets.getApiKey() !== null,
      keyStorageSecure: secrets.isSecureStorageAvailable(),
      hostedAvailable: hostedClient.isAvailable(),
      hostedQuota: hostedQuotaCache,
      shortcutStatus: shortcuts.currentStatus().registered ? 'registered' : 'failed',
      shortcutError: shortcuts.currentStatus().error,
      captureShortcutStatus:
        s.captureShortcut === '' ? 'disabled' : captureStatus.registered ? 'registered' : 'failed',
      captureShortcutError: s.captureShortcut === '' ? undefined : captureStatus.error,
      peekShortcutStatus:
        s.peekShortcut === '' ? 'disabled' : peekStatus.registered ? 'registered' : 'failed',
      peekShortcutError: s.peekShortcut === '' ? undefined : peekStatus.error
    }
  }

  // --- Window lifecycle ------------------------------------------------------

  function pushSettingsToAssistant(): void {
    // Push updated settings to the assistant popup so its model chip, key
    // state, and any settings-driven UI stay current without waiting for a
    // window-focus refetch (focus does not reliably return to an
    // always-on-top popup after the settings window closes).
    if (assistantWindow && !assistantWindow.isDestroyed()) {
      assistantWindow.webContents.send('settings:changed', publicSettings())
    }
  }

  function ensureAssistant(): BrowserWindow {
    if (assistantWindow && !assistantWindow.isDestroyed()) return assistantWindow
    assistantWindow = createAssistantWindow()
    attachBackdropRefresh(assistantWindow)
    assistantWindow.on('close', (event) => {
      // Closing the popup hides it — the background app keeps running —
      // unless the app is actually quitting (tray Quit / app:quit).
      if (!quitting) {
        event.preventDefault()
        hideAssistant()
      }
    })
    return assistantWindow
  }

  // Frosted-glass backdrop: capture the desktop behind the (hidden) window
  // and hand the image to the renderer for the in-page blur. A generation
  // counter drops stale captures when shows overlap (rapid toggles).
  const backdropGenerations = new WeakMap<BrowserWindow, number>()

  async function refreshBackdrop(win: BrowserWindow, deliverWhenHidden = true): Promise<void> {
    const generation = (backdropGenerations.get(win) ?? 0) + 1
    backdropGenerations.set(win, generation)
    const dataUrl = await captureBackdrop(win.getBounds())
    if (!dataUrl || win.isDestroyed()) return
    if (backdropGenerations.get(win) !== generation) return
    if (win.webContents.isLoading()) {
      // First open: deliver after the page finishes loading, when the
      // renderer's onBackdrop subscription is guaranteed to exist.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 2000)
        function done(): void {
          clearTimeout(timer)
          resolve()
        }
        win.webContents.once('did-finish-load', done)
      })
    }
    if (win.isDestroyed() || backdropGenerations.get(win) !== generation) return
    // A geometry-path refresh that completes after the user hid the window
    // must NOT re-populate the frost the renderer just dropped (the
    // pre-show flows intentionally deliver while hidden, hence the flag).
    if (!deliverWhenHidden && !win.isVisible()) return
    backdropRefreshCount++
    win.webContents.send('window:backdrop', { dataUrl })
  }

  const showDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  // Moving or resizing a window changes which part of the desktop sits behind
  // it — re-capture the frost so the blur keeps matching reality. The window
  // never appears in its own capture because every app window is PERMANENTLY
  // content-protected at creation (see windows.ts): WDA_EXCLUDEFROMCAPTURE
  // excludes it from any desktopCapturer frame while it stays fully visible
  // and clickable, with no toggling, no blink, and no visibility events — so
  // the renderer session is untouched. (Probes verified the excluded region
  // shows the desktop behind.)
  const backdropRefreshTimers = new WeakMap<BrowserWindow, NodeJS.Timeout>()
  const backdropRefreshing = new WeakSet<BrowserWindow>()
  const backdropRefreshSuppressUntil = new WeakMap<BrowserWindow, number>()
  let backdropRefreshCount = 0

  function scheduleBackdropRefresh(win: BrowserWindow, debounceMs: number): void {
    const existing = backdropRefreshTimers.get(win)
    if (existing) clearTimeout(existing)
    backdropRefreshTimers.set(
      win,
      setTimeout(() => {
        backdropRefreshTimers.delete(win)
        refreshBackdropAfterGeometryChange(win).catch(() => {
          // the window can be destroyed mid-capture — nothing to deliver
        })
      }, debounceMs)
    )
  }

  async function refreshBackdropAfterGeometryChange(win: BrowserWindow): Promise<void> {
    if (backdropRefreshing.has(win)) {
      scheduleBackdropRefresh(win, 120) // don't drop it — retry after the in-flight one
      return
    }
    if (Date.now() < (backdropRefreshSuppressUntil.get(win) ?? 0)) return // placement already captured this spot
    if (win.isDestroyed() || !win.isVisible()) return
    if (captureService.isActive()) return // a selection owns the whole screen
    backdropRefreshing.add(win)
    // Watchdog: if the capture hangs for ages (capture-blocking apps can
    // cause this), invalidate its late frame AND release the in-flight slot —
    // otherwise every future refresh would no-op until restart.
    const invalidateStale = setTimeout(() => {
      backdropGenerations.set(win, (backdropGenerations.get(win) ?? 0) + 1)
      backdropRefreshing.delete(win)
    }, 10_000)
    try {
      await refreshBackdrop(win, false)
    } finally {
      backdropRefreshing.delete(win)
      clearTimeout(invalidateStale)
    }
  }

  function attachBackdropRefresh(win: BrowserWindow): void {
    // 'move' covers both interactive drags and programmatic setBounds
    // (Windows' 'moved' only fires after the interactive move loop), and
    // 'resize' streams during grip drags. One shared trailing debounce
    // serves both: the refresh lands ~400ms after the geometry settles.
    const schedule = (): void => scheduleBackdropRefresh(win, 400)
    win.on('move', schedule)
    win.on('resize', schedule)
  }

  /**
   * Frost capture + presentation for every show path (assistant popup,
   * settings, direct-capture re-present). The window is permanently
   * content-protected, so its frame can never appear in the frost no matter
   * when the capture samples. The window re-shows after `presentCapMs`
   * regardless (gradient fallback if the capture is slower).
   */
  function captureFrostThenPresent(
    win: BrowserWindow,
    presentCapMs: number,
    present: (win: BrowserWindow) => void
  ): void {
    const capture = refreshBackdrop(win).catch(() => {})
    void Promise.race([capture, showDelay(presentCapMs)]).then(() => present(win))
  }

  function showAssistant(): void {
    if (captureService.isActive()) return // don't fight an active selection
    const win = ensureAssistant()
    if (win.isVisible()) {
      win.focus() // already shown: don't reposition, don't recapture
      return
    }
    // Default placement: tray-adjacent bottom-right corner of the display the
    // pointer is on, with a margin from the screen edges. The placement's own
    // 'move' event must not trigger a second capture — the pre-show one below
    // already covers the new spot (suppression window covers the 400ms
    // debounce, and any later real drag still refreshes normally).
    placeOnPointerDisplayCorner(win, win.getBounds())
    backdropRefreshSuppressUntil.set(win, Date.now() + 700)
    captureFrostThenPresent(win, 160, (w) => {
      if (!w.isDestroyed()) {
        w.show()
        w.focus()
      }
    })
  }

  function hideAssistant(): void {
    if (!assistantWindow || assistantWindow.isDestroyed()) return
    chatService.cancelAllFor(assistantWindow.id)
    // Reset the renderer session: discards the unsent crop, the draft, and
    // the conversation (accepted criteria: closing before sending discards
    // the pending image; no conversation is persisted).
    assistantWindow.webContents.send('window:visibility', { visible: false })
    assistantWindow.hide()
  }

  function toggleAssistant(): void {
    if (captureService.isActive()) {
      captureService.cancelIfActive()
      return
    }
    if (assistantWindow && !assistantWindow.isDestroyed() && assistantWindow.isVisible()) {
      hideAssistant()
    } else {
      showAssistant()
    }
  }

  /**
   * The peek shortcut: hide WITHOUT resetting the session — the conversation,
   * attachment, draft, and even an in-flight answer keep running; showing
   * again lands exactly where the user left off. (The assistant shortcut
   * remains the hide-and-clear toggle.)
   */
  function peekHide(): void {
    if (!assistantWindow || assistantWindow.isDestroyed()) return
    // No cancelAllFor: the stream keeps running into the hidden window.
    assistantWindow.webContents.send('window:visibility', { visible: false, resetSession: false })
    assistantWindow.hide()
  }

  function togglePeek(): void {
    if (captureService.isActive()) return // don't fight an active selection
    if (assistantWindow && !assistantWindow.isDestroyed() && assistantWindow.isVisible()) {
      peekHide()
    } else {
      showAssistant() // preserved session: the renderer was never reset
    }
  }

  function openSettings(): void {
    if (!settingsWindow || settingsWindow.isDestroyed()) {
      settingsWindow = createSettingsWindow()
      attachBackdropRefresh(settingsWindow)
      settingsWindow.on('close', (event) => {
        if (!quitting) {
          event.preventDefault()
          settingsWindow?.hide()
        }
      })
    }
    const win = settingsWindow
    if (win.isVisible()) {
      win.focus()
      return
    }
    captureFrostThenPresent(win, 160, (w) => {
      if (!w.isDestroyed()) {
        w.show()
        w.focus()
      }
    })
  }

  // --- Global shortcuts ------------------------------------------------------

  function applyShortcut(): void {
    const { shortcut } = settingsStore.load()
    shortcuts.register(shortcut, toggleAssistant)
    // Keep the tray tooltip honest about the active shortcut.
    tray?.setToolTip(`Screen Scout — ${shortcut} to open`)
  }

  function applyCaptureShortcut(): void {
    const { captureShortcut } = settingsStore.load()
    if (captureShortcut === '') {
      captureShortcuts.unregister()
      return
    }
    captureShortcuts.register(captureShortcut, startDirectCapture)
  }

  function applyPeekShortcut(): void {
    const { peekShortcut } = settingsStore.load()
    if (peekShortcut === '') {
      peekShortcuts.unregister()
      return
    }
    peekShortcuts.register(peekShortcut, togglePeek)
  }

  /**
   * The direct-capture shortcut: jump straight to region selection without
   * opening the popup first. The result is pushed to the assistant renderer,
   * which opens focused with the crop attached.
   */
  function startDirectCapture(): void {
    if (captureService.isActive()) return // a selection is already open
    const assistant = ensureAssistant()
    if (chatService.isBusyFor(assistant.id)) return // don't fight an in-flight answer
    void captureService.startSelection(assistant)
  }

  // --- IPC wiring (all payloads validated) -----------------------------------

  // Selection overlay + capture flow channels.
  captureService.registerIpc((sender) => BrowserWindow.fromWebContents(sender) === assistantWindow)

  function invalid(label: string, error: unknown): Error {
    const detail = error instanceof Error ? error.message : 'invalid payload'
    return new Error(`${label}: ${detail}`)
  }

  ipcMain.handle('settings:get', () => publicSettings())

  ipcMain.handle('settings:save', (_event, payload) => {
    let patch: ReturnType<typeof assertSettingsPatch>
    try {
      patch = assertSettingsPatch(payload)
    } catch (error) {
      throw invalid('Invalid settings', error)
    }
    if (patch.accessMode === 'hosted' && !hostedClient.isAvailable()) {
      throw invalid('Hosted mode', new Error('this build has no relay URL configured'))
    }
    // Privileged fields only change through the dedicated hosted:* IPCs below —
    // a renderer settings patch (untrusted) can never self-onboard or fake an
    // account state.
    delete (patch as Partial<AppSettings>).onboarded
    delete (patch as Partial<AppSettings>).authMethod
    delete (patch as Partial<AppSettings>).authEmail
    delete (patch as Partial<AppSettings>).nudgeDismissed
    const before = settingsStore.load()
    const next = settingsStore.update(patch)

    if (patch.launchOnStartup !== undefined && patch.launchOnStartup !== before.launchOnStartup && app.isPackaged) {
      try {
        app.setLoginItemSettings({ openAtLogin: next.launchOnStartup })
      } catch {
        // Non-fatal: startup registration can fail on locked-down systems.
      }
    }
    if (patch.shortcut !== undefined && patch.shortcut !== before.shortcut) {
      applyShortcut()
    }
    if (patch.captureShortcut !== undefined && patch.captureShortcut !== before.captureShortcut) {
      applyCaptureShortcut()
    }
    if (patch.peekShortcut !== undefined && patch.peekShortcut !== before.peekShortcut) {
      applyPeekShortcut()
    }
    if (patch.accessMode !== undefined && patch.accessMode !== before.accessMode) {
      ensureDeviceId()
      // Warm the Settings meter with real numbers as soon as the user opts in.
      if (patch.accessMode === 'hosted') void chatService.refreshQuota()
    }
    const result = publicSettings()
    pushSettingsToAssistant()
    return result
  })

  ipcMain.handle('key:save', (_event, payload) => {
    const parsed = apiKeySchema.safeParse(typeof payload === 'string' ? payload : '')
    if (!parsed.success) throw invalid('Invalid API key', formatZodError(parsed.error))
    const result = secrets.saveApiKey(parsed.data)
    // hasApiKey changed — the popup's key-state UI depends on it.
    pushSettingsToAssistant()
    return result
  })

  ipcMain.handle('key:remove', () => {
    secrets.removeApiKey()
    pushSettingsToAssistant()
    return { ok: true }
  })

  ipcMain.handle('connection:test', (_event, payload) => {
    const parsed = testConnectionSchema.safeParse(payload ?? {})
    if (!parsed.success) throw invalid('Invalid test request', formatZodError(parsed.error))
    return chatService.testConnection(parsed.data)
  })

  ipcMain.handle('hosted:quota', () => chatService.refreshQuota())

  // --- Onboarding + account identity (renderer is untrusted) -----------------
  // These are the ONLY paths that may change onboarded/authMethod/authEmail —
  // renderer settings patches are stripped of those fields in settings:save.
  ipcMain.handle('hosted:auth-google', async (): Promise<GoogleSignInResult> => {
    if (!hostedClient.isAvailable()) {
      return { ok: false, message: 'This build has no hosted service configured.' }
    }
    if (!googleAuth.isConfigured()) {
      return { ok: false, message: 'Google sign-in is not available in this build.' }
    }
    try {
      const { email, persisted } = await googleAuth.signIn()
      settingsStore.update({ authMethod: 'google', authEmail: email ?? '', onboarded: true })
      // The account token replaces any device token: drop the old identity so
      // the next hosted call registers under the account.
      hostedClient.resetAuth()
      void chatService.refreshQuota()
      pushSettingsToAssistant()
      return { ok: true, email: email ?? undefined, persisted }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Google sign-in failed.'
      logger.warn(`google sign-in failed: ${message}`)
      return { ok: false, message }
    }
  })

  ipcMain.handle('hosted:auth-signout', () => {
    settingsStore.update({ authMethod: 'anonymous', authEmail: '' })
    googleAuth.clear()
    secrets.removeGoogleRefreshToken()
    hostedClient.resetAuth()
    void chatService.refreshQuota()
    pushSettingsToAssistant()
    return { ok: true }
  })

  ipcMain.handle('hosted:onboard-byok', () => {
    settingsStore.update({ onboarded: true, accessMode: 'byok' })
    pushSettingsToAssistant()
    return { ok: true }
  })

  ipcMain.handle('hosted:dismiss-nudge', () => {
    settingsStore.update({ nudgeDismissed: true })
    pushSettingsToAssistant()
    return { ok: true }
  })

  ipcMain.handle('chat:send', (event, payload): SendMessageResult => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win !== assistantWindow) return { status: 'error', message: 'Chat is only available from the assistant window.' }
    const parsed = sendMessageSchema.safeParse(payload)
    if (!parsed.success) return { status: 'error', message: formatZodError(parsed.error) }
    const mode = settingsStore.load().accessMode
    if (mode === 'hosted') {
      if (!hostedClient.isAvailable()) {
        return {
          status: 'error',
          message: 'Hosted mode is not configured in this build. Switch to your own API key in Settings.'
        }
      }
    } else if (!secrets.getApiKey()) {
      return { status: 'error', message: 'Add your NVIDIA API key in Settings to start asking questions.' }
    }
    if (chatService.isBusyFor(win.id)) {
      return { status: 'busy', message: 'A request is already in progress.' }
    }
    // Fire-and-forget; results stream back over `chat:event`.
    void chatService.send(win, parsed.data)
    return { status: 'accepted' }
  })

  ipcMain.handle('chat:cancel', (_event, payload) => {
    const parsed = requestIdSchema.safeParse(payload)
    if (!parsed.success) return
    chatService.cancel(parsed.data.requestId)
    return { ok: true }
  })

  // Image imports (clipboard / dropped files): assistant window only, always
  // validated + re-encoded under the configured size cap in the main process.
  ipcMain.handle('images:import', (event, payload): ImageImportResult => {
    if (BrowserWindow.fromWebContents(event.sender) !== assistantWindow) {
      return { ok: false, message: 'Images can only be attached from the assistant window.' }
    }
    return importImageBytes(payload, settingsStore.load().maxImageBytes)
  })

  ipcMain.handle('images:from-clipboard', (event): ImageImportResult => {
    if (BrowserWindow.fromWebContents(event.sender) !== assistantWindow) {
      return { ok: false, message: 'Images can only be attached from the assistant window.' }
    }
    return importClipboardImage(settingsStore.load().maxImageBytes)
  })

  ipcMain.handle('window:hide', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win === assistantWindow) hideAssistant()
    else if (win !== null && win === settingsWindow) {
      // Let the settings renderer drop its frosted backdrop from memory.
      win.webContents.send('window:visibility', { visible: false })
      win.hide()
    }
    return { ok: true }
  })

  ipcMain.handle('window:resizeBy', (event, payload) => {
    const parsed = resizeSchema.safeParse(payload)
    if (!parsed.success) throw invalid('Invalid resize', formatZodError(parsed.error))
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win !== assistantWindow) return { ok: false }
    const bounds = win.getBounds()
    win.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: Math.min(Math.max(bounds.width + parsed.data.deltaWidth, ASSISTANT_MIN.width), ASSISTANT_MAX.width),
      height: Math.min(Math.max(bounds.height + parsed.data.deltaHeight, ASSISTANT_MIN.height), ASSISTANT_MAX.height)
    })
    return { ok: true }
  })

  ipcMain.handle('settings:open', () => {
    openSettings()
    return { ok: true }
  })

  ipcMain.handle('app:openExternal', async (_event, payload) => {
    const parsed = openExternalSchema.safeParse(payload)
    if (!parsed.success) return { ok: false, message: 'Only http(s) links can be opened.' }
    const url = parsed.data
    const options = {
      type: 'question' as const,
      title: 'Open link',
      message: 'Open this link in your browser?',
      detail: url,
      buttons: ['Open link', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    }
    const parent = assistantWindow ?? settingsWindow ?? null
    const choice = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    if (choice.response === 0) {
      await shell.openExternal(url)
      return { ok: true }
    }
    return { ok: false }
  })

  ipcMain.handle('app:quit', () => {
    app.quit()
    return { ok: true }
  })

  // --- Support (logs & diagnostics) ---------------------------------------------
  // Diagnostics are deliberately minimal and key-free: version, platform, mode,
  // uptime. Nothing that identifies the user or their content.

  ipcMain.handle('app:openLogs', () => {
    try {
      logger.ensureDir()
      void shell.openPath(logger.dir())
      return { ok: true }
    } catch {
      return { ok: false, message: 'Could not open the log folder.' }
    }
  })

  ipcMain.handle('app:copyDiagnostics', async () => {
    try {
      const s = settingsStore.load()
      const diagnostics = {
        appVersion: app.getVersion(),
        electron: process.versions.electron,
        platform: `${process.platform} ${process.arch} ${os.release()}`,
        locale: app.getLocale(),
        accessMode: s.accessMode,
        hostedAvailable: hostedClient.isAvailable(),
        updatesEnabled: s.updatesEnabled,
        updatePhase: updateService.currentPhase().kind,
        uptimeSec: Math.round(process.uptime()),
        rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        generatedAt: new Date().toISOString()
      }
      clipboard.writeText(JSON.stringify(diagnostics, null, 2))
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Could not build diagnostics.' }
    }
  })

  // --- Updates -----------------------------------------------------------------

  ipcMain.handle('updates:state', () => updateStateSnapshot())
  ipcMain.handle('updates:check', () => updateService.check())
  ipcMain.handle('updates:download', () => updateService.download())
  ipcMain.handle('updates:install', async () => {
    if (updateService.currentPhase().kind !== 'verified') {
      return { ok: false, message: 'No verified update is ready to install.' }
    }
    const options = {
      type: 'question' as const,
      title: 'Install update',
      message: 'Install the update and restart Screen Scout?',
      buttons: ['Install and restart', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    }
    const parent = assistantWindow ?? settingsWindow ?? null
    const choice = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    if (choice.response !== 0) return { ok: false }
    if (!updateService.install()) {
      // The verified installer vanished (e.g. temp cleaner); do not quit.
      return { ok: false, message: 'The installer could not be launched. Check for updates and download it again.' }
    }
    // The NSIS installer replaces the running exe; give it a beat to take over.
    setTimeout(() => app.quit(), 500)
    return { ok: true }
  })

  // --- App lifecycle ----------------------------------------------------------

  app.on('second-instance', () => {
    // Another launch attempt: focus our single instance instead.
    showAssistant()
  })

  // Marks a genuine quit so window 'close' handlers let windows close.
  app.on('before-quit', () => {
    quitting = true
  })

  /**
 * macOS shell adjustments for a tray-resident app: hide the Dock icon
 * (LSUIElement in the packaged build covers it too, but the dev app needs
 * this), and install a minimal application menu — without one, macOS text
 * fields get no Edit shortcuts (Cmd+C/V/A) at all. Windows keeps its current
 * behavior (frameless windows hide the menu bar).
 */
function applyMacPlatformShell(): void {
  if (process.platform !== 'darwin') return
  app.dock?.hide()
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }]
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' }
        ]
      },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] }
    ])
  )
}

app.whenReady().then(async () => {
    if (PERSISTENCE_PHASE) {
      runPersistencePhase(PERSISTENCE_PHASE)
      return
    }
    // E2E: run against a local mock relay instead of the real network, and
    // point the real HostedClient at it via the runtime override.
    let e2eRelay: E2eRelayHandle | null = null
    if (E2E_TEST) {
      try {
        e2eRelay = await startE2eRelay()
        process.env.SCREEN_SCOUT_RELAY_URL = e2eRelay.url
      } catch (error) {
        console.error(`E2E_RELAY_START_FAILED ${error instanceof Error ? error.message : error}`)
      }
    }
    applyShortcut()
    applyCaptureShortcut()
    applyPeekShortcut()
    applyMacPlatformShell()
    // E2E surveillance must be registered before the first window is created
    // so early load errors are captured too.
    const e2eSurveillance = E2E_TEST ? setupE2eSurveillance() : null
    ensureAssistant()
    tray = createTray({
      assistant: () => assistantWindow,
      openAssistant: () => showAssistant(),
      openSettings: () => openSettings(),
      shortcutLabel: () => settingsStore.load().shortcut
    })

    // Auto-check for updates: once shortly after launch, then every 6 hours.
    // Skipped in every test harness so runs are deterministic and never touch
    // the production feed; the E2E drives the check explicitly via the UI.
    // Timers are created unconditionally so enabling the toggle mid-session
    // takes effect immediately; each tick re-reads the setting.
    if (!E2E_TEST && !SMOKE_TEST && !INTEGRATION_TEST && !PERSISTENCE_PHASE) {
      const autoCheck = (): void => {
        if (settingsStore.load().updatesEnabled) void updateService.check()
      }
      setTimeout(autoCheck, 45_000)
      setInterval(autoCheck, 6 * 60 * 60 * 1000)
    }

    if (SMOKE_TEST) {
      void runSmokeTest()
    }
    if (INTEGRATION_TEST) {
      void runIntegrationTest()
    }
    if (E2E_TEST && e2eSurveillance) {
      void runE2eTest(
        {
          ensureAssistant,
          toggleAssistant,
          openSettings,
          startDirectCapture,
          togglePeek,
          shortcuts,
          captureShortcuts,
          secrets,
          relay: e2eRelay ?? undefined,
          backdropRefreshCount: () => backdropRefreshCount,
          setOnboarded: (value: boolean) => {
            settingsStore.update({ onboarded: value })
            pushSettingsToAssistant()
          }
        },
        e2eSurveillance
      )
    }
  })

  // Quitting fully unregisters the shortcut and disposes resources.
  app.on('will-quit', () => {
    shortcuts.unregisterAll()
    captureShortcuts.unregisterAll()
    peekShortcuts.unregisterAll()
    chatService.dispose()
    secrets.dispose()
    captureService.cancelIfActive()
    if (SMOKE_TEST || INTEGRATION_TEST) {
      console.log('QUIT_PATH_REACHED')
    }
  })

  app.on('window-all-closed', () => {
    // Keep running in the tray.
  })

  /**
   * Proves the saved API key survives a real process restart on this
   * machine: `save` (launch 1) encrypts it into the isolated userData dir;
   * `check` (launch 2) decrypts it back in a fresh process; `clear` removes it.
   *
   * The probe always quits GRACEFULLY (app.quit), because Chromium stores the
   * DPAPI-wrapped safeStorage key in the `Local State` file and commits it
   * during a normal shutdown — the same path a real tray-quit takes. A hard
   * app.exit() would skip that commit and lose the key.
   */
  function runPersistencePhase(phase: string): void {
    const quitWith = (code: number): void => {
      process.exitCode = code
      app.quit()
      setTimeout(() => app.exit(code), 3000) // safety net, never expected
    }
    try {
      if (phase === 'save') {
        const result = secrets.saveApiKey(PERSISTENCE_PROBE_KEY)
        console.log(`PERSISTENCE_SAVE ${JSON.stringify(result)}`)
        quitWith(result.ok ? 0 : 1)
      } else if (phase === 'check') {
        const key = secrets.getApiKey()
        const pub = publicSettings()
        const result = {
          remembered: key === PERSISTENCE_PROBE_KEY,
          hasApiKey: pub.hasApiKey,
          secure: pub.keyStorageSecure,
          localStateFlushed: fs.existsSync(path.join(app.getPath('userData'), 'Local State'))
        }
        console.log(`PERSISTENCE_CHECK ${JSON.stringify(result)}`)
        quitWith(result.remembered && result.hasApiKey && result.secure ? 0 : 1)
      } else if (phase === 'clear') {
        secrets.removeApiKey()
        const cleared = secrets.getApiKey() === null
        console.log(`PERSISTENCE_CLEAR ${JSON.stringify({ cleared })}`)
        quitWith(cleared ? 0 : 1)
      } else if (phase === 'debug') {
        const file = path.join(app.getPath('userData'), 'api-key.bin')
        const diag: Record<string, unknown> = {
          userData: app.getPath('userData'),
          fileExists: fs.existsSync(file)
        }
        try {
          // 1. Same-process round trip.
          const enc = safeStorage.encryptString(PERSISTENCE_PROBE_KEY)
          diag.sameProcessRoundTrip = safeStorage.decryptString(enc) === PERSISTENCE_PROBE_KEY
          // 2. Cross-process decrypt of the file written by the save launch.
          if (diag.fileExists) {
            const raw = fs.readFileSync(file)
            diag.size = raw.length
            diag.headHex = raw.subarray(0, 8).toString('hex')
            try {
              const dec = safeStorage.decryptString(raw)
              diag.crossProcessDecryptLength = dec.length
              diag.crossProcessMatches = dec === PERSISTENCE_PROBE_KEY
            } catch (inner) {
              diag.crossProcessError =
                inner instanceof Error ? `${inner.name}: ${inner.message}` : String(inner)
            }
          }
          // 3. What key material exists in userData?
          diag.files = fs.readdirSync(app.getPath('userData'))
          const localState = path.join(app.getPath('userData'), 'Local State')
          if (fs.existsSync(localState)) {
            diag.localStateBytes = fs.statSync(localState).size
          }
        } catch (error) {
          diag.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        }
        console.log(`PERSISTENCE_DEBUG ${JSON.stringify(diag)}`)
        app.exit(0)
      } else {
        console.error(`PERSISTENCE_UNKNOWN_PHASE ${phase}`)
        quitWith(1)
      }
    } catch (error) {
      console.error(`PERSISTENCE_FAILED ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      quitWith(1)
    }
  }

  async function runSmokeTest(): Promise<void> {
    try {
      const win = ensureAssistant()
      await new Promise<void>((resolve) => {
        if (!win.isVisible()) win.once('ready-to-show', () => resolve())
        else resolve()
        setTimeout(resolve, 4000)
      })
      const shortcutOk = shortcuts.currentStatus().registered
      const result = {
        smoke: 'ok',
        assistantWindow: !!assistantWindow && !assistantWindow.isDestroyed(),
        settingsRoundTrip: JSON.stringify(publicSettings()).length > 0,
        tray: !!tray,
        shortcutRegistered: shortcutOk,
        secureStorage: secrets.isSecureStorageAvailable()
      }
      console.log(`SMOKE_RESULT ${JSON.stringify(result)}`)
      app.exit(0)
    } catch (error) {
      console.error(`SMOKE_FAILED ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      app.exit(1)
    }
  }

  /**
   * Headless-ish integration test: boots the real renderer and exercises the
   * preload bridge, React mounting, settings IPC, chat validation, and the
   * missing-key error path. Does NOT touch the screen selection flow (that
   * requires human interaction) or the network.
   */
  async function runIntegrationTest(): Promise<void> {
    try {
      const win = ensureAssistant()
      await new Promise<void>((resolve) => {
        win.webContents.once('did-finish-load', () => resolve())
        setTimeout(resolve, 6000)
      })
      // Give React a moment to mount.
      await new Promise((r) => setTimeout(r, 700))
      const result = (await win.webContents.executeJavaScript(`(async () => {
        const checks = {}
        try {
          checks.scoutApi = typeof window.scout === 'object' && typeof window.scout.chat.send === 'function'
          checks.reactMounted = !!document.querySelector('.assistant-root')
          checks.headerRendered = !!document.querySelector('.app-header')
          checks.composerRendered = !!document.querySelector('.composer-input')
          checks.emptyStateShown = !!document.querySelector('.empty-state')
          const s = await window.scout.settings.get()
          checks.settingsGet = !!s && s.shortcut === 'Shift+R' && s.hasApiKey === false && s.model.indexOf('vision') !== -1
          const saved = await window.scout.settings.save({ requestTimeoutSec: 77 })
          checks.settingsSaveRoundTrip = saved.requestTimeoutSec === 77
          await window.scout.settings.save({ requestTimeoutSec: 60 })
          // Chat validation: a malformed payload must be rejected by Zod in main.
          const bad = await window.scout.chat.send({ requestId: 'not-a-uuid', text: 'x', history: [] })
          checks.chatValidationRejects = bad.status === 'error'
          // No-key path: a valid payload with no stored key returns an error status.
          const blocked = await window.scout.chat.send({ requestId: crypto.randomUUID(), text: 'hello', history: [] })
          checks.chatNoKeyBlocked = blocked.status === 'error' && /API key/i.test(blocked.message || '')
          // Window visibility event subscription exists.
          checks.visibilitySubscription = typeof window.scout.window.onVisibility === 'function'
          // Hiding must emit the visibility event (session reset signal).
          const hidden = await new Promise((resolve) => {
            const off = window.scout.window.onVisibility((payload) => { off(); resolve(payload.visible) })
            window.scout.window.hide()
            setTimeout(() => resolve('timeout'), 2500)
          })
          checks.hideEmitsInvisible = hidden === false
        } catch (e) {
          checks.exception = String(e)
        }
        return checks
      })()`)) as Record<string, unknown>

      // --- Settings page mounts (hidden window) ---------------------------------
      const settingsWin = createSettingsWindow()
      await new Promise<void>((resolve) => {
        settingsWin.webContents.once('did-finish-load', () => resolve())
        setTimeout(resolve, 5000)
      })
      await new Promise((r) => setTimeout(r, 500))
      const settingsChecks = (await settingsWin.webContents.executeJavaScript(`(() => ({
        root: !!document.querySelector('.settings-root'),
        keyInput: !!document.querySelector('input[type=password]'),
        modelSelect: !!document.querySelectorAll('select').length,
        testButton: !!Array.from(document.querySelectorAll('button')).find((b) => b.textContent && b.textContent.includes('Test connection')),
        shortcutRow: !!document.querySelector('.shortcut-display'),
        privacySection: !!document.querySelector('.settings-section:last-of-type')
      }))()`)) as Record<string, unknown>
      settingsWin.destroy()

      // --- Overlay page mounts (hidden window, no capture) ----------------------
      const overlayWin = createOverlayWindow({
        bounds: { x: 0, y: 0, width: 400, height: 300 },
        displayId: -1
      })
      await new Promise<void>((resolve) => {
        overlayWin.webContents.once('did-finish-load', () => resolve())
        setTimeout(resolve, 5000)
      })
      await new Promise((r) => setTimeout(r, 500))
      const overlayChecks = (await overlayWin.webContents.executeJavaScript(`(() => ({
        root: !!document.querySelector('.overlay-root'),
        hint: !!document.querySelector('.overlay-hint'),
        cspOk: !document.querySelector('script[src^="http"]')
      }))()`)) as Record<string, unknown>
      overlayWin.destroy()

      console.log(`INTEGRATION_RESULT ${JSON.stringify({ ...result, settingsPage: settingsChecks, overlayPage: overlayChecks })}`)
      const all = { ...result, ...settingsChecks, ...overlayChecks }
      const failed = Object.entries(all).filter(([k, v]) => k !== 'exception' && v !== true)
      const code = failed.length === 0 && !('exception' in all) ? 0 : 1

      // Exercise the REAL quit path (tray Quit uses app.quit): windows must
      // close, will-quit must fire (prints QUIT_PATH_REACHED), and the
      // process must exit with the right code.
      process.exitCode = code
      app.quit()
      setTimeout(() => {
        // Safety net: if quit were broken we'd still terminate with the code.
        console.error('QUIT_FALLBACK_FORCED')
        app.exit(code)
      }, 3000)
    } catch (error) {
      console.error(`INTEGRATION_FAILED ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      process.exitCode = 1
      app.quit()
      setTimeout(() => app.exit(1), 3000)
    }
  }
}
