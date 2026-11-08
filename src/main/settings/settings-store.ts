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
  maxImageBytes: DEFAULT_MAX_IMAGE_BYTES
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
  if (
    typeof input.maxImageBytes === 'number' &&
    Number.isFinite(input.maxImageBytes) &&
    input.maxImageBytes >= 256 * 1024 &&
    input.maxImageBytes <= 10 * 1024 * 1024
  ) {
    out.maxImageBytes = Math.round(input.maxImageBytes)
  }
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
