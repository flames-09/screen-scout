import { describe, expect, it } from 'vitest'
import { backdropCropRect } from '../src/main/backdrop-geometry'

const display = { x: 0, y: 0, width: 2560, height: 1440 }
const image = { width: 2560, height: 1440 }

describe('backdropCropRect', () => {
  it('maps a fully-on-screen window 1:1 when the image is at display resolution', () => {
    const r = backdropCropRect({ x: 100, y: 80, width: 440, height: 560 }, display, image)
    expect(r).toEqual({ x: 100, y: 80, width: 440, height: 560 })
  })

  it('derives the scale from the image size (150% DPI capture)', () => {
    const r = backdropCropRect({ x: 100, y: 80, width: 440, height: 560 }, display, {
      width: 3840,
      height: 2160
    })
    expect(r).toEqual({ x: 150, y: 120, width: 660, height: 840 })
  })

  it('supports downscaled captures (half-resolution thumbnail)', () => {
    const r = backdropCropRect({ x: 100, y: 80, width: 440, height: 560 }, display, {
      width: 1280,
      height: 720
    })
    expect(r).toEqual({ x: 50, y: 40, width: 220, height: 280 })
  })

  it('offsets by the display origin (multi-monitor, display left of origin)', () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1080 }
    const r = backdropCropRect({ x: -1500, y: 200, width: 440, height: 560 }, left, {
      width: 1920,
      height: 1080
    })
    expect(r.x).toBe(420)
    expect(r.y).toBe(200)
  })

  it('clamps windows that extend past the right/bottom edge', () => {
    const r = backdropCropRect(
      { x: display.width - 200, y: display.height - 100, width: 440, height: 560 },
      display,
      image
    )
    expect(r.x).toBe(display.width - 200)
    expect(r.y).toBe(display.height - 100)
    expect(r.width).toBe(200)
    expect(r.height).toBe(100)
  })

  it('clamps negative origins (window dragged off the left/top) to the image', () => {
    const r = backdropCropRect({ x: -300, y: -100, width: 440, height: 560 }, display, image)
    expect(r.x).toBe(0)
    expect(r.y).toBe(0)
    expect(r.width).toBe(140) // 440 - 300
    expect(r.height).toBe(460) // 560 - 100
  })

  it('never returns a zero-sized rect (fully off-screen degenerate case)', () => {
    const r = backdropCropRect({ x: display.width + 50, y: 0, width: 440, height: 560 }, display, image)
    expect(r.width).toBeGreaterThanOrEqual(1)
    expect(r.height).toBeGreaterThanOrEqual(1)
  })
})
