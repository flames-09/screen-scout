import { describe, expect, it } from 'vitest'
import { encodeCropUnderLimit, planSize, SCALE_LADDER, TEST_IMAGE_DATA_URL, type CropImage } from '../src/main/capture/image-processing'

/** Deterministic fake NativeImage: PNG ~3 bytes/px, JPEG ~0.5 bytes/px. */
class FakeImage implements CropImage {
  constructor(
    private w: number,
    private h: number,
    private pngBytesPerPx = 3,
    private jpegBytesPerPx = 0.5
  ) {}

  getSize(): { width: number; height: number } {
    return { width: this.w, height: this.h }
  }

  crop(rect: { x: number; y: number; width: number; height: number }): CropImage {
    return new FakeImage(rect.width, rect.height, this.pngBytesPerPx, this.jpegBytesPerPx)
  }

  resize(options: { width: number; height: number }): CropImage {
    return new FakeImage(options.width, options.height, this.pngBytesPerPx, this.jpegBytesPerPx)
  }

  toPNG(): Buffer {
    return Buffer.alloc(Math.ceil(this.w * this.h * this.pngBytesPerPx) + 64)
  }

  toJPEG(quality: number): Buffer {
    void quality
    return Buffer.alloc(Math.ceil(this.w * this.h * this.jpegBytesPerPx) + 64)
  }
}

function base64Len(buf: Buffer): number {
  return Math.ceil((buf.length * 4) / 3)
}

describe('planSize', () => {
  it('keeps small crops at native size', () => {
    expect(planSize(800, 400)).toEqual({ width: 800, height: 400 })
  })

  it('caps the long side at the configured max dimension', () => {
    expect(planSize(4000, 1000, { maxDimension: 2048 })).toEqual({ width: 2048, height: 512 })
    expect(planSize(1000, 4000, { maxDimension: 2048 })).toEqual({ width: 512, height: 2048 })
  })
})

describe('encodeCropUnderLimit', () => {
  it('returns full-resolution PNG when it fits', () => {
    const img = new FakeImage(500, 300)
    const out = encodeCropUnderLimit(img, { maxEncodedBytes: 10 * 1024 * 1024 })
    expect(out.mime).toBe('image/png')
    expect(out.width).toBe(500)
    expect(out.height).toBe(300)
    expect(out.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(out.bytes).toBe(out.dataUrl.length)
  })

  it('downscales proportionally until the payload fits', () => {
    // 3000x2000 at 3 bytes/px PNG → ~24 MB base64; cap 5 MB.
    const img = new FakeImage(3000, 2000)
    const out = encodeCropUnderLimit(img, { maxEncodedBytes: 5 * 1024 * 1024 })
    expect(out.bytes).toBeLessThanOrEqual(5 * 1024 * 1024)
    // Aspect ratio must be preserved within rounding.
    expect(Math.abs(out.width / out.height - 1.5)).toBeLessThan(0.05)
    // It must be smaller than the original.
    expect(out.width).toBeLessThan(3000)
  })

  it('falls back to JPEG when even the smallest PNG attempt overflows', () => {
    // A "screenshot" with pathological PNG entropy (20 bytes/px) and a tiny cap.
    const img = new FakeImage(1200, 800, 20, 0.05)
    const out = encodeCropUnderLimit(img, { maxEncodedBytes: 64 * 1024, maxDimension: 600 })
    expect(out.mime).toBe('image/jpeg')
    expect(out.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(out.bytes).toBeLessThanOrEqual(64 * 1024)
  })

  it('never emits an encoded payload above the cap in the JPEG fallback path', () => {
    const img = new FakeImage(1000, 1000, 50, 2)
    const out = encodeCropUnderLimit(img, { maxEncodedBytes: 128 * 1024 })
    expect(out.bytes).toBeLessThanOrEqual(128 * 1024)
    expect(out.width).toBeGreaterThan(0)
    expect(out.height).toBeGreaterThan(0)
  })

  it('respects the max dimension cap even when bytes would fit', () => {
    const img = new FakeImage(3000, 2000) // PNG ~18MB, cap huge
    const out = encodeCropUnderLimit(img, { maxEncodedBytes: 500 * 1024 * 1024, maxDimension: 1600 })
    expect(out.width).toBe(1600)
    expect(out.height).toBe(1067)
  })

  it('the scale ladder is monotonically decreasing and starts at 1', () => {
    for (let i = 1; i < SCALE_LADDER.length; i++) {
      expect(SCALE_LADDER[i]).toBeLessThan(SCALE_LADDER[i - 1])
    }
    expect(SCALE_LADDER[0]).toBe(1)
  })

  it('matches the documented base64 sizing model', () => {
    const img = new FakeImage(100, 100)
    const png = img.toPNG()
    expect(base64Len(png)).toBe(Math.ceil((png.length * 4) / 3))
  })
})

describe('TEST_IMAGE_DATA_URL', () => {
  it('is a valid base64 PNG data URL decodable to a real PNG signature', () => {
    expect(TEST_IMAGE_DATA_URL.startsWith('data:image/png;base64,')).toBe(true)
    const raw = Buffer.from(TEST_IMAGE_DATA_URL.split(',')[1], 'base64')
    expect(raw.slice(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  })
})
