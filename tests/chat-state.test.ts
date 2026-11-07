import { describe, expect, it } from 'vitest'
import {
  canSend,
  chatReducer,
  effectivePrompt,
  historyForContext,
  initialChatState,
  isBusy,
  FALLBACK_PROMPT
} from '../src/renderer/assistant/chat-state'
import type { ChatErrorMessage, UIMessage } from '@shared/types'

const attach = {
  dataUrl: 'data:image/png;base64,AAA',
  width: 400,
  height: 300,
  bytes: 50000,
  mime: 'image/png'
}

function withMessages(messages: UIMessage[]): { messages: UIMessage[] } {
  return { messages }
}

describe('chatReducer — selection flow', () => {
  it('moves ready → selecting → image-attached and back on cancel', () => {
    let s = chatReducer(initialChatState(), { type: 'selection-started' })
    expect(s.phase).toBe('selecting')
    s = chatReducer(s, { type: 'selection-cancelled' })
    expect(s.phase).toBe('ready')
    s = chatReducer(s, { type: 'selection-captured', attachment: attach })
    expect(s.phase).toBe('image-attached')
    expect(s.attachment?.dataUrl).toBe(attach.dataUrl)
  })

  it('records capture failures without clearing existing context', () => {
    let s = chatReducer(initialChatState(), { type: 'selection-captured', attachment: attach })
    s = chatReducer(s, { type: 'selection-started' })
    s = chatReducer(s, { type: 'selection-failed', message: 'nope' })
    expect(s.captureError).toBe('nope')
    // A second attempt clears the error.
    s = chatReducer(s, { type: 'selection-started' })
    expect(s.captureError).toBeNull()
  })

  it('send consumes the attachment; remove stays safe mid-request', () => {
    let s = chatReducer(initialChatState(), { type: 'selection-captured', attachment: attach })
    s = chatReducer(s, {
      type: 'send-started',
      requestId: 'r1',
      text: 'hi',
      attachment: attach
    })
    expect(s.attachment).toBeNull() // consumed — the image travels with the message
    s = chatReducer(s, { type: 'attachment-removed' }) // harmless no-op while sending
    expect(s.attachment).toBeNull()
    s = chatReducer(s, { type: 'chat-complete', requestId: 'r1', text: 'answer' })
    expect(s.phase).toBe('ready') // attachment was consumed by the send
    expect(s.messages[0].attachment?.dataUrl).toBe(attach.dataUrl) // message keeps its image
  })
})

