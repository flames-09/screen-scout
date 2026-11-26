import type { ChatErrorMessage, UIMessage } from '@shared/types'

/**
 * Conversation state machine for the assistant popup.
 *
 * States: ready → selecting → image-attached → sending → streaming → complete
 *         (with `error` reachable from sending/streaming).
 *
 * Guarantees:
 *  - Duplicate sends are impossible while a request is pending.
 *  - Deltas from a cancelled/superseded request id are ignored.
 *  - Hiding the popup resets the session (draft + unsent crop discarded —
 *    nothing is persisted anywhere).
 */

export type ChatPhase =
  | 'ready'
  | 'selecting'
  | 'image-attached'
  | 'sending'
  | 'streaming'
  | 'complete'
  | 'error'

export interface Attachment {
  dataUrl: string
  width: number
  height: number
  bytes: number
  mime: string
}

export interface ChatState {
  phase: ChatPhase
  messages: UIMessage[]
  attachment: Attachment | null
  draft: string
  activeRequestId: string | null
  /** Set when the user hit Send but hasn't acknowledged the upload notice yet. */
  privacyPending: { text: string } | null
  /** Transient, non-chat error (e.g. capture failed). */
  captureError: string | null
  /** What actually served the last answer (real model id + relay provider). */
  servedModel: string | null
  servedProvider: string | null
}

export const FALLBACK_PROMPT = 'Describe this screen area and point out anything important.'

export function initialChatState(): ChatState {
  return {
    phase: 'ready',
    messages: [],
    attachment: null,
    draft: '',
    activeRequestId: null,
    privacyPending: null,
    captureError: null,
    servedModel: null,
    servedProvider: null
  }
}

export type ChatAction =
  | { type: 'draft'; text: string }
  | { type: 'selection-started' }
  | { type: 'selection-failed'; message: string }
  | { type: 'selection-cancelled' }
  | { type: 'selection-captured'; attachment: Attachment }
  /** A pasted or dropped image became the attachment (same semantics as a crop). */
  | { type: 'attachment-added'; attachment: Attachment }
  /** The user baked redactions into the attachment; the original is discarded. */
  | { type: 'attachment-redacted'; attachment: Attachment }
  | { type: 'attachment-removed' }
  | { type: 'privacy-notice-dismissed' }
  | { type: 'send-started'; requestId: string; text: string; attachment: Attachment | null }
  | { type: 'chat-delta'; requestId: string; text: string }
  | { type: 'chat-complete'; requestId: string; text: string; servedModel?: string; servedProvider?: string }
  | { type: 'chat-error'; requestId: string; error: ChatErrorMessage }
  | { type: 'retry'; errorMessageId: string }
  | { type: 'clear-session' }

