// Shared types across main, preload, and renderer processes.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface DisplayInfo {
  id: number
  bounds: Rect // DIP coordinates
  scaleFactor: number
}

/** Result of a screen-region selection, returned to the assistant renderer. */
export type SelectionResult =
  | { status: 'captured'; dataUrl: string; width: number; height: number; bytes: number; mime: 'image/png' | 'image/jpeg' }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string }

/**
 * What the `selection:start` invoke returns. The actual crop/cancel outcome
 * ALWAYS arrives later as a pushed `selection:result` event — that keeps
 * renderer-initiated selections (button) and main-initiated ones (the
 * direct-capture global shortcut) on a single delivery path.
 */
export type SelectionStartResult = { status: 'started' } | { status: 'failed'; message: string }

/** Result of importing an image from the clipboard or a dropped file. */
export type ImageImportResult =
  | { ok: true; dataUrl: string; width: number; height: number; bytes: number; mime: 'image/png' | 'image/jpeg' }
  | { ok: false; message: string }

/**
 * How the app reaches a model.
 *  - `hosted`: Screen Scout's relay holds the credential; no key needed.
 *  - `byok`:   the user's own key, sent straight to the configured endpoint.
 */
export type AccessMode = 'hosted' | 'byok'

/** Free-tier usage returned by the relay (also used by the Settings meter). */
export interface HostedQuota {
  dayUsed: number
  dayLimit: number
  dayRemaining: number
  dayResetAt: number
  windowUsed: number
  windowLimit: number
  windowRemaining: number
  windowResetAt: number
}

/** Non-secret application settings. The API key is never included here. */
export interface AppSettings {
  /** Vision-capable NVIDIA NIM model id, e.g. meta/llama-3.2-90b-vision-instruct */
  model: string
  /** Chat-completions endpoint. Configurable so self-hosted NIM can be used later. */
  baseUrl: string
  /** Hosted relay (no key) or the user's own key. */
  accessMode: AccessMode
  /** Random per-install id for the hosted free tier. Carries no personal data. */
  deviceId: string
  /** Electron accelerator, e.g. "Shift+R" */
  shortcut: string
  /**
   * Electron accelerator that jumps straight to screen selection
   * (skipping the popup), e.g. "Shift+C". Empty string = disabled.
   */
  captureShortcut: string
  /**
   * Electron accelerator that hides the popup WITHOUT resetting the session —
   * showing it again restores the conversation, attachment, and draft
   * exactly where the user left off. e.g. "Shift+S". Empty string = disabled.
   */
  peekShortcut: string
  /** Request timeout in seconds. */
  requestTimeoutSec: number
  /** Launch the app when the user logs into Windows. */
  launchOnStartup: boolean
  /** Whether the user acknowledged the first-upload privacy notice. */
  noticeAcknowledged: boolean
  /** Configurable cap on encoded image payload size (bytes of the data URL). */
  maxImageBytes: number
}

export const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024 // 5 MB of encoded image data

export interface PublicSettings extends AppSettings {
  /** True when an API key is stored (the key itself never leaves the main process). */
  hasApiKey: boolean
  /** True when the key is protected by OS-backed encryption rather than session-only memory. */
  keyStorageSecure: boolean
  /** True when this build was compiled with a hosted relay URL. */
  hostedAvailable: boolean
  /** Last known free-tier usage (null until the relay is contacted). */
  hostedQuota: HostedQuota | null
  /** Short status describing the global shortcut registration. */
  shortcutStatus: 'registered' | 'failed'
  shortcutError?: string
  /** Status of the direct-capture shortcut ('disabled' when none is set). */
  captureShortcutStatus: 'registered' | 'failed' | 'disabled'
  captureShortcutError?: string
  /** Status of the peek shortcut (hide/show without resetting the session). */
  peekShortcutStatus: 'registered' | 'failed' | 'disabled'
  peekShortcutError?: string
}

export type ChatRole = 'user' | 'assistant'

/** One prior turn sent as context for a follow-up question. */
export interface ChatTurn {
  role: ChatRole
  content: string
}

export interface ChatErrorMessage {
  code:
    | 'no-key'
    | 'invalid-key'
    | 'payment-required'
    | 'rate-limit'
    /** The free hosted tier is used up for now. */
    | 'quota-exceeded'
    /** The hosted relay could not be reached or is at capacity. */
    | 'hosted-unavailable'
    | 'bad-request'
    | 'unsupported-image'
    | 'network'
    | 'timeout'
    /** The stream produced data, then went silent for the full timeout. */
    | 'stalled'
    | 'server'
    | 'empty-response'
    | 'cancelled'
    | 'unknown'
  /** Plain-language, user-facing message (no API key, no raw payload). */
  message: string
  /** Optional technical detail for the expandable section (status code, sanitized snippet). */
  detail?: string
  retryable: boolean
  /** For quota/rate limits: seconds until the user can try again. */
  retryAfterSec?: number
}

export type ChatEvent =
  | { type: 'delta'; requestId: string; text: string }
  | {
      type: 'complete'
      requestId: string
      text: string
      /** Real model id that served this answer (when the endpoint reports one). */
      servedModel?: string
      /** Relay routing hint ('groq' | 'cf' | ...). */
      servedProvider?: string
    }
  | { type: 'error'; requestId: string; error: ChatErrorMessage }

export interface SendMessageResult {
  status: 'accepted' | 'busy' | 'error'
  message?: string
}

export interface ConnectionTestResult {
  ok: boolean
  message: string
  detail?: string
}

/** Chat message as stored in the renderer conversation state. */
export interface UIMessage {
  id: string
  role: ChatRole
  kind: 'text' | 'image' | 'error' | 'cancelled'
  /** Markdown text (user prompts are plain text). */
  content: string
  /** Present on the user message that carried an attachment. */
  attachment?: { width: number; height: number; dataUrl: string }
  /** Present while the assistant response is still arriving. */
  pending?: boolean
  error?: ChatErrorMessage
  timestamp: number
}