describe('chatReducer — send/stream/complete', () => {
  it('creates the user + pending assistant pair and streams into it', () => {
    let s = chatReducer(initialChatState(), { type: 'selection-captured', attachment: attach })
    s = chatReducer(s, { type: 'send-started', requestId: 'r1', text: 'What is this?', attachment: attach })
    expect(s.phase).toBe('sending')
    expect(isBusy(s.phase)).toBe(true)
    expect(canSend(s)).toBe(false) // duplicate send impossible
    expect(s.messages).toHaveLength(2)
    expect(s.messages[0].kind).toBe('image')
    expect(s.messages[0].attachment?.dataUrl).toBe(attach.dataUrl)
    expect(s.messages[1].pending).toBe(true)

    s = chatReducer(s, { type: 'chat-delta', requestId: 'r1', text: 'It shows' })
    expect(s.phase).toBe('streaming')
    s = chatReducer(s, { type: 'chat-delta', requestId: 'r1', text: ' a graph.' })
    expect(s.messages[1].content).toBe('It shows a graph.')
    expect(s.messages[1].pending).toBe(true)

    s = chatReducer(s, { type: 'chat-complete', requestId: 'r1', text: 'It shows a graph.' })
    expect(s.phase).toBe('ready') // attachment was consumed by the send
    expect(s.messages[1].pending).toBe(false)
    expect(s.activeRequestId).toBeNull()
    expect(canSend(s)).toBe(false) // composer is empty — nothing to send
    expect(canSend({ ...s, attachment: attach })).toBe(true) // a fresh image enables sending
  })

  it('ignores deltas from a stale request id (late/cancelled chunks)', () => {
    let s = chatReducer(initialChatState(), { type: 'send-started', requestId: 'r1', text: 'q', attachment: null })
    s = chatReducer(s, { type: 'chat-complete', requestId: 'r1', text: 'a1' })
    // A late chunk from the finished request must not append anywhere.
    const before = s.messages.map((m) => ({ ...m }))
    s = chatReducer(s, { type: 'chat-delta', requestId: 'r1', text: 'LATE' })
    expect(s.messages).toEqual(before)
    // A chunk for an entirely different id is ignored too.
    s = chatReducer(s, { type: 'chat-delta', requestId: 'r2', text: 'X' })
    expect(s.messages).toEqual(before)
  })

  it('turns failures into retryable error messages and preserves the prompt', () => {
    const err: ChatErrorMessage = { code: 'network', message: 'offline', retryable: true }
    let s = chatReducer(initialChatState(), { type: 'send-started', requestId: 'r1', text: 'my question', attachment: null })
    s = chatReducer(s, { type: 'chat-error', requestId: 'r1', error: err })
    expect(s.phase).toBe('error')
    expect(s.messages[1].kind).toBe('error')
    expect(s.messages[1].error?.code).toBe('network')
    // The user prompt is still in the transcript.
    expect(s.messages[0].content).toBe('my question')
  })

  it('treats cancellation as a calm state, not an error', () => {
    const cancel: ChatErrorMessage = { code: 'cancelled', message: 'Request cancelled.', retryable: false }
    let s = chatReducer(initialChatState(), { type: 'send-started', requestId: 'r1', text: 'q', attachment: null })
    s = chatReducer(s, { type: 'chat-error', requestId: 'r1', error: cancel })
    expect(s.messages[1].kind).toBe('cancelled')
    expect(s.phase).toBe('ready')
  })

  it('retry strips the failed assistant placeholder, keeping prior turns', () => {
    const err: ChatErrorMessage = { code: 'server', message: 'boom', retryable: true }
    let s = chatReducer(initialChatState(), { type: 'send-started', requestId: 'r1', text: 'q1', attachment: null })
    s = chatReducer(s, { type: 'chat-complete', requestId: 'r1', text: 'a1' })
    s = chatReducer(s, { type: 'send-started', requestId: 'r2', text: 'q2', attachment: null })
    s = chatReducer(s, { type: 'chat-error', requestId: 'r2', error: err })
    expect(s.messages).toHaveLength(4) // u1 a1 u2 err
    s = chatReducer(s, { type: 'retry', errorMessageId: 'r2' })
    expect(s.messages.map((m) => m.content)).toEqual(['q1', 'a1', 'q2'])
    expect(s.activeRequestId).toBeNull()
  })

  it('retry removes only the targeted failed turn, never earlier resolved turns', () => {
    const err: ChatErrorMessage = { code: 'rate-limit', message: 'slow down', retryable: false }
    // q1 fails and the user does NOT retry — they send a fresh prompt that
    // succeeds — then q3 fails. Both error markers now coexist:
    //   [u1, err1, u2, a2, u3, err3]
    let s = chatReducer(initialChatState(), { type: 'send-started', requestId: 'r1', text: 'q1', attachment: null })
    s = chatReducer(s, { type: 'chat-error', requestId: 'r1', error: err }) // err1 stays in transcript
    s = chatReducer(s, { type: 'send-started', requestId: 'r2', text: 'q2', attachment: null })
    s = chatReducer(s, { type: 'chat-complete', requestId: 'r2', text: 'a2' })
    s = chatReducer(s, { type: 'send-started', requestId: 'r3', text: 'q3', attachment: null })
    s = chatReducer(s, { type: 'chat-error', requestId: 'r3', error: err })
    expect(s.messages.map((m) => m.kind)).toEqual(['text', 'error', 'text', 'text', 'text', 'error'])
    // Retrying the LAST failure (its own Try again button) must trim only
    // err3 — the earlier err1 and the resolved q2/a2 turn must survive.
    // (A naive trim-at-first-marker implementation would truncate to [u1].)
    s = chatReducer(s, { type: 'retry', errorMessageId: 'r3' })
    expect(s.messages.map((m) => m.content)).toEqual(['q1', '', 'q2', 'a2', 'q3'])
    expect(s.messages.filter((m) => m.kind === 'error').map((m) => m.id)).toEqual(['r1'])
  })

  it('retrying an OLDER error targets that exact turn, not the newest one', () => {
    const err: ChatErrorMessage = { code: 'network', message: 'offline', retryable: true }
    let s = chatReducer(initialChatState(), { type: 'send-started', requestId: 'r1', text: 'q1', attachment: null })
    s = chatReducer(s, { type: 'chat-error', requestId: 'r1', error: err }) // [u1, err1]
    s = chatReducer(s, { type: 'send-started', requestId: 'r2', text: 'q2', attachment: null })
    s = chatReducer(s, { type: 'chat-complete', requestId: 'r2', text: 'a2' }) // [u1, err1, u2, a2]
    // Retrying err1 now must drop only from err1 onward, keeping nothing
    // after it, so the caller can re-send q1 with an empty history.
    s = chatReducer(s, { type: 'retry', errorMessageId: 'r1' })
    expect(s.messages.map((m) => m.content)).toEqual(['q1'])
    expect(s.phase).toBe('ready')
  })

  it('retry ignores unknown message ids', () => {
    let s = chatReducer(initialChatState(), { type: 'send-started', requestId: 'r1', text: 'q1', attachment: null })
    const before = [...s.messages]
    s = chatReducer(s, { type: 'retry', errorMessageId: 'nonexistent' })
    expect(s.messages).toEqual(before)
  })

  it('send-started consumes the pending attachment (it travels with the message)', () => {
    let s = initialChatState()
    s = chatReducer(s, {
      type: 'selection-captured',
      attachment: { width: 640, height: 400, dataUrl: 'data:image/png;base64,AA', bytes: 10, mime: 'image/png' }
    })
    expect(s.attachment).not.toBeNull()
    s = chatReducer(s, { type: 'send-started', requestId: 'r1', text: 'q', attachment: s.attachment })
    expect(s.attachment).toBeNull()
    const userMsg = s.messages[0]
    expect(userMsg.role).toBe('user')
    expect(userMsg.attachment?.dataUrl).toBe('data:image/png;base64,AA')
    // Subsequent sends must NOT re-attach the consumed image.
    s = chatReducer(s, { type: 'chat-complete', requestId: 'r1', text: 'a' })
    s = chatReducer(s, { type: 'send-started', requestId: 'r2', text: 'q2', attachment: null })
    expect(s.messages[2].attachment).toBeUndefined()
  })

  it('retry is ignored while a request is in flight (no mid-stream rewind)', () => {
    let s = chatReducer(initialChatState(), { type: 'send-started', requestId: 'r1', text: 'q1', attachment: null })
    s = chatReducer(s, { type: 'chat-error', requestId: 'r1', error: { code: 'network', message: 'x', retryable: true } })
    s = chatReducer(s, { type: 'send-started', requestId: 'r2', text: 'q2', attachment: null })
    s = chatReducer(s, { type: 'chat-delta', requestId: 'r2', text: 'streaming…' })
    expect(s.activeRequestId).toBe('r2')
    const before = [...s.messages]
    // Trying again on the OLD error while r2 streams must be a no-op.
    s = chatReducer(s, { type: 'retry', errorMessageId: 'r1' })
    expect(s.messages).toEqual(before)
    expect(s.activeRequestId).toBe('r2')
    // The stream keeps flowing into the still-active request.
    s = chatReducer(s, { type: 'chat-delta', requestId: 'r2', text: ' more' })
    expect(s.messages[3].content).toBe('streaming… more')
  })

  it('ignores selection actions while a request is in flight (state safety net)', () => {
    let s = chatReducer(initialChatState(), { type: 'selection-captured', attachment: attach })
    s = chatReducer(s, { type: 'send-started', requestId: 'r1', text: 'q', attachment: attach })
    const before = { ...s }
    s = chatReducer(s, { type: 'selection-started' }) // ignored
    expect(s).toEqual(before)
    s = chatReducer(s, { type: 'selection-captured', attachment: { ...attach, dataUrl: 'other' } }) // ignored
    expect(s).toEqual(before)
    // canSend must remain false while the request id is active, even though
    // the phase would otherwise allow it.
    expect(canSend(s)).toBe(false)
  })

  it('clear-session wipes messages, the attachment, and the draft', () => {
    let s = chatReducer(initialChatState(), { type: 'selection-captured', attachment: attach })
    s = chatReducer(s, { type: 'draft', text: 'typing something' })
    s = chatReducer(s, { type: 'send-started', requestId: 'r1', text: 'q', attachment: attach })
    s = chatReducer(s, { type: 'chat-complete', requestId: 'r1', text: 'a' })
    s = chatReducer(s, { type: 'clear-session' })
    expect(s.messages).toEqual([])
    expect(s.attachment).toBeNull()
    expect(s.draft).toBe('')
    expect(s.phase).toBe('ready')
  })
})

