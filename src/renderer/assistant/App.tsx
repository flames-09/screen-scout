import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { MAX_IMAGE_DATA_URL_CHARS, IMPORT_MAX_IMAGE_BYTES } from '@shared/schemas'
import type { ChatEvent, PublicSettings, UIMessage } from '@shared/types'
import {
  canSend,
  chatReducer,
  effectivePrompt,
  historyForContext,
  initialChatState,
  isBusy,
  isRequestActive,
  type Attachment
} from './chat-state'
import { AssistantHeader } from '../components/AssistantHeader'
import { ChatMessage } from '../components/ChatMessage'
import { Composer } from '../components/Composer'
import { EmptyState } from '../components/EmptyState'
import { OnboardingOverlay } from '../components/OnboardingOverlay'
import { PrivacyNotice } from '../components/PrivacyNotice'
import { RedactEditor } from '../components/RedactEditor'
import { ResizeGrip, useAutoScroll } from '../components/ResizeGrip'
import { ScreenshotAttachment } from '../components/ScreenshotAttachment'
import { isAttachableImageMime } from '@shared/image-policy'

const QUICK_PROMPTS = [
  "Explain what I'm looking at.",
  'Find the error and suggest a fix.',
  'Summarize the important details.',
  'Read the visible text.'
]

interface PendingPrompt {
  text: string
}

/**
 * Honest label for the header chip: what actually served the last answer.
 * Cloudflare's translated chunks carry the public alias (scout-vision-1), so
 * map that to the configured multimodal model; Groq and NVIDIA chunks carry
 * the real id.
 */
const MODEL_PRETTY: Record<string, string> = {
  'scout-vision-1': 'Llama 4 Scout',
  'meta/llama-3.2-90b-vision-instruct': 'Llama 3.2 90B',
  'openai/gpt-oss-120b': 'GPT-OSS 120B',
  'openai/gpt-oss-20b': 'GPT-OSS 20B'
}

function servedModelLabel(model: string | null, provider: string | null): string | null {
  if (!model && !provider) return null
  const host =
    provider === 'cf'
      ? 'Cloudflare'
      : provider === 'groq'
        ? 'Groq'
        : provider === 'nvidia'
          ? 'NVIDIA'
          : null
  const pretty = model && model in MODEL_PRETTY
    ? MODEL_PRETTY[model]
    : model
      ? model.includes('/')
        ? model.split('/')[1]
        : model
      : ''
  if (pretty && host) return `${pretty} on ${host}`
  return pretty || host
}

