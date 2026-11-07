/**
 * SSE translation for the Workers AI fallback.
 *
 * The app speaks the OpenAI chat-completions streaming dialect. Groq already
 * speaks it (pure passthrough), but Workers AI emits `{"response": "..."}`
 * chunks, so the relay rewrites them into OpenAI `choices[].delta.content`
 * events. Keeping the rewrite in one place means the desktop client needs
 * zero knowledge of which provider served a request.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function openAiChunk(content: string, model: string, id: string, created: number): string {
  const payload = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }]
  }
  return `data: ${JSON.stringify(payload)}\n\n`
}

export function openAiDone(): string {
  return 'data: [DONE]\n\n'
}

/** Cleans control tokens some Workers AI models leak into the text. */
export function sanitizeCfText(text: string): string {
  return text.replace(/<\|[^|]{0,24}\|>/g, '')
}

/**
 * Extracts complete SSE data lines from a decoder buffer. Returns the parsed
 * JSON objects plus the unterminated remainder, so chunk boundaries can split
 * a line without corrupting output.
 */
export function drainSseLines(buffer: string): { lines: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n')
  const parts = normalized.split('\n')
  const rest = parts.pop() ?? ''
  const lines = parts.filter((line) => line.trim() !== '')
  return { lines, rest }
}

/** Parses one Workers AI SSE line, returning its text fragment (or ''). */
export function parseWorkersAiLine(line: string): string {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return ''
  const data = trimmed.slice(5).trim()
  if (data === '' || data === '[DONE]') return ''
  try {
    const parsed = JSON.parse(data) as { response?: unknown }
    return typeof parsed.response === 'string' ? sanitizeCfText(parsed.response) : ''
  } catch {
    return ''
  }
}

/**
 * Wraps a Workers AI stream so the desktop client sees OpenAI chunks.
 * A trailing `[DONE]` is always emitted — the app's parser uses it to finish.
 */
export function translateWorkersAiStream(
  source: ReadableStream<Uint8Array>,
  model: string,
  id = `chatcmpl-${Math.random().toString(36).slice(2, 12)}`,
  created = Math.floor(Date.now() / 1000)
): ReadableStream<Uint8Array> {
  let buffer = ''
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true })
        const { lines, rest } = drainSseLines(buffer)
        buffer = rest
        for (const line of lines) {
          const text = parseWorkersAiLine(line)
          if (text) controller.enqueue(encoder.encode(openAiChunk(text, model, id, created)))
        }
      },
      flush(controller) {
        // A final line without a trailing newline.
        const text = parseWorkersAiLine(buffer)
        if (text) controller.enqueue(encoder.encode(openAiChunk(text, model, id, created)))
        controller.enqueue(encoder.encode(openAiDone()))
      }
    })
  )
}