describe('prompt resolution', () => {
  it('uses the spec fallback when sending a capture with an empty prompt', () => {
    let s = initialChatState()
    expect(effectivePrompt(s)).toBeNull() // nothing to send
    s = chatReducer(s, { type: 'selection-captured', attachment: attach })
    expect(effectivePrompt(s)).toBe(FALLBACK_PROMPT)
    expect(FALLBACK_PROMPT).toBe('Describe this screen area and point out anything important.')
    s = chatReducer(s, { type: 'draft', text: '  actual question  ' })
    expect(effectivePrompt(s)).toBe('actual question')
  })

  it('canSend is false while busy or selecting, true when there is content', () => {
    let s = initialChatState()
    expect(canSend(s)).toBe(false)
    s = chatReducer(s, { type: 'draft', text: 'hello' })
    expect(canSend(s)).toBe(true)
    s = chatReducer(s, { type: 'send-started', requestId: 'r1', text: 'hello', attachment: null })
    expect(canSend(s)).toBe(false)
  })
})

describe('historyForContext', () => {
  it('excludes pending, error, and cancelled turns', () => {
    const messages: UIMessage[] = [
      { id: 'u1', role: 'user', kind: 'text', content: 'q1', timestamp: 0 },
      { id: 'a1', role: 'assistant', kind: 'text', content: 'a1', timestamp: 0 },
      { id: 'a2', role: 'assistant', kind: 'error', content: '', error: { code: 'network', message: 'x', retryable: false }, timestamp: 0 },
      { id: 'a3', role: 'assistant', kind: 'cancelled', content: 'Request cancelled.', timestamp: 0 },
      { id: 'a4', role: 'assistant', kind: 'text', content: 'pending', pending: true, timestamp: 0 }
    ]
    const history = historyForContext(messages)
    expect(history).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' }
    ])
  })

  it('keeps the user text (not base64) in context', () => {
    const messages: UIMessage[] = [
      { id: 'u1', role: 'user', kind: 'image', content: 'q', attachment: { width: 1, height: 1, dataUrl: 'data:image/png;base64,BIG' }, timestamp: 0 }
    ]
    expect(JSON.stringify(historyForContext(messages))).not.toContain('base64')
  })

  it('round-trips through withMessages helper trivially', () => {
    const messages: UIMessage[] = [
      { id: 'u1', role: 'user', kind: 'text', content: 'q', timestamp: 0 }
    ]
    expect(withMessages(messages).messages).toHaveLength(1)
  })
})

