import { describe, expect, it } from 'vitest'
import {
  clampRectToDisplay,
  dipRectToImagePixels,
  findDisplayForRect,
  isValidSelection,
  MIN_SELECTION_DIP,
  normalizeRect
} from '../src/main/capture/geometry'
import type { DisplayInfo } from '@shared/types'

const primary: DisplayInfo = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  scaleFactor: 1
}

// A 150%-scaled secondary monitor left of the primary (negative origin).
const secondaryHiDpi: DisplayInfo = {
  id: 2,
  bounds: { x: -1706, y: 200, width: 1706, height: 960 },
  scaleFactor: 1.5
}

describe('normalizeRect', () => {
  it('converts a north-east drag into a positive rect', () => {
    expect(normalizeRect({ x: 100, y: 100, width: -60, height: -40 })).toEqual({
      x: 40,
      y: 60,
      width: 60,
      height: 40
    })
  })
})

describe('isValidSelection', () => {
  it('rejects accidental clicks but accepts small deliberate selections', () => {
    expect(isValidSelection({ x: 0, y: 0, width: 3, height: 3 })).toBe(false)
    expect(isValidSelection({ x: 0, y: 0, width: MIN_SELECTION_DIP, height: MIN_SELECTION_DIP })).toBe(true)
  })
})

describe('clampRectToDisplay', () => {
  it('clamps overhang on all sides', () => {
    const clamped = clampRectToDisplay({ x: -50, y: -20, width: 2000, height: 1100 }, primary)
    expect(clamped).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
  })
})

describe('dipRectToImagePixels', () => {
  it('maps 1:1 on a scale-1 display when the capture matches physical size', () => {
    const px = dipRectToImagePixels({ x: 100, y: 200, width: 300, height: 140 }, primary, { width: 1920, height: 1080 })
    expect(px).toEqual({ x: 100, y: 200, width: 300, height: 140 })
  })

  it('handles negative virtual-screen origins', () => {
    const px = dipRectToImagePixels({ x: -1706, y: 200, width: 100, height: 50 }, secondaryHiDpi, {
      width: 2559,
      height: 1440
    })
    expect(px).toEqual({ x: 0, y: 0, width: 150, height: 75 })
  })

  it('stays correct when the returned thumbnail is smaller than physical (DPI-normalized)', () => {
    // 150% display, physical 2559x1440, but the OS returned a 1920x1080-fitting thumbnail.
    const px = dipRectToImagePixels({ x: -1606, y: 300, width: 200, height: 100 }, secondaryHiDpi, {
      width: 1920,
      height: 1080
    })
    const fx = 100 / 1706
    const fy = 100 / 960
    const fw = 200 / 1706
    const fh = 100 / 960
    expect(px.x).toBe(Math.round(fx * 1920))
    expect(px.y).toBe(Math.round(fy * 1080))
    expect(px.width).toBe(Math.round(fw * 1920))
    expect(px.height).toBe(Math.round(fh * 1080))
  })

  it('never produces a zero-size crop after rounding', () => {
    const px = dipRectToImagePixels({ x: 0, y: 0, width: 0.4, height: 0.4 }, primary, { width: 1920, height: 1080 })
    expect(px.width).toBeGreaterThanOrEqual(1)
    expect(px.height).toBeGreaterThanOrEqual(1)
  })
})

describe('findDisplayForRect', () => {
  it('selects the display containing the rect center', () => {
    expect(findDisplayForRect([primary, secondaryHiDpi], { x: 500, y: 300, width: 100, height: 100 })).toBe(primary)
    expect(findDisplayForRect([primary, secondaryHiDpi], { x: -1500, y: 400, width: 100, height: 100 })).toBe(
      secondaryHiDpi
    )
    expect(findDisplayForRect([primary], { x: 5000, y: 300, width: 10, height: 10 })).toBeNull()
  })
})
