import type { AppSettings } from '@shared/types'
import { DEFAULT_MAX_IMAGE_BYTES } from '@shared/types'
import { HOSTED_RELAY_URL } from '@shared/hosted'
import { acceleratorSchema, baseUrlSchema, formatZodError, modelIdSchema, saveSettingsSchema } from '@shared/schemas'

/**
 * Storage for non-secret preferences only (model, endpoint, shortcut, etc.).
 * The NVIDIA API key is handled separately by security/secrets.ts and is
 * never written through this store.
 */

export const DEFAULT_SETTINGS: AppSettings = {
  model: 'meta/llama-3.2-90b-vision-instruct',
  baseUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
  // Fresh installs use the hosted free tier when this build has a relay;
  // existing installs with a saved key are migrated to 'byok' at startup.
  accessMode: HOSTED_RELAY_URL ? 'hosted' : 'byok',
  deviceId: '',
  shortcut: 'Shift+R',
  captureShortcut: 'Shift+C',
  peekShortcut: 'Shift+S',
  requestTimeoutSec: 60,
  launchOnStartup: false,
  noticeAcknowledged: false,
  updatesEnabled: true,
  glassTint: 50,
  zoom: 1,
  maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
  // Fresh installs see the first-run onboarding (Google sign-in OR own key);
  // existing installs are marked onboarded by migrateOnboarding at startup.
  onboarded: false,
  authMethod: 'anonymous',
  authEmail: '',
  nudgeDismissed: false,
  answerStyle: 'brief'
}

/** Minimal fs surface so unit tests can run this against a temp directory. */
export interface SettingsFs {
  existsSync(path: string): boolean
  readFileSync(path: string): string
  writeFileSync(path: string, data: string): void
  mkdirSync(dir: string): void
}

export class SettingsStore {
  private filePath: string
  private fs: SettingsFs
  private cached: AppSettings | null = null

  constructor(fs: SettingsFs, filePath: string) {
    this.fs = fs
    this.filePath = filePath
  }

  load(): AppSettings {
    if (this.cached) return this.cached
    let parsed: Record<string, unknown> = {}
    if (this.fs.existsSync(this.filePath)) {
      try {
        parsed = JSON.parse(this.fs.readFileSync(this.filePath))
      } catch {
        // Corrupt settings file: fall back to defaults rather than crashing.
        parsed = {}
      }
    }
    this.cached = sanitizeSettings(parsed)
    return this.cached
  }

  /** Applies a partial update after validation; persists atomically enough for prefs. */
  update(patch: Partial<AppSettings>): AppSettings {
    const current = this.load()
    const next = sanitizeSettings({ ...current, ...patch })
    const dir = this.filePath.slice(0, Math.max(this.filePath.lastIndexOf('\\'), this.filePath.lastIndexOf('/')))
    if (dir) this.fs.mkdirSync(dir)
    this.fs.writeFileSync(this.filePath, JSON.stringify(next, null, 2))
    this.cached = next
    return next
  }
}

/**
 * Merges unknown input onto defaults and validates each field individually.
 * Invalid fields fall back to defaults instead of throwing, so a bad model id
 * typed by hand can never brick the app.
 */
export function sanitizeSettings(input: Record<string, unknown>): AppSettings {
  const out: AppSettings = { ...DEFAULT_SETTINGS }
  if (typeof input.model === 'string' && modelIdSchema.safeParse(input.model).success) {
    out.model = input.model.trim()
  }
  if (typeof input.baseUrl === 'string' && baseUrlSchema.safeParse(input.baseUrl).success) {
    out.baseUrl = input.baseUrl.trim()
  }
  if (input.accessMode === 'hosted' || input.accessMode === 'byok') {
    out.accessMode = input.accessMode
  }
  if (typeof input.deviceId === 'string') {
    const id = input.deviceId.trim()
    if (id === '' || /^[A-Za-z0-9_-]{16,64}$/.test(id)) out.deviceId = id
  }
  if (typeof input.shortcut === 'string' && acceleratorSchema.safeParse(input.shortcut).success) {
    out.shortcut = input.shortcut.trim()
  }
  if (typeof input.captureShortcut === 'string') {
    const value = input.captureShortcut.trim()
    // '' disables the capture shortcut; anything else must be a valid accelerator.
    if (value === '' || acceleratorSchema.safeParse(value).success) out.captureShortcut = value
  }
  if (typeof input.peekShortcut === 'string') {
    const peek = input.peekShortcut.trim()
    // '' disables the peek shortcut; anything else must be a valid accelerator.
    if (peek === '' || acceleratorSchema.safeParse(peek).success) out.peekShortcut = peek
  }
  if (typeof input.requestTimeoutSec === 'number' && Number.isFinite(input.requestTimeoutSec)) {
    out.requestTimeoutSec = Math.min(300, Math.max(10, Math.round(input.requestTimeoutSec)))
  }
  if (typeof input.launchOnStartup === 'boolean') out.launchOnStartup = input.launchOnStartup
  if (typeof input.noticeAcknowledged === 'boolean') out.noticeAcknowledged = input.noticeAcknowledged
  if (typeof input.updatesEnabled === 'boolean') out.updatesEnabled = input.updatesEnabled
  if (typeof input.glassTint === 'number' && Number.isFinite(input.glassTint)) {
    out.glassTint = Math.min(100, Math.max(0, Math.round(input.glassTint)))
  }
  if (typeof input.zoom === 'number' && Number.isFinite(input.zoom)) {
    out.zoom = Math.min(1.6, Math.max(0.7, Math.round(input.zoom * 100) / 100))
  }
  if (
    typeof input.maxImageBytes === 'number' &&
    Number.isFinite(input.maxImageBytes) &&
    input.maxImageBytes >= 256 * 1024 &&
    input.maxImageBytes <= 10 * 1024 * 1024
  ) {
    out.maxImageBytes = Math.round(input.maxImageBytes)
  }
  if (typeof input.onboarded === 'boolean') out.onboarded = input.onboarded
  if (input.authMethod === 'anonymous' || input.authMethod === 'google') out.authMethod = input.authMethod
  if (typeof input.authEmail === 'string') {
    const email = input.authEmail.trim()
    // Display-only value; cap the length so a corrupt file cannot bloat the UI.
    if (email.length <= 254) out.authEmail = email
  }
  if (typeof input.nudgeDismissed === 'boolean') out.nudgeDismissed = input.nudgeDismissed
  if (input.answerStyle === 'brief' || input.answerStyle === 'detailed') out.answerStyle = input.answerStyle
  return out
}

/** Helper for IPC handlers that need strict (throwing) validation. */
export function assertSettingsPatch(patch: unknown): Partial<AppSettings> {
  const result = saveSettingsSchema.safeParse(patch)
  if (!result.success) {
    throw new Error(formatZodError(result.error))
  }
  return result.data as Partial<AppSettings>
}

export { formatZodError }
