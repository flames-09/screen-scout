/** Pure crop geometry for the frosted-glass backdrop (no Electron imports —
 * unit-testable). Converts a window bounds rect (DIPs, absolute screen
 * coords) into the pixel-space crop rect within a captured screen image,
 * clamped to the image. The capture may be scaled down from the display's
 * physical resolution — the real pixel scale is derived from the image size,
 * so any thumbnail resolution works. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export function backdropCropRect(
  bounds: Rect,
  displayBounds: Rect,
  imageSize: { width: number; height: number }
): Rect {
  // Intersect the window rect with the display rect first, so windows that
  // hang off the left/top edge get the on-screen portion only.
  const scaleX = imageSize.width / displayBounds.width
  const scaleY = imageSize.height / displayBounds.height
  const left = Math.max(bounds.x, displayBounds.x)
  const top = Math.max(bounds.y, displayBounds.y)
  const right = Math.min(bounds.x + bounds.width, displayBounds.x + displayBounds.width)
  const bottom = Math.min(bounds.y + bounds.height, displayBounds.y + displayBounds.height)
  const x = Math.round((left - displayBounds.x) * scaleX)
  const y = Math.round((top - displayBounds.y) * scaleY)
  const width = Math.round((right - left) * scaleX)
  const height = Math.round((bottom - top) * scaleY)
  const cx = Math.max(0, Math.min(x, imageSize.width))
  const cy = Math.max(0, Math.min(y, imageSize.height))
  return {
    x: cx,
    y: cy,
    width: Math.max(1, Math.min(width, imageSize.width - cx)),
    height: Math.max(1, Math.min(height, imageSize.height - cy))
  }
}
