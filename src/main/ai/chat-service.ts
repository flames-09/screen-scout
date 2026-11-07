import { BrowserWindow, net } from 'electron'
import type {
  AppSettings,
  ChatErrorMessage,
  ChatEvent,
  ChatTurn,
  ConnectionTestResult,
  HostedQuota
} from '@shared/types'
import { HOSTED_MAX_IMAGE_BYTES, HOSTED_PUBLIC_MODEL } from '@shared/hosted'
import { buildNimRequest, nimError, streamNimChat, type BuiltRequest, type FetchLike } from './nim-client'
import { HostedError, type HostedClient } from './hosted-client'
import { TEST_IMAGE_DATA_URL } from '../capture/image-processing'

/**
 * Main-process orchestrator for chat requests.
 *
 * - Holds the API key (BYOK mode) or device token (hosted mode); the renderer
 *   only sends message text, an optional image data URL, and trimmed history.
 * - One in-flight request per assistant window; duplicate sends are rejected.
 * - Every request has an id so late chunks from cancelled/superseded requests
 *   are ignored by the renderer.
 * - Emits `chat:event` to the assistant window: delta / complete / error.
 *
 * API requests go through Electron's `net.fetch` (Chromium's network stack)
 * rather than Node's undici `fetch`: Chromium pools connections with a much
 * longer keep-alive, speaks HTTP/2 to the endpoint, and honors the system
 * proxy configuration — so follow-up turns reuse a warm TLS connection
 * instead of re-handshaking, and corporate proxy setups just work.
 */

interface ActiveRequest {
  controller: AbortController
  windowId: number
}

export class ChatService {
  private active = new Map<string, ActiveRequest>()

  constructor(
    private deps: {
      getSettings(): AppSettings
      getApiKey(): string | null
      /** The hosted relay client (may be unavailable when no URL is baked in). */
      getHosted(): HostedClient
      /** Lets the main process cache the latest quota for Settings/EmptyState. */
      onHostedQuota?(quota: HostedQuota | null): void
    }
  ) {}

  private emit(window: BrowserWindow, event: ChatEvent): void {
    if (!window.isDestroyed()) {
      window.webContents.send('chat:event', event)
    }
  }

  isBusyFor(windowId: number): boolean {
    for (const req of this.active.values()) {
      if (req.windowId === windowId) return true
    }
    return false
  }

  cancel(requestId: string): void {
    const req = this.active.get(requestId)
    if (req) {
      req.controller.abort()
      // The 'cancelled' error event is emitted by the request loop itself.
    }
  }

  /** Cancels every request belonging to a window (used when the popup hides). */
  cancelAllFor(windowId: number): void {
    for (const req of this.active.values()) {
      if (req.windowId === windowId) req.controller.abort()
    }
  }

  async send(
    window: BrowserWindow,
    input: {
      requestId: string
      text: string
      imageDataUrl?: string
      history: ChatTurn[]
    }
  ): Promise<void> {
    const { requestId, text, imageDataUrl, history } = input
    if (this.active.has(requestId)) return

    const settings = this.deps.getSettings()
    const hosted = this.deps.getHosted()
    const useHosted = settings.accessMode === 'hosted'
    const apiKey = this.deps.getApiKey()

    const fail = (error: ChatErrorMessage) => {
      this.active.delete(requestId)
      this.emit(window, { type: 'error', requestId, error })
    }

    if (useHosted) {
      if (!hosted.isAvailable()) {
        fail(
          nimError('hosted-unavailable', {
            detail: 'This build has no hosted relay URL configured. Switch to your own API key in Settings.'
          })
        )
        return
      }
    } else if (!apiKey) {
      fail(nimError('no-key'))
      return
    }

    // The relay caps the whole request body (6 MB by default), so base64
    // inflation means the hosted image must stay smaller than a BYOK one.
    const maxImageBytes = useHosted
      ? Math.min(settings.maxImageBytes, HOSTED_MAX_IMAGE_BYTES)
      : settings.maxImageBytes
    if (imageDataUrl && imageDataUrl.length > maxImageBytes) {
      fail({
        code: 'unsupported-image',
        message:
          'The selected image is too large to send. Select a smaller area, or retake the capture closer to the content you need.',
        detail: `Encoded size ${(imageDataUrl.length / 1024 / 1024).toFixed(1)} MB exceeds the ${(maxImageBytes / 1024 / 1024).toFixed(0)} MB limit.`,
        retryable: false
      })
      return
    }

    const trimmedHistory = trimHistory(history)
    const buildRequest = (headers?: Record<string, string>): BuiltRequest =>
      buildNimRequest({
        baseUrl: useHosted ? hosted.chatUrl() : settings.baseUrl,
        ...(useHosted ? {} : { apiKey: apiKey ?? undefined }),
        ...(headers ? { headers } : {}),
        model: useHosted ? HOSTED_PUBLIC_MODEL : settings.model,
        history: trimmedHistory,
        userText: text,
        imageDataUrl,
        maxTokens: 2048,
        temperature: 0.2,
        stream: true
      })

    // Register the request BEFORE acquiring a hosted token (which may hit the
    // network): otherwise Stop does nothing while registration is in flight.
    const controller = new AbortController()
    this.active.set(requestId, { controller, windowId: window.id })

    try {
      let headers: Record<string, string> | undefined
      if (useHosted) {
        try {
          headers = await hosted.chatHeaders(false, controller.signal)
        } catch (error) {
          throw controller.signal.aborted ? nimError('cancelled') : hostedFailure(error)
        }
      }

      let request = buildRequest(headers)
      let sawOutput = false
      let refreshedToken = false
      let outcome: Awaited<ReturnType<typeof streamNimChat>> | undefined

      for (;;) {
        try {
          outcome = await streamNimChat(request, {
            signal: controller.signal,
            timeoutMs: settings.requestTimeoutSec * 1000,
            fetchImpl: net.fetch as unknown as FetchLike,
            hosted: useHosted,
            onDelta: (delta) => {
              // A request that was cancelled mid-stream must not deliver more deltas.
              if (controller.signal.aborted) return
              sawOutput = true
              this.emit(window, { type: 'delta', requestId, text: delta })
            }
          })
          break
        } catch (error) {
          // The relay rejects an expired/invalid device token with 401. Refresh
          // once and retry — but only if nothing has been streamed yet, so the
          // user never sees duplicated text.
          if (
            useHosted &&
            !refreshedToken &&
            !sawOutput &&
            isChatError(error) &&
            error.code === 'invalid-key'
          ) {
            refreshedToken = true
            headers = await hosted.chatHeaders(true, controller.signal)
            request = buildRequest(headers)
            continue
          }
          throw error
        }
      }

      if (outcome)
        this.emit(window, {
          type: 'complete',
          requestId,
          text: outcome.text,
          ...(outcome.servedModel ? { servedModel: outcome.servedModel } : {}),
          ...(outcome.servedProvider ? { servedProvider: outcome.servedProvider } : {})
        })
    } catch (error) {
      let chatError: ChatErrorMessage =
        isChatError(error) || error instanceof HostedError
          ? hostedFailure(error)
          : nimError('unknown', { retryable: false })
      // Only user-cancel paths abort this controller (stall timers live inside
      // streamNimChat), so an aborted controller always means "cancelled" —
      // including a Stop pressed during the one-shot token refresh.
      if (controller.signal.aborted) {
        chatError = nimError('cancelled')
      } else if (useHosted && chatError.code === 'invalid-key') {
        // A rejected device token is a relay problem, not a NVIDIA API key the
        // hosted user never entered — rewrite the BYOK wording.
        chatError = nimError('hosted-unavailable', { detail: chatError.detail })
      }
      this.emit(window, { type: 'error', requestId, error: chatError })
    } finally {
      this.active.delete(requestId)
      if (useHosted) void this.refreshQuota()
    }
  }