function phaseAfterCompletion(state: ChatState): ChatPhase {
  return state.attachment ? 'image-attached' : 'ready'
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'draft':
      return { ...state, draft: action.text }

    case 'selection-started':
      // Never clobber the phase while a request is in flight; the UI also
      // disables the capture controls, this is the safety net.
      if (state.activeRequestId !== null) return state
      return { ...state, phase: 'selecting', captureError: null }

    case 'selection-failed':
      return { ...state, phase: phaseAfterCompletion(state), captureError: action.message }

    case 'selection-cancelled':
      return { ...state, phase: phaseAfterCompletion(state) }

    case 'selection-captured':
    case 'attachment-added':
    case 'attachment-redacted':
      // Replacing the attachment mid-request would desync the chat context.
      if (state.activeRequestId !== null) return state
      return {
        ...state,
        attachment: action.attachment,
        phase: 'image-attached',
        captureError: null,
        privacyPending: null
      }

    case 'attachment-removed':
      if (state.phase === 'sending' || state.phase === 'streaming') return state
      return {
        ...state,
        attachment: null,
        phase: state.messages.length > 0 ? 'complete' : 'ready',
        privacyPending: null
      }

    case 'privacy-notice-dismissed':
      return { ...state, privacyPending: null }

    case 'send-started': {
      const now = Date.now()
      const userMessage: UIMessage = {
        id: `user-${action.requestId}`,
        role: 'user',
        kind: action.attachment ? 'image' : 'text',
        content: action.text,
        attachment: action.attachment
          ? { width: action.attachment.width, height: action.attachment.height, dataUrl: action.attachment.dataUrl }
          : undefined,
        timestamp: now
      }
      const assistantMessage: UIMessage = {
        id: action.requestId,
        role: 'assistant',
        kind: 'text',
        content: '',
        pending: true,
        timestamp: now
      }
      return {
        ...state,
        phase: 'sending',
        messages: [...state.messages, userMessage, assistantMessage],
        draft: '',
        // The image travels WITH the message now; clear the pending strip.
        // (Retry reads the attachment from the message, not from here.)
        attachment: null,
        activeRequestId: action.requestId,
        privacyPending: null
      }
    }

    case 'chat-delta': {
      if (action.requestId !== state.activeRequestId) return state // late/superseded chunk
      let updated = false
      const messages = state.messages.map((m) => {
        if (m.id !== action.requestId || m.role !== 'assistant') return m
        updated = true
        return { ...m, content: m.content + action.text, pending: true }
      })
      if (!updated) return state
      return { ...state, messages, phase: 'streaming' }
    }

    case 'chat-complete': {
      if (action.requestId !== state.activeRequestId) return state
      const messages = state.messages.map((m) =>
        m.id === action.requestId && m.role === 'assistant'
          ? { ...m, content: action.text, pending: false }
          : m
      )
      return {
        ...state,
        messages,
        phase: phaseAfterCompletion(state),
        activeRequestId: null,
        servedModel: action.servedModel ?? null,
        servedProvider: action.servedProvider ?? null
      }
    }

    case 'chat-error': {
      if (action.requestId !== state.activeRequestId) return state
      const cancelled = action.error.code === 'cancelled'
      const messages = state.messages.map((m) => {
        if (m.id !== action.requestId || m.role !== 'assistant') return m
        if (cancelled) {
          return { ...m, kind: 'cancelled' as const, content: 'Request cancelled.', pending: false }
        }
        return { ...m, kind: 'error' as const, error: action.error, pending: false }
      })
      return {
        ...state,
        messages,
        phase: cancelled ? phaseAfterCompletion(state) : 'error',
        activeRequestId: null
      }
    }

    case 'retry': {
      // Retry targets a SPECIFIC failed/cancelled marker (each error bubble
      // has its own Try again). Trim the transcript at that marker; the
      // caller then re-sends the user turn that immediately precedes it.
      // Guarded against in-flight requests: rewinding while a response is
      // streaming would orphan it and desync state from the main process.
      if (state.activeRequestId !== null) return state
      const idx = state.messages.findIndex(
        (m) =>
          m.id === action.errorMessageId &&
          m.role === 'assistant' &&
          (m.kind === 'error' || m.kind === 'cancelled')
      )
      if (idx === -1) return state
      const before = state.messages.slice(0, idx)
      const hasUser = before.some((m) => m.role === 'user')
      if (!hasUser) return state
      return {
        ...state,
        messages: before,
        phase: phaseAfterCompletion(state),
        activeRequestId: null
      }
    }

    case 'clear-session':
      return {
        phase: 'ready',
        messages: [],
        attachment: null,
        draft: '',
        activeRequestId: null,
        privacyPending: null,
        captureError: null,
        servedModel: null,
        servedProvider: null
      }

    default:
      return state
  }
}

/** True while a network request is pending — blocks duplicate sends. */
export function isBusy(phase: ChatPhase): boolean {
  return phase === 'sending' || phase === 'streaming'
}

/** True when a request id is active, regardless of phase drift. */
export function isRequestActive(state: ChatState): boolean {
  return state.activeRequestId !== null
}

/** Resolves the effective prompt for a send (spec fallback for empty text). */
export function effectivePrompt(state: ChatState): string | null {
  const text = state.draft.trim()
  if (text.length > 0) return text
  if (state.attachment) return FALLBACK_PROMPT
  return null
}

export function canSend(state: ChatState): boolean {
  if (isBusy(state.phase) || isRequestActive(state) || state.phase === 'selecting') return false
  return effectivePrompt(state) !== null
}

/** Derives the minimal history context for the next request. */
export function historyForContext(messages: UIMessage[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages
    .filter((m) => !m.pending && m.kind !== 'error' && m.kind !== 'cancelled')
    .map((m) => ({
      role: m.role,
      content: m.content
    }))
}

const CRISIS_PATTERN =
  /\b(kill (?:myself|me)|suicid\w*|self[- ]?harm\w*|end (?:my|it) (?:life|all)|hurt(?:ing)? myself|want to die|don'?t want to (?:live|be here)|no reason to live)\b/i

/**
 * True when the composer draft mentions a crisis, so the UI can surface
 * crisis resources before the question is even sent. Local-only check.
 */
export function isCrisisDraft(text: string): boolean {
  return CRISIS_PATTERN.test(text)
}