export function AssistantApp(): JSX.Element {
  const [state, dispatch] = useReducer(chatReducer, undefined, initialChatState)
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [nudgeError, setNudgeError] = useState<string | null>(null)
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(null)
  const [backdrop, setBackdrop] = useState<string | null>(null)
  const [redacting, setRedacting] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const stateRef = useRef(state)
  stateRef.current = state
  // Mirrors the onboarding gate for the Esc handler (defined later in render).
  const showOnboardingRef = useRef(false)

  // ---- Bootstrap -------------------------------------------------------------
  useEffect(() => {
    void window.scout.settings.get().then(setSettings)
  }, [])

  const refreshSettings = useCallback((): void => {
    void window.scout.settings.get().then(setSettings)
  }, [])

  useEffect(() => {
    const onFocused = (): void => refreshSettings()
    window.addEventListener('focus', onFocused)
    return () => window.removeEventListener('focus', onFocused)
  }, [refreshSettings])

  // Live updates: main pushes settings after every save (model chip, key
  // state) — no window-focus refetch needed.
  useEffect(() => {
    return window.scout.settings.onChanged((updated) => setSettings(updated))
  }, [])

  // Glass tint: publish the user's tint strength as a CSS variable so the
  // .glass-root/.glass-backdrop gradients (app.css) restyle instantly.
  useEffect(() => {
    if (typeof settings?.glassTint === 'number') {
      document.documentElement.style.setProperty('--glass-tint', String(settings.glassTint))
    }
  }, [settings?.glassTint])

  // ---- Chat events -------------------------------------------------------------
  // Deltas are batched on a ~40ms trailing timer: react-markdown re-parses the
  // whole growing message on every render, so dispatching per-token makes long
  // answers progressively slower. Batching collapses a frame's worth of tokens
  // into one dispatch/parse. complete/error flush the buffer synchronously so
  // ordering always holds (the reducer also guards by requestId).
  const pendingDeltas = useRef(new Map<string, string>())
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flushDeltas = useCallback((): void => {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current)
      flushTimer.current = null
    }
    if (pendingDeltas.current.size === 0) return
    const batch = [...pendingDeltas.current.entries()]
    pendingDeltas.current.clear()
    for (const [requestId, text] of batch) {
      dispatch({ type: 'chat-delta', requestId, text })
    }
  }, [])

  useEffect(() => {
    return window.scout.chat.onEvent((event: ChatEvent) => {
      if (event.type === 'delta') {
        pendingDeltas.current.set(
          event.requestId,
          (pendingDeltas.current.get(event.requestId) ?? '') + event.text
        )
        if (!flushTimer.current) {
          flushTimer.current = setTimeout(flushDeltas, 40)
        }
      } else if (event.type === 'complete') {
        flushDeltas()
        dispatch({
          type: 'chat-complete',
          requestId: event.requestId,
          text: event.text,
          servedModel: event.servedModel,
          servedProvider: event.servedProvider
        })
      } else if (event.type === 'error') {
        flushDeltas()
        dispatch({ type: 'chat-error', requestId: event.requestId, error: event.error })
      }
    })
  }, [flushDeltas])

  // ---- Selection results (pushed for BOTH the button flow and the
  // direct-capture global shortcut) ---------------------------------------------
  useEffect(() => {
    return window.scout.selection.onSelectionResult((result) => {
      if (result.status === 'captured') {
        dispatch({
          type: 'selection-captured',
          attachment: {
            dataUrl: result.dataUrl,
            width: result.width,
            height: result.height,
            bytes: result.bytes,
            mime: result.mime
          }
        })
      } else if (result.status === 'failed') {
        dispatch({ type: 'selection-failed', message: result.message })
      } else {
        dispatch({ type: 'selection-cancelled' })
      }
    })
  }, [])

  // ---- Image imports: clipboard paste + dropped files ---------------------------
  const redactingRef = useRef(redacting)
  redactingRef.current = redacting

  const importImageFile = useCallback(async (file: File): Promise<void> => {
    if (redactingRef.current) return // never swap the image under the open editor
    if (isRequestActive(stateRef.current)) {
      dispatch({ type: 'selection-failed', message: 'Wait for the current answer to finish, then attach the image.' })
      return
    }
    // Refuse huge files BEFORE reading them into memory (renderer is
    // untrusted territory here — main re-validates the bytes anyway).
    if (file.size > IMPORT_MAX_IMAGE_BYTES) {
      dispatch({ type: 'selection-failed', message: 'Image is too large to attach (limit 32 MB).' })
      return
    }
    if (!isAttachableImageMime(file.type)) {
      dispatch({ type: 'selection-failed', message: 'Only PNG and JPEG images can be attached.' })
      return
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const result = await window.scout.images.importBytes(bytes)
      if (result.ok) {
        dispatch({
          type: 'attachment-added',
          attachment: {
            dataUrl: result.dataUrl,
            width: result.width,
            height: result.height,
            bytes: result.bytes,
            mime: result.mime
          }
        })
      } else {
        dispatch({ type: 'selection-failed', message: result.message })
      }
    } catch {
      dispatch({ type: 'selection-failed', message: "Couldn't read that image. Try again." })
    }
  }, [])

  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const items = e.clipboardData?.items
      if (!items) return
      const imageItem = [...items].find((i) => i.kind === 'file' && isAttachableImageMime(i.type))
      if (imageItem) {
        const file = imageItem.getAsFile()
        if (file) {
          e.preventDefault()
          void importImageFile(file)
        }
        return
      }
      // Bitmap-only clipboards (e.g. some capture tools) expose no file item
      // and no text — fall back to the main-process clipboard read.
      const hasText = [...items].some((i) => i.kind === 'string')
      if (!hasText && !redactingRef.current) {
        e.preventDefault()
        void window.scout.images.fromClipboard().then((result) => {
          if (isRequestActive(stateRef.current)) return
          if (result.ok) {
            dispatch({
              type: 'attachment-added',
              attachment: {
                dataUrl: result.dataUrl,
                width: result.width,
                height: result.height,
                bytes: result.bytes,
                mime: result.mime
              }
            })
          } else {
            dispatch({ type: 'selection-failed', message: result.message })
          }
        })
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [importImageFile])

  const onDragOver = useCallback((e: React.DragEvent): void => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      setDragOver(true)
    }
  }, [])

  const onDragLeave = useCallback((e: React.DragEvent): void => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false)
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent): void => {
      e.preventDefault()
      setDragOver(false)
      const file = [...e.dataTransfer.files].find((f) => isAttachableImageMime(f.type))
      if (file) {
        void importImageFile(file)
      } else if (e.dataTransfer.files.length > 0) {
        dispatch({ type: 'selection-failed', message: 'Only PNG and JPEG images can be attached.' })
      }
    },
    [importImageFile]
  )

  // ---- Hide semantics -------------------------------------------------------------
  // Hard hide (Shift+R, Esc, close): reset the session entirely.
  // Peek hide (Shift+S): keep the conversation, attachment, draft, redact
  // editor, and in-flight streams — showing again lands where the user left
  // off. The frost (a desktop screenshot) is dropped in BOTH paths.
  useEffect(() => {
    return window.scout.window.onVisibility((payload) => {
      if (payload.visible) return
      setDragOver(false)
      setBackdrop(null) // drop the desktop screenshot from memory
      if (payload.resetSession === false) return // peek: everything else survives
      setPendingPrompt(null)
      setRedacting(false)
      // Drop any unflushed stream deltas — their request is cancelled below
      // in main and the reducer would reject them anyway (requestId guard).
      if (flushTimer.current) {
        clearTimeout(flushTimer.current)
        flushTimer.current = null
      }
      pendingDeltas.current.clear()
      dispatch({ type: 'clear-session' })
    })
  }, [])

  // ---- Frosted-glass backdrop (desktop behind the window, sent pre-show) ---------
  useEffect(() => {
    return window.scout.window.onBackdrop(setBackdrop)
  }, [])

  // ---- Esc: cancel redaction → dismiss notice → clear error → hide ---------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.repeat) return
      if (showOnboardingRef.current) return // the setup gate must be answered first
      if (redacting) {
        setRedacting(false)
        return
      }
      if (pendingPrompt) {
        setPendingPrompt(null)
        return
      }
      void window.scout.window.hide()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pendingPrompt, redacting])

  // ---- Selection -------------------------------------------------------------------
  const handleSelect = useCallback(async (): Promise<void> => {
    if (isRequestActive(stateRef.current)) return // never mid-request
    dispatch({ type: 'selection-started' })
    try {
      // The crop/cancel outcome arrives via onSelectionResult above.
      const started = await window.scout.selection.start()
      if (started.status === 'failed') {
        dispatch({ type: 'selection-failed', message: started.message })
      }
    } catch {
      dispatch({
        type: 'selection-failed',
        message: "Couldn't start screen selection. Try again."
      })
    }
  }, [])

  // ---- Sending ----------------------------------------------------------------------
  const performSend = useCallback(
    async (input: { text: string; imageDataUrl?: string; attachmentMeta?: Attachment; history: UIMessage[] }): Promise<void> => {
      const requestId = crypto.randomUUID()
      dispatch({
        type: 'send-started',
        requestId,
        text: input.text,
        attachment: input.attachmentMeta ?? null
      })
      try {
        const result = await window.scout.chat.send({
          requestId,
          text: input.text,
          imageDataUrl: input.imageDataUrl,
          history: historyForContext(input.history)
        })
        if (result.status === 'error' || result.status === 'busy') {
          dispatch({
            type: 'chat-error',
            requestId,
            error: {
              code: 'unknown',
              message: result.message || 'The request could not be started.',
              retryable: false
            }
          })
        }
      } catch (error) {
        dispatch({
          type: 'chat-error',
          requestId,
          error: {
            code: 'unknown',
            message: 'The request could not be started. Try again.',
            detail: error instanceof Error ? error.message : undefined,
            retryable: false
          }
        })
      }
    },
    []
  )

  const handleSend = useCallback((): void => {
    const current = stateRef.current
    if (redacting) return // finish (or cancel) the redaction edit first
    if (!canSend(current) || pendingPrompt) return
    const text = effectivePrompt(current)
    if (text === null) return
    const attachment = current.attachment
    if (attachment && !(settings?.noticeAcknowledged ?? false)) {
      setPendingPrompt({ text })
      return
    }
    void performSend({
      text,
      imageDataUrl: attachment?.dataUrl,
      attachmentMeta: attachment ?? undefined,
      history: current.messages
    })
  }, [performSend, pendingPrompt, settings, redacting])

  const handleNoticeChoice = useCallback(
    (choice: 'once' | 'always' | 'cancel'): void => {
      const pending = pendingPrompt
      setPendingPrompt(null)
      if (!pending || choice === 'cancel') return
      const current = stateRef.current
      if (choice === 'always') {
        void window.scout.settings
          .save({ noticeAcknowledged: true })
          .then((s) => setSettings(s))
          .catch(() => undefined)
      }
      const attachment = current.attachment
      void performSend({
        text: pending.text,
        imageDataUrl: attachment?.dataUrl,
        attachmentMeta: attachment ?? undefined,
        history: current.messages
      })
    },
    [pendingPrompt, performSend]
  )

  // ---- Retry: re-send the exact user turn that failed ----------------------------
  const handleRetry = useCallback(
    (errorMessageId: string): void => {
      if (isRequestActive(stateRef.current)) return // never mid-request
      const current = stateRef.current
      const idx = current.messages.findIndex((m) => m.id === errorMessageId)
      if (idx === -1) return
      const before = current.messages.slice(0, idx)
      const lastUserIdx = before.map((m) => m.role).lastIndexOf('user')
      if (lastUserIdx === -1) return
      const lastUser = before[lastUserIdx]
      dispatch({ type: 'retry', errorMessageId })
      const attachmentMeta: Attachment | undefined = lastUser.attachment
        ? {
            dataUrl: lastUser.attachment.dataUrl,
            width: lastUser.attachment.width,
            height: lastUser.attachment.height,
            bytes: 0,
            mime: 'image/png'
          }
        : undefined
      void performSend({
        text: lastUser.content,
        imageDataUrl: lastUser.attachment?.dataUrl,
        attachmentMeta,
        history: before.slice(0, lastUserIdx)
      })
    },
    [performSend]
  )

  // ---- Stop the in-flight request -------------------------------------------------
  const handleStop = useCallback((): void => {
    const id = stateRef.current.activeRequestId
    if (id) void window.scout.chat.cancel(id)
  }, [])

  // ---- Clear chat ----------------------------------------------------------------------
  const handleClear = useCallback((): void => {
    // Cancel any in-flight request first so main-side state matches the
    // cleared renderer session (otherwise the next send would hit "busy").
    const activeId = stateRef.current.activeRequestId
    if (activeId) void window.scout.chat.cancel(activeId)
    dispatch({ type: 'clear-session' })
  }, [])

  const handleOpenSettings = useCallback((): void => {
    void window.scout.settings.open()
  }, [])

  // ---- Onboarding gate + hosted nudge ------------------------------------------
  const handleOnboardGoogle = useCallback(async (): Promise<string | null> => {
    try {
      const result = await window.scout.settings.hostedSignInWithGoogle()
      if (result.ok) {
        refreshSettings()
        return null
      }
      return result.message ?? 'Google sign-in failed. Try again.'
    } catch {
      return 'Google sign-in failed. Try again.'
    }
  }, [refreshSettings])

  const handleOnboardOwnKey = useCallback((): void => {
    void window.scout.settings.hostedOnboardWithOwnKey().then(refreshSettings)
    void window.scout.settings.open()
  }, [refreshSettings])

  const handleNudgeSignIn = useCallback((): void => {
    setNudgeError(null)
    void window.scout.settings.hostedSignInWithGoogle().then((result) => {
      if (result.ok) refreshSettings()
      else setNudgeError(result.message ?? 'Google sign-in failed. Try again.')
    })
  }, [refreshSettings])

  const handleDismissNudge = useCallback((): void => {
    void window.scout.settings.hostedDismissNudge().then(refreshSettings)
  }, [refreshSettings])

  const showOnboarding = settings !== null && !settings.onboarded
  showOnboardingRef.current = showOnboarding
  const showNudge =
    settings !== null &&
    settings.onboarded &&
    settings.accessMode === 'hosted' &&
    settings.authMethod === 'anonymous' &&
    settings.hostedAvailable &&
    !settings.nudgeDismissed

  // ---- Render helpers -------------------------------------------------------------------
  const busy = isBusy(state.phase)
  const showQuickPrompts = state.attachment !== null && state.messages.length === 0 && !busy
  const [scrollRef, onScroll] = useAutoScroll(
    `${state.messages.length}:${state.messages[state.messages.length - 1]?.content.length ?? 0}`
  )

  const messagesList = useMemo(() => state.messages, [state.messages])

  return (
    <div
      className={`glass-root assistant-root${dragOver ? ' drag-over' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {backdrop && (
        <div
          className="glass-backdrop"
          style={{ ['--backdrop-image' as string]: `url("${backdrop}")` } as CSSProperties}
          aria-hidden="true"
        />
      )}
      {showOnboarding && settings && (
        <OnboardingOverlay
          hostedAvailable={settings.hostedAvailable}
          onGoogle={handleOnboardGoogle}
          onOwnKey={handleOnboardOwnKey}
        />
      )}
      <AssistantHeader
        model={
          settings?.accessMode === 'hosted'
            ? (servedModelLabel(state.servedModel, state.servedProvider) ??
              (settings.hostedAvailable ? 'Free hosted' : 'Hosted mode unavailable'))
            : (servedModelLabel(state.servedModel, state.servedProvider) ?? settings?.model ?? '…')
        }
        busy={busy}
        canClear={state.messages.length > 0 || state.attachment !== null || state.draft.length > 0}
        onClear={handleClear}
        onOpenSettings={handleOpenSettings}
        onHide={() => void window.scout.window.hide()}
      />

      {showNudge && (
        <div className="nudge-banner" role="status">
          <span>Want more free usage? Sign in with Google for 5 screenshots and 50 chats a day.</span>
          <span className="nudge-actions">
            <button type="button" className="btn btn-ghost" onClick={handleNudgeSignIn}>
              Sign in with Google
            </button>
            <button type="button" className="btn btn-ghost" onClick={handleDismissNudge}>
              Not now
            </button>
          </span>
          {nudgeError && (
            <span className="nudge-error" role="alert">
              {nudgeError}
            </span>
          )}
        </div>
      )}

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll} role="log" aria-label="Conversation">
        <EmptyState
          canSend={
            settings?.accessMode === 'hosted'
              ? (settings?.hostedAvailable ?? false)
              : (settings?.hasApiKey ?? false)
          }
          hosted={settings?.accessMode === 'hosted'}
          hasMessages={state.messages.length > 0}
          onOpenSettings={handleOpenSettings}
          onSelect={() => void handleSelect()}
        />
        {messagesList.map((m) => (
          <ChatMessage
            key={m.id}
            message={m}
            busy={busy}
            onRetry={() => handleRetry(m.id)}
            onOpenSettings={handleOpenSettings}
          />
        ))}
      </div>

      <div className="assistant-bottom">
        {state.captureError && (
          <div className="toast error" role="alert">
            {state.captureError}
          </div>
        )}
        {state.attachment && redacting && (
          <RedactEditor
            attachment={state.attachment}
            limit={Math.min(settings?.maxImageBytes ?? Number.MAX_SAFE_INTEGER, MAX_IMAGE_DATA_URL_CHARS)}
            onApply={(next) => {
              dispatch({ type: 'attachment-redacted', attachment: next })
              setRedacting(false)
            }}
            onCancel={() => setRedacting(false)}
          />
        )}
        {state.attachment && !redacting && (
          <ScreenshotAttachment
            attachment={state.attachment}
            busy={busy}
            onRedact={() => setRedacting(true)}
            onRetake={() => void handleSelect()}
            onRemove={() => dispatch({ type: 'attachment-removed' })}
          />
        )}
        {showQuickPrompts && (
          <div className="quick-prompts" aria-label="Suggested questions">
            {QUICK_PROMPTS.map((p) => (
              <button key={p} type="button" className="quick-prompt" onClick={() => dispatch({ type: 'draft', text: p })}>
                {p}
              </button>
            ))}
          </div>
        )}
        {pendingPrompt && (
          <PrivacyNotice
            mode={settings?.accessMode ?? 'byok'}
            onSendOnce={() => handleNoticeChoice('once')}
            onAlwaysAllow={() => handleNoticeChoice('always')}
            onCancel={() => handleNoticeChoice('cancel')}
          />
        )}
        <Composer
          value={state.draft}
          onChange={(text) => dispatch({ type: 'draft', text })}
          onSend={handleSend}
          onStop={handleStop}
          onSelect={() => void handleSelect()}
          canSend={canSend(state) && !pendingPrompt}
          busy={busy}
          selecting={state.phase === 'selecting'}
        />
      </div>

      <ResizeGrip />
    </div>
  )
}