  /**
   * Verifies the configured model/endpoint accepts a small image payload.
   * Uses a non-streaming minimal request with a 16x16 PNG.
   */
  async testConnection(overrides?: { baseUrl?: string; model?: string }): Promise<ConnectionTestResult> {
    const settings = this.deps.getSettings()
    const hosted = this.deps.getHosted()

    // Hosted mode: "testing" means checking the relay + quota, not spending a
    // question on a real completion. The renderer always passes the BYOK
    // drafts, so ignore overrides entirely here — the relay owns the endpoint
    // and model in this mode.
    if (settings.accessMode === 'hosted') {
      const result = await hosted.testConnection()
      void this.refreshQuota()
      return result
    }

    const apiKey = this.deps.getApiKey()
    const baseUrl = overrides?.baseUrl?.trim() || settings.baseUrl
    const model = overrides?.model?.trim() || settings.model

    if (!apiKey) {
      return { ok: false, message: 'No API key saved yet. Add your NVIDIA API key first.' }
    }

    const request = buildNimRequest({
      baseUrl,
      apiKey,
      model,
      userText: 'Reply with exactly: OK',
      imageDataUrl: TEST_IMAGE_DATA_URL,
      maxTokens: 16,
      temperature: 0,
      stream: false
    })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      const outcome = await streamNimChat(request, {
        signal: controller.signal,
        timeoutMs: 20_000,
        fetchImpl: net.fetch as unknown as FetchLike,
        onDelta: () => {}
      })
      return {
        ok: true,
        message: `Connected. ${model} accepted an image and replied.`,
        detail: outcome.text.slice(0, 200)
      }
    } catch (error) {
      const chatError: ChatErrorMessage = isChatError(error) ? error : nimError('unknown', { retryable: false })
      return { ok: false, message: chatError.message, detail: chatError.detail }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Refreshes the cached quota used by Settings and the empty state. */
  async refreshQuota(): Promise<HostedQuota | null> {
    const quota = await this.deps.getHosted().fetchQuota()
    try {
      this.deps.onHostedQuota?.(quota)
    } catch {
      // A listener throwing must never break a chat flow.
    }
    return quota
  }

  dispose(): void {
    for (const req of this.active.values()) req.controller.abort()
    this.active.clear()
  }
}

/** Turns relay/transport failures into user-facing chat errors. */
function hostedFailure(error: unknown): ChatErrorMessage {
  if (isChatError(error)) return error
  if (error instanceof HostedError) {
    if (error.code === 'network' || error.code === 'unavailable') {
      return nimError('hosted-unavailable', { detail: error.message })
    }
    return nimError('server', { detail: error.message, retryable: false })
  }
  return nimError('unknown', { retryable: false })
}

const MAX_HISTORY_TURNS = 8
const MAX_HISTORY_CHARS = 60_000

function trimHistory(history: ChatTurn[]): ChatTurn[] {
  const recent = history.slice(-MAX_HISTORY_TURNS)
  let total = 0
  const out: ChatTurn[] = []
  for (let i = recent.length - 1; i >= 0; i--) {
    const turn = recent[i]
    // Empty turns (e.g. an image-only prompt) carry no context for the model
    // and some endpoints reject empty content outright — drop them.
    if (turn.content.trim() === '') continue
    if (total + turn.content.length > MAX_HISTORY_CHARS) break
    total += turn.content.length
    out.unshift(turn)
  }
  return out
}

function isChatError(value: unknown): value is ChatErrorMessage {
  return (
    typeof value === 'object' && value !== null && 'code' in value && typeof (value as { message?: unknown }).message === 'string'
  )
}
