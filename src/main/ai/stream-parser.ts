/**
 * Incremental Server-Sent Events parser for the NVIDIA NIM chat-completions
 * stream (OpenAI-compatible: `data: {...}` lines, terminated by `data: [DONE]`).
 *
 * Pure and dependency-free so it can be unit-tested exhaustively, including
 * chunk boundaries that split a JSON payload across two network packets.
 */
export class SseParser {
  private buffer = ''
  private done = false

  /**
   * Feeds a raw text chunk; returns complete JSON payloads parsed from
   * finished `data:` events. The terminal `[DONE]` event sets `isDone()`.
   */
  feed(chunk: string): unknown[] {
    if (this.done) return []
    this.buffer += chunk
    const events: unknown[] = []
    let idx: number
    // Events are separated by a blank line; be tolerant of \r\n.
    while ((idx = this.findEventEnd()) !== -1) {
      const rawEvent = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + this.separatorLengthAt(idx))
      const lines = rawEvent.split(/\r?\n/)
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '') continue
        if (data === '[DONE]') {
          this.done = true
          return events
        }
        try {
          events.push(JSON.parse(data))
        } catch {
          // A malformed event (e.g. keep-alive noise) must not kill the stream.
        }
      }
    }
    return events
  }

  /** Returns the extracted delta text of a chat completion chunk, or ''. */
  static deltaText(payload: unknown): string {
    if (typeof payload !== 'object' || payload === null) return ''
    const choices = (payload as { choices?: unknown[] }).choices
    if (!Array.isArray(choices) || choices.length === 0) return ''
    const delta = (choices[0] as { delta?: { content?: unknown } }).delta
    const content = typeof delta?.content === 'string' ? delta.content : ''
    return content
  }

  isDone(): boolean {
    return this.done
  }

  private findEventEnd(): number {
    const lf = this.buffer.indexOf('\n\n')
    const crlf = this.buffer.indexOf('\r\n\r\n')
    if (lf === -1 && crlf === -1) return -1
    if (lf === -1 || (crlf !== -1 && crlf < lf)) return crlf
    // A \n\n may be the tail of a \r\n\r\n; prefer the earliest real boundary.
    return lf
  }

  private separatorLengthAt(idx: number): number {
    return this.buffer.startsWith('\r\n\r\n', idx) ? 4 : 2
  }
}
