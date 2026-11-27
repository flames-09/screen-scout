import { describe, expect, it } from 'vitest'
import { ZOOM_MAX, ZOOM_MIN, nextZoomFor } from '../src/main/zoom-keys'

describe('nextZoomFor', () => {
  it('zooms in on Ctrl+=, Ctrl+Plus, and numpad Add in 5% steps', () => {
    expect(nextZoomFor(1, '=', true, false)).toBe(1.05)
    expect(nextZoomFor(1, '+', true, false)).toBe(1.05)
    expect(nextZoomFor(1, 'Add', true, false)).toBe(1.05)
    // Cmd on mac behaves the same.
    expect(nextZoomFor(1, '=', false, true)).toBe(1.05)
  })

  it('zooms out on Ctrl+- and numpad Subtract', () => {
    expect(nextZoomFor(1, '-', true, false)).toBe(0.95)
    expect(nextZoomFor(1, 'Subtract', true, false)).toBe(0.95)
  })

  it('resets to 100% on Ctrl+0', () => {
    expect(nextZoomFor(1.3, '0', true, false)).toBe(1)
    expect(nextZoomFor(0.8, '0', false, true)).toBe(1)
  })

  it('is exact across repeated presses (no float drift)', () => {
    let zoom = 1
    for (let i = 0; i < 8; i++) zoom = nextZoomFor(zoom, '=', true, false) as number
    expect(zoom).toBe(1.4)
    for (let i = 0; i < 16; i++) zoom = nextZoomFor(zoom, '-', true, false) as number
    expect(zoom).toBe(ZOOM_MIN)
  })

  it('clamps to the Settings slider range (70–160%)', () => {
    expect(nextZoomFor(ZOOM_MAX, '=', true, false)).toBe(ZOOM_MAX)
    expect(nextZoomFor(ZOOM_MIN, '-', true, false)).toBe(ZOOM_MIN)
  })

  it('ignores non-zoom keys, plain keys, and non-modifier presses', () => {
    expect(nextZoomFor(1, 'a', true, false)).toBeNull()
    expect(nextZoomFor(1, '=', false, false)).toBeNull()
    expect(nextZoomFor(1, '-', false, false)).toBeNull()
  })

  it('treats fractional stored zooms sanely', () => {
    // A legacy value like 1.13 still snaps onto the 5% grid on the next press.
    expect(nextZoomFor(1.13, '=', true, false)).toBe(1.2)
    expect(nextZoomFor(1.13, '-', true, false)).toBe(1.1)
  })
})