describe('chatReducer — pasted / dropped / redacted attachments', () => {
  it('attachment-added lands the image like a captured crop', () => {
    let s = chatReducer(initialChatState(), { type: 'attachment-added', attachment: attach })
    expect(s.phase).toBe('image-attached')
    expect(s.attachment?.dataUrl).toBe(attach.dataUrl)
    expect(s.captureError).toBeNull()
  })

  it('attachment-redacted replaces the image in place', () => {
    const redacted = { ...attach, dataUrl: 'data:image/png;base64,REDACTED', bytes: 60000 }
    let s = chatReducer(initialChatState(), { type: 'attachment-added', attachment: attach })
    s = chatReducer(s, { type: 'attachment-redacted', attachment: redacted })
    expect(s.attachment?.dataUrl).toBe('data:image/png;base64,REDACTED')
    expect(s.attachment?.bytes).toBe(60000)
    expect(s.phase).toBe('image-attached')
  })

  it('attachment-added is ignored while a request is in flight', () => {
    let s = chatReducer(initialChatState(), { type: 'attachment-added', attachment: attach })
    s = chatReducer(s, { type: 'send-started', requestId: 'r1', text: 'q', attachment: attach })
    expect(s.attachment).toBeNull()
    s = chatReducer(s, { type: 'attachment-added', attachment: { ...attach, dataUrl: 'data:image/png;base64,LATE' } })
    expect(s.attachment).toBeNull()
  })

  it('attachment-redacted is ignored while a request is in flight', () => {
    let s = chatReducer(initialChatState(), { type: 'send-started', requestId: 'r1', text: 'q', attachment: null })
    s = chatReducer(s, { type: 'attachment-redacted', attachment: attach })
    expect(s.attachment).toBeNull()
  })
})

describe('served model tracking', () => {
  it('records what actually served the last answer', () => {
    let state = initialChatState()
    state = chatReducer(state, { type: 'send-started', requestId: 'r1', text: 'q', attachment: null })
    state = chatReducer(state, {
      type: 'chat-complete',
      requestId: 'r1',
      text: 'a',
      servedModel: 'openai/gpt-oss-120b',
      servedProvider: 'groq'
    })
    expect(state.servedModel).toBe('openai/gpt-oss-120b')
    expect(state.servedProvider).toBe('groq')
  })

  it('clears the served label with the session', () => {
    let state = initialChatState()
    state = chatReducer(state, { type: 'send-started', requestId: 'r2', text: 'q', attachment: null })
    state = chatReducer(state, { type: 'chat-complete', requestId: 'r2', text: 'a', servedProvider: 'cf' })
    expect(state.servedModel).toBeNull()
    expect(state.servedProvider).toBe('cf')
    state = chatReducer(state, { type: 'clear-session' })
    expect(state.servedModel).toBeNull()
    expect(state.servedProvider).toBeNull()
  })
})
