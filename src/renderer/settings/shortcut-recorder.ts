/**
 * Converts a browser KeyboardEvent into an Electron accelerator string
 * (e.g. "Shift+R", "Control+Alt+P"). Pure, unit-testable.
 */

export interface AcceleratorResult {
  ok: boolean
  accelerator?: string
  reason?: string
  cancelled?: boolean
}

const MODIFIER_ORDER = ['Control', 'Alt', 'Shift', 'Super'] as const

const KEY_ALIASES: Record<string, string> = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Esc',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Insert: 'Insert',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown'
}

export function acceleratorFromEvent(e: { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): AcceleratorResult {
  const raw = e.key
  if (raw === 'Escape') {
    return { ok: false, reason: 'Cancelled.', cancelled: true }
  }
  if (raw === 'Shift' || raw === 'Control' || raw === 'Alt' || raw === 'Meta') {
    return { ok: false, reason: 'Keep holding modifiers, then press a key.' }
  }

  let base: string | null = null
  if (raw.length === 1 && raw !== ' ') {
    base = raw.toUpperCase() // letters & digits
  } else if (/^F\d{1,2}$/.test(raw)) {
    base = raw
  } else if (KEY_ALIASES[raw]) {
    base = KEY_ALIASES[raw]
  }
  if (!base) {
    return { ok: false, reason: `The "${raw}" key can't be used in a shortcut. Try a letter, digit, or F-key.` }
  }

  const parts: string[] = []
  if (e.ctrlKey) parts.push('Control')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Super')

  // Require a modifier (or an F-key) — a bare letter would hijack typing.
  if (parts.length === 0 && !/^F\d+$/.test(base)) {
    return { ok: false, reason: 'Add a modifier such as Shift, Ctrl, or Alt.' }
  }

  const ordered = MODIFIER_ORDER.filter((m) => parts.includes(m))
  const accelerator = [...ordered, base].join('+')
  return { ok: true, accelerator }
}
