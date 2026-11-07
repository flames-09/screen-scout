import { describe, expect, it } from 'vitest'
import { SseParser } from '../src/main/ai/stream-parser'

function sse(lines: string[]): string {
  return lines.map((l) => `data: ${l}`).join('\n\n') + '\n\n'
}

describe('SseParser', () => {
  it('parses a single complete event', () => {
    const p = new SseParser()
    const events = p.feed(sse(['{"choices":[{"delta":{"content":"Hi"}}]}']))
    expect(events).toHaveLength(1)
    expect(SseParser.deltaText(events[0])).toBe('Hi')
  })

  it('reassembles JSON split across chunk boundaries', () => {
    const p = new SseParser()
    const full = sse(['{"choices":[{"delta":{"content":"Hello"}}]}'])
    const mid = Math.floor(full.length / 2)
    expect(p.feed(full.slice(0, mid))).toEqual([])
    const events = p.feed(full.slice(mid))
    expect(events).toHaveLength(1)
    expect(SseParser.deltaText(events[0])).toBe('Hello')
  })

  it('handles multiple events in one chunk and the [DONE] terminator', () => {
    const p = new SseParser()
    const chunk = sse(['{"delta":1}', '{"delta":2}', '[DONE]']) + sse(['{"delta":3}'])
    const events = p.feed(chunk)
    expect(events).toHaveLength(2)
    expect(p.isDone()).toBe(true)
    // After DONE, further data is ignored.
    expect(p.feed(sse(['{"delta":4}']))).toEqual([])
  })

  it('ignores malformed events and empty data lines', () => {
    const p = new SseParser()
    const events = p.feed('data: not-json\n\ndata: \n\ndata: {"choices":[]}\n\n')
    expect(events).toHaveLength(1)
  })

  it('supports CRLF line endings', () => {
    const p = new SseParser()
    const events = p.feed('data: {"a":1}\r\n\r\ndata: [DONE]\r\n\r\n')
    expect(events).toHaveLength(1)
    expect(p.isDone()).toBe(true)
  })

  it('extracts delta text only from well-formed payloads', () => {
    expect(SseParser.deltaText(null)).toBe('')
    expect(SseParser.deltaText({})).toBe('')
    expect(SseParser.deltaText({ choices: [] })).toBe('')
    expect(SseParser.deltaText({ choices: [{ delta: { content: 'x' } }] })).toBe('x')
    expect(SseParser.deltaText({ choices: [{ delta: {} }] })).toBe('')
  })
})
