import type { DisplayInfo, Rect } from '@shared/types'

/**
 * Pure geometry helpers for mapping a user-selected rectangle from
 * device-independent pixels (DIP, what Electron windows use) to the pixel
 * grid of a captured screen image, correctly handling mixed-DPI multi-monitor
 * setups and negative virtual-screen coordinates.
 */

/** Minimum selectable size (DIP) below which a selection is treated as a click. */
export const MIN_SELECTION_DIP = 8

/** Normalizes a drag rect so width/height are positive and x/y is the top-left corner. */
export function normalizeRect(r: Rect): Rect {
  const x = r.width < 0 ? r.x + r.width : r.x
  const y = r.height < 0 ? r.y + r.height : r.y
  return {
    x,
    y,
    width: Math.abs(r.width),
    height: Math.abs(r.height)
  }
}

export function isValidSelection(r: Rect, minDip = MIN_SELECTION_DIP): boolean {
  return r.width >= minDip && r.height >= minDip
}

/** Clamps a rect to a display's bounds (both in DIP screen coordinates). */
export function clampRectToDisplay(r: Rect, display: DisplayInfo): Rect {
  const b = display.bounds
  const x = Math.min(Math.max(r.x, b.x), b.x + b.width)
  const y = Math.min(Math.max(r.y, b.y), b.y + b.height)
  const x2 = Math.min(Math.max(r.x + r.width, b.x), b.x + b.width)
  const y2 = Math.min(Math.max(r.y + r.height, b.y), b.y + b.height)
  return { x, y, width: Math.max(0, x2 - x), height: Math.max(0, y2 - y) }
}

export interface PixelRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Maps a DIP selection rect to pixel coordinates on a captured image of the
 * display. Because `desktopCapturer` thumbnails may be returned at any size
 * (physical resolution, DPI-scaled, or letterboxed to fit a requested box),
 * the mapping is done through *normalized* display coordinates:
 *
 *   display DIP bounds → fraction of the display → image pixels.
 *
 * This is robust for every combination of display scale factor and returned
 * thumbnail size, including negative virtual-screen origins.
 */
export function dipRectToImagePixels(
  selection: Rect,
  display: DisplayInfo,
  imageSize: { width: number; height: number }
): PixelRect {
  const b = display.bounds
  const fx = (selection.x - b.x) / b.width
  const fy = (selection.y - b.y) / b.height
  const fw = selection.width / b.width
  const fh = selection.height / b.height
  const px = Math.round(fx * imageSize.width)
  const py = Math.round(fy * imageSize.height)
  const pw = Math.max(1, Math.round(fw * imageSize.width))
  const ph = Math.max(1, Math.round(fh * imageSize.height))
  // Guard against rounding pushing the crop outside the image.
  const w = Math.min(pw, imageSize.width - px)
  const h = Math.min(ph, imageSize.height - py)
  return { x: px, y: py, width: Math.max(1, w), height: Math.max(1, h) }
}

/** Finds the display containing the center of the rect, if any. */
export function findDisplayForRect(displays: DisplayInfo[], rect: Rect): DisplayInfo | null {
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  return displays.find((d) => cx >= d.bounds.x && cx < d.bounds.x + d.bounds.width && cy >= d.bounds.y && cy < d.bounds.y + d.bounds.height) ?? null
}
