import { desktopCapturer, screen } from 'electron'
import { backdropCropRect } from './backdrop-geometry'
import type { Rect } from './backdrop-geometry'
import { sameDisplay } from './capture/capture-service'

export { backdropCropRect } from './backdrop-geometry'
export type { Rect } from './backdrop-geometry'

/**
 * Frosted-glass backdrop: captures the screen region behind a window so the
 * renderer can blur it under the UI. This replaces the OS acrylic material,
 * which silently falls back to a flat surface on some machines (GPU driver
 * policies, remote sessions) — a screenshot + CSS blur works everywhere and
 * costs one capture per show. Nothing is persisted; the image lives only in
 * the window's memory.
 */

/**
 * Captures the desktop region at `bounds` (DIPs, absolute screen coords).
 * The window must be hidden (or about to be shown) so it does not capture
 * itself. Returns a JPEG data URL, or null when capture is unavailable.
 */
export async function captureBackdrop(bounds: Rect): Promise<string | null> {
  try {
    const display = screen.getDisplayMatching(bounds)
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      // Half the CSS resolution: the frost is blurred 28px in CSS, so the
      // missing pixels are invisible — and the crop encode + the main→renderer
      // payload shrink ~20× (measured: 180KB payload / ~27ms PNG encode at
      // full res → ~9KB / ~0ms JPEG at half res; the OS frame grab itself is
      // scale-independent at ~210-260ms).
      thumbnailSize: {
        width: Math.max(1, Math.round(display.size.width / 2)),
        height: Math.max(1, Math.round(display.size.height / 2))
      }
    })
    if (sources.length === 0) return null
    // sources[0] is not guaranteed to be the requested display — match it the
    // same way captureAllDisplays() does (single-source setups fall through).
    const source =
      sources.find((s) => s.display_id === String(display.id)) ??
      (sources.length === 1 ? sources[0] : sources.find((s) => sameDisplay(s.display_id, display.id)))
    if (!source) return null
    const full = source.thumbnail
    if (full.isEmpty()) return null
    const rect = backdropCropRect(bounds, display.bounds, full.getSize())
    const cropped = full.crop(rect)
    if (cropped.isEmpty()) return null
    // JPEG: the 28px CSS blur hides compression artifacts, and the smaller
    // payload crosses the IPC boundary and decodes much faster than PNG.
    return `data:image/jpeg;base64,${cropped.toJPEG(75).toString('base64')}`
  } catch {
    // Screen capture can be denied or fail on exotic setups; the glass
    // gradient alone is an acceptable fallback.
    return null
  }
}
