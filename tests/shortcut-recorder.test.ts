import { describe, expect, it } from 'vitest'
import { acceleratorFromEvent } from '../src/renderer/settings/shortcut-recorder'

const ev = (key: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}) => ({
  key,
  ctrlKey: mods.ctrl ?? false,
  altKey: mods.alt ?? false,
  shiftKey: mods.shift ?? false,
  metaKey: mods.meta ?? false
})

describe('acceleratorFromEvent', () => {
  it('builds Shift+R (the default) with modifiers in Electron order', () => {
    const r = acceleratorFromEvent(ev('r', { shift: true }))
    expect(r.ok).toBe(true)
    expect(r.accelerator).toBe('Shift+R')
  })

  it('orders multiple modifiers Control → Alt → Shift → Super', () => {
    const r = acceleratorFromEvent(ev('k', { shift: true, ctrl: true, alt: true }))
    expect(r.accelerator).toBe('Control+Alt+Shift+K')
  })

  it('maps named keys and arrow keys', () => {
    expect(acceleratorFromEvent(ev(' ', { ctrl: true })).accelerator).toBe('Control+Space')
    expect(acceleratorFromEvent(ev('ArrowUp', { ctrl: true })).accelerator).toBe('Control+Up')
    expect(acceleratorFromEvent(ev('F5', { alt: true })).accelerator).toBe('Alt+F5')
  })

  it('allows bare function keys without modifiers', () => {
    expect(acceleratorFromEvent(ev('F9')).accelerator).toBe('F9')
  })

  it('rejects bare letters (would hijack typing)', () => {
    const r = acceleratorFromEvent(ev('r'))
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('modifier')
  })

  it('rejects unknown keys politely', () => {
    const r = acceleratorFromEvent(ev('Dead', { shift: true }))
    expect(r.ok).toBe(false)
    expect(r.reason).toBeTruthy()
  })

  it('treats Escape as cancel', () => {
    const r = acceleratorFromEvent(ev('Escape'))
    expect(r.ok).toBe(false)
    expect(r.cancelled).toBe(true)
  })

  it('ignores modifier-only presses', () => {
    for (const mod of ['Shift', 'Control', 'Alt', 'Meta']) {
      const r = acceleratorFromEvent(ev(mod, { shift: true }))
      expect(r.ok).toBe(false)
      expect(r.cancelled).toBeUndefined()
    }
  })
})
