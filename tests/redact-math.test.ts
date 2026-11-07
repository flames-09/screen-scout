import { describe, expect, it } from 'vitest'
import {
  averageColor,
  boxFromDrag,
  chooseExportFormat,
  isMeaningfulBox,
  MIN_REDACT_BOX_PX,
  mosaicBlockSize
} from '../src/renderer/components/redact-math'
import { isAttachableImageMime } from '../src/shared/image-policy'

describe('redact box geometry', () => {
  const image = { width: 400, height: 300 }
  // The <img> is displayed at half scale: client px → 2 image px.
  const origin = { x: 10, y: 20 }
  const scale = 2

  it('maps a drag into image pixels through the display scale', () => {
    const box = boxFromDrag({ x: 30, y: 40 }, { x: 70, y: 100 }, origin, scale, image)
    // scale 2 = image px per client px: (30-10)*2=40 … (70-10)*2=120
    expect(box).toEqual({ x: 40, y: 40, w: 80, h: 120 })
  })

  it('normalizes backwards drags into a positive box', () => {
    const box = boxFromDrag({ x: 70, y: 100 }, { x: 30, y: 40 }, origin, scale, image)
    expect(box.w).toBeGreaterThan(0)
    expect(box.h).toBeGreaterThan(0)
    expect(box.x).toBe(40)
    expect(box.y).toBe(40)
  })

  it('clamps drags that start or end outside the image', () => {
    const box = boxFromDrag({ x: 0, y: 0 }, { x: 2000, y: 2000 }, origin, scale, image)
    expect(box.x).toBe(0)
    expect(box.y).toBe(0)
    expect(box.x + box.w).toBeLessThanOrEqual(image.width)
    expect(box.y + box.h).toBeLessThanOrEqual(image.height)
  })

  it('rounds to whole image pixels', () => {
    const box = boxFromDrag({ x: 11, y: 21 }, { x: 53, y: 63 }, origin, scale, image)
    expect(Number.isInteger(box.x)).toBe(true)
    expect(Number.isInteger(box.w)).toBe(true)
  })

  it('treats tiny drags as stray clicks', () => {
    expect(isMeaningfulBox({ x: 5, y: 5, w: MIN_REDACT_BOX_PX, h: MIN_REDACT_BOX_PX })).toBe(true)
    expect(isMeaningfulBox({ x: 5, y: 5, w: 2, h: 40 })).toBe(false)
    expect(isMeaningfulBox({ x: 5, y: 5, w: 40, h: 0 })).toBe(false)
  })
})

describe('redact pixel policy', () => {
  it('averages a solid region to its own color', () => {
    const px = new Uint8ClampedArray([10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255])
    expect(averageColor(px)).toEqual({ r: 10, g: 20, b: 30 })
  })

  it('averages mixed pixels and rounds', () => {
    const px = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255])
    expect(averageColor(px)).toEqual({ r: 128, g: 128, b: 128 })
  })

  it('keeps mosaic blocks within the sane range', () => {
    expect(mosaicBlockSize({ x: 0, y: 0, w: 400, h: 300 })).toBe(30)
    expect(mosaicBlockSize({ x: 0, y: 0, w: 12, h: 8 })).toBe(6) // floor
    expect(mosaicBlockSize({ x: 0, y: 0, w: 800, h: 600 })).toBe(32) // ceiling
  })

  it('keeps PNG when it fits and falls back to JPEG when it does not', () => {
    expect(chooseExportFormat(1_000_000, 8_000_000).mime).toBe('image/png')
    const tooBig = chooseExportFormat(9_000_000, 8_000_000)
    expect(tooBig.mime).toBe('image/jpeg')
    expect(tooBig.quality).toBe(0.85)
    const huge = chooseExportFormat(40_000_000, 8_000_000)
    expect(huge.quality).toBe(0.7)
  })
})

describe('attachable image mimes', () => {
  it('accepts what nativeImage can decode', () => {
    expect(isAttachableImageMime('image/png')).toBe(true)
    expect(isAttachableImageMime('image/jpeg')).toBe(true)
    expect(isAttachableImageMime('image/jpg')).toBe(true)
  })

  it('rejects formats the encoder cannot handle', () => {
    expect(isAttachableImageMime('image/webp')).toBe(false)
    expect(isAttachableImageMime('image/gif')).toBe(false)
    expect(isAttachableImageMime('application/pdf')).toBe(false)
    expect(isAttachableImageMime('')).toBe(false)
  })
})
