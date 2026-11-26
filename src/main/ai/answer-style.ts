/**
 * Answer-length preference, applied by appending one instruction line to the
 * default system prompt. Pure and dependency-free so the exact wording is
 * unit-testable, and so the same rule shapes BOTH the hosted relay path and
 * BYOK requests (ChatService builds a single request for either mode).
 */
export type AnswerStyle = 'brief' | 'detailed'

const STYLE_SUFFIX: Record<AnswerStyle, string> = {
  brief:
    'Answer style: be brief — at most 3-4 sentences (or a short bullet list) unless the question genuinely needs more. Lead with the answer and skip background.',
  detailed:
    'Answer style: give a thorough, well-structured answer; use markdown (short sections, bullets, numbered steps) when it helps clarity.'
}

/** Appends the style instruction to a base system prompt (no-op safe on ''). */
export function applyAnswerStyle(base: string, style: AnswerStyle | undefined): string {
  const suffix = STYLE_SUFFIX[style === 'detailed' ? 'detailed' : 'brief']
  const trimmed = base.trimEnd()
  return trimmed ? `${trimmed}\n\n${suffix}` : suffix
}
