/**
 * Pure geometry + policy math for the redaction editor. No DOM, no canvas —
 * the editor applies these helpers against its live <img> and <canvas>.
 */

export interface RectBox {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Converts a client-space drag (two corner points) into a box in IMAGE pixel
 * coordinates, clamped to the image and normalized so w/h are positive.
 * `scale` is image px per client px (natural size / displayed size), so the
 * client offset is MULTIPLIED by it.
 */
export function boxFromDrag(
  startClient: { x: number; y: number },
  endClient: { x: number; y: number },
  originClient: { x: number; y: number },
  scale: number,
  image: { width: number; height: number }
): RectBox {
  const x1 = (startClient.x - originClient.x) * scale
  const y1 = (startClient.y - originClient.y) * scale
  const x2 = (endClient.x - originClient.x) * scale
  const y2 = (endClient.y - originClient.y) * scale
  const left = Math.min(x1, x2)
  const right = Math.max(x1, x2)
  const top = Math.min(y1, y2)
  const bottom = Math.max(y1, y2)
  const x = Math.max(0, Math.min(image.width, left))
  const y = Math.max(0, Math.min(image.height, top))
  const w = Math.max(0, Math.min(image.width, right) - x)
  const h = Math.max(0, Math.min(image.height, bottom) - y)
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
}

/** A drag smaller than this (in image px) is treated as a stray click. */
export const MIN_REDACT_BOX_PX = 3

export function isMeaningfulBox(box: RectBox): boolean {
  return box.w >= MIN_REDACT_BOX_PX && box.h >= MIN_REDACT_BOX_PX
}

/**
 * Average color of a pixel region (RGBA bytes, row-major over the given box
 * layout). Used for the "Solid" mode so the patch blends with the area
 * instead of a jarring flat black — still a single opaque color: no content
 * of the original pixels survives.
 */
export function averageColor(pixels: Uint8ClampedArray): { r: number; g: number; b: number } {
  let r = 0
  let g = 0
  let b = 0
  const n = pixels.length / 4 || 1
  for (let i = 0; i < pixels.length; i += 4) {
    r += pixels[i]
    g += pixels[i + 1]
    b += pixels[i + 2]
  }
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) }
}

/** Pixelate block size for a box: fine enough to keep layout readable,
 * coarse enough that nothing survives. */
export function mosaicBlockSize(box: RectBox): number {
  const base = Math.round(Math.min(box.w, box.h) / 10)
  return Math.max(6, Math.min(32, base))
}

/**
 * Export policy: PNG preserves text crispness, but a heavily pixelated
 * screenshot can balloon past the payload cap — fall back to a JPEG ladder.
 * Returns the first (mime, quality) that fits, or the last resort.
 */
export function chooseExportFormat(
  pngDataUrlLength: number,
  limit: number
): { mime: 'image/png' | 'image/jpeg'; quality: number | undefined } {
  if (pngDataUrlLength <= limit) return { mime: 'image/png', quality: undefined }
  return { mime: 'image/jpeg', quality: pngDataUrlLength > limit * 4 ? 0.7 : 0.85 }
}
