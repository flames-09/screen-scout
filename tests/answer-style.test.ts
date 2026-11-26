import { describe, expect, it } from 'vitest'
import { applyAnswerStyle } from '../src/main/ai/answer-style'
import { DEFAULT_SYSTEM_PROMPT } from '../src/main/ai/nim-client'

describe('applyAnswerStyle', () => {
  it('appends the brief instruction by default and for explicit brief', () => {
    for (const style of [undefined, 'brief'] as const) {
      const out = applyAnswerStyle(DEFAULT_SYSTEM_PROMPT, style)
      expect(out.startsWith(DEFAULT_SYSTEM_PROMPT)).toBe(true)
      expect(out).toContain('be brief')
    }
  })

  it('appends the thorough instruction for detailed', () => {
    const out = applyAnswerStyle(DEFAULT_SYSTEM_PROMPT, 'detailed')
    expect(out.startsWith(DEFAULT_SYSTEM_PROMPT)).toBe(true)
    expect(out).toContain('thorough, well-structured')
    expect(out).not.toContain('be brief')
  })

  it('separates the suffix with a blank line and tolerates an empty base', () => {
    expect(applyAnswerStyle(DEFAULT_SYSTEM_PROMPT, 'brief').indexOf('\n\nAnswer style:')).toBeGreaterThan(0)
    expect(applyAnswerStyle('', 'detailed')).toContain('Answer style:')
  })
})
