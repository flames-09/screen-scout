import type { PixelRect } from './geometry'

/**
 * Pure crop/encode policy + helpers for screen captures.
 *
 * These functions operate on a minimal NativeImage-like interface so they can
 * be unit-tested without Electron. The capture service passes real
 * NativeImage instances, which structurally satisfy this interface.
 */
export interface CropImage {
  getSize(): { width: number; height: number }
  crop(rect: PixelRect): CropImage
  resize(options: { width: number; height: number; quality?: 'good' | 'better' | 'best' }): CropImage
  toPNG(): Buffer
  toJPEG(quality: number): Buffer
}

export interface EncodeOptions {
  /** Max encoded data-URL size in bytes (base64 included). Default 5 MB. */
  maxEncodedBytes?: number
  /** Max long-side pixels kept before encoding; larger crops are downscaled. */
  maxDimension?: number
}

export interface EncodeResult {
  dataUrl: string
  mime: 'image/png' | 'image/jpeg'
  width: number
  height: number
  /** Length of the encoded data URL in bytes. */
  bytes: number
}

const DEFAULT_MAX_ENCODED_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_DIMENSION = 2048
const JPEG_QUALITY = 88

/** Downscale ladder applied to the original crop until the payload fits. */
export const SCALE_LADDER = [1, 0.8, 0.6, 0.45, 0.3, 0.22]

/**
 * Chooses the pixel size for a crop given payload + dimension limits.
 * Pure function used by tests to verify the resize policy.
 */
export function planSize(
  originalWidth: number,
  originalHeight: number,
  options: EncodeOptions = {}
): { width: number; height: number } {
  const maxDim = options.maxDimension ?? DEFAULT_MAX_DIMENSION
  const scale = Math.min(1, maxDim / Math.max(originalWidth, originalHeight))
  return {
    width: Math.max(1, Math.round(originalWidth * scale)),
    height: Math.max(1, Math.round(originalHeight * scale))
  }
}

/**
 * Encodes a cropped image to a data URL under the configured size cap.
 *
 * Strategy (favors legible text):
 *  1. Try PNG at progressively smaller sizes — PNG keeps UI text crisp.
 *  2. If PNG never fits, try JPEG at the same ladder sizes — JPEG is far
 *     smaller for photographic/noisy content.
 *  3. If even the smallest JPEG cannot fit (pathological content), the last
 *     result is returned as-is; the chat layer then blocks it with an
 *     actionable "select a smaller area" message.
 * Only the encoded crop is ever held in memory; nothing touches the disk.
 */
export function encodeCropUnderLimit(image: CropImage, options: EncodeOptions = {}): EncodeResult {
  const maxEncoded = options.maxEncodedBytes ?? DEFAULT_MAX_ENCODED_BYTES
  const { width: w0, height: h0 } = image.getSize()
  const capped = planSize(w0, h0, options)

  const steps: Array<{ image: CropImage; width: number; height: number }> = []
  for (const scale of SCALE_LADDER) {
    const width = Math.max(1, Math.round(capped.width * scale))
    const height = Math.max(1, Math.round(capped.height * scale))
    const scaled: CropImage =
      width === w0 && height === h0
        ? image
        : image.resize({ width, height, quality: 'good' })
    steps.push({ image: scaled, width, height })
    // Under ~256px further PNG shrinking stops helping; stop the ladder.
    if (width <= 256 || height <= 256) break
  }

  // 1. PNG ladder (crisp text).
  for (const step of steps) {
    const png = step.image.toPNG()
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`
    if (dataUrl.length <= maxEncoded) {
      return { dataUrl, mime: 'image/png', width: step.width, height: step.height, bytes: dataUrl.length }
    }
  }

  // 2. JPEG ladder (small payloads; every result must fit the cap).
  for (const step of steps) {
    const jpeg = step.image.toJPEG(JPEG_QUALITY)
    const dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`
    if (dataUrl.length <= maxEncoded) {
      return { dataUrl, mime: 'image/jpeg', width: step.width, height: step.height, bytes: dataUrl.length }
    }
  }

  // 3. Pathological fallback: smallest JPEG attempt (chat layer blocks it).
  const smallest = steps[steps.length - 1] ?? { image, width: w0, height: h0 }
  const jpeg = smallest.image.toJPEG(80)
  const dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`
  return { dataUrl, mime: 'image/jpeg', width: smallest.width, height: smallest.height, bytes: dataUrl.length }
}

/** The 256x256 emerald calibration image used by "Test connection" to
 * verify that the configured model accepts image input. */
export const TEST_IMAGE_DATA_URL =
  'data:image/png;base64,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'
