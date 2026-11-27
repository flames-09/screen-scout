/**
 * Ctrl/Cmd +/-/0 keyboard handling for the assistant popup's zoom.
 *
 * The assistant zoom is the app's OWN setting (persisted, mirrored by the
 * Settings slider at 70–160%). Chromium's default zoom accelerators are a
 * poor fit for it: Ctrl+- works out of the box, but the zoom-in accelerator
 * is bound to the '+' character (Shift+'=' on most layouts), so the natural
 * Ctrl+= press never matches — the asymmetry this module exists to fix. The
 * main process intercepts these keys and rewrites them as settings.zoom
 * changes, and preventDefault keeps Chromium's page zoom from also firing.
 */

export const ZOOM_MIN = 0.7
export const ZOOM_MAX = 1.6
export const ZOOM_STEP = 0.05

/**
 * Returns the new zoom for a Ctrl/Cmd key press, or null when the key is not
 * a zoom key. Recognized: '=' / '+' / numpad Add (in), '-' / numpad Subtract
 * (out), '0' (reset to 100%). The result is clamped to the slider range and
 * rounded to whole percents so repeated presses land exactly on slider steps.
 */
export function nextZoomFor(current: number, key: string, ctrl: boolean, meta: boolean): number | null {
  if (!ctrl && !meta) return null
  const zoomIn = key === '=' || key === '+' || key === 'Add'
  const zoomOut = key === '-' || key === 'Subtract'
  const reset = key === '0'
  if (!zoomIn && !zoomOut && !reset) return null
  if (reset) return 1
  // Work in integer percents: 0.85 + 0.05 is not exactly 0.9 in float math,
  // and drift would visibly desync the keypresses from the slider. Snapping
  // the base onto the 5% grid keeps legacy off-grid values (e.g. 1.13) in
  // lockstep with the slider's step, which is also 5%.
  const base = Math.round((current * 100) / (ZOOM_STEP * 100)) * (ZOOM_STEP * 100)
  const percent = base + (zoomIn ? ZOOM_STEP * 100 : -ZOOM_STEP * 100)
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, percent / 100))
}
