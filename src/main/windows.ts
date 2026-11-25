import { BrowserWindow, screen } from 'electron'
import * as path from 'node:path'

/** App logo for dev-mode taskbar/window icons (packaged builds use the exe icon). */
export const APP_ICON_PATH = path.join(__dirname, '../../assets/icon-512.png')

/**
 * Window creation and lifecycle for Screen Scout.
 *
 * Security baseline (applies to every window):
 *  - contextIsolation: true, nodeIntegration: false, sandbox: true
 *  - only our typed preload is loaded; no remote content
 *  - navigation and window.open are denied
 *
 * Visual baseline: frameless truly-transparent windows; the frosted-glass
 * look is produced IN-PAGE (see .glass-backdrop in app.css). Do NOT enable
 * the Windows `backgroundMaterial: 'acrylic'` system backdrop: where it
 * falls back to a flat surface (common on AMD/older drivers) it paints an
 * opaque grey sheet behind the transparent page, which shows as a grey
 * rectangular ring around the rounded glass slab.
 */

export const ASSISTANT_SIZE = { width: 440, height: 560 }
export const ASSISTANT_MIN = { width: 380, height: 460 }
export const ASSISTANT_MAX = { width: 680, height: 860 }
export const SETTINGS_SIZE = { width: 540, height: 700 }

function rendererDevUrl(): string | null {
  const url = process.env['ELECTRON_RENDERER_URL'] || process.env['RENDERER_VITE_DEV_SERVER_URL'] || ''
  return url || null
}

/** Loads a renderer page ("index" | "overlay" | "settings") in dev or prod. */
export function loadRendererPage(win: BrowserWindow, page: 'index' | 'overlay' | 'settings'): void {
  const devUrl = rendererDevUrl()
  if (devUrl) {
    if (page === 'index') win.loadURL(devUrl)
    else win.loadURL(`${devUrl.replace(/\/$/, '')}/${page}.html`)
  } else {
    win.loadFile(path.join(__dirname, `../renderer/${page}.html`))
  }
}

function secureWebPreferences(preloadPath: string): Electron.WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    spellcheck: false
  }
}

function hardenWebContents(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
  win.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
}

export function preloadPath(): string {
  return path.join(__dirname, '../preload/index.js')
}

/**
 * Transparent (layered) windows on Windows can stop painting when another
 * app takes focus: the window stays programmatically visible but vanishes
 * from screen. Forcing the compositor to present a fresh frame on every
 * blur fixes it; re-asserting the level defends against re-styling drops,
 * and the same re-styling can reset display affinity, so content protection
 * is re-asserted with the same idempotent guard the 'show' handler uses.
 * This is NOT a hide-on-blur policy — these windows deliberately survive
 * losing focus (Esc / the shortcut / the close button hide them).
 */
export function attachTransparentWindowBlurGuard(win: BrowserWindow): void {
  win.on('blur', () => {
    win.webContents.invalidate()
    win.setAlwaysOnTop(true, 'floating')
    if (!win.isContentProtected()) win.setContentProtection(true)
  })
}

export function createAssistantWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...ASSISTANT_SIZE,
    icon: APP_ICON_PATH,
    minWidth: ASSISTANT_MIN.width,
    minHeight: ASSISTANT_MIN.height,
    maxWidth: ASSISTANT_MAX.width,
    maxHeight: ASSISTANT_MAX.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // No backgroundMaterial here on purpose — see the file header. The
    // in-page .glass-backdrop provides the desktop blur instead.
    // (hasShadow is effectively inert for transparent windows on Windows —
    // the visible shadow is the CSS one on .glass-root.)
    hasShadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    show: false,
    useContentSize: true,
    webPreferences: secureWebPreferences(preloadPath())
  })
  // Always excluded from screen captures and recordings (Zoom/Teams shares,
  // Snipping Tool, other recorders — WDA_EXCLUDEFROMCAPTURE on Windows): the
  // popup stays fully visible and clickable locally, but never appears in
  // anything captured. This also guarantees frost captures can never contain
  // the window itself (see refreshBackdrop in index.ts).
  // Protection is set AFTER setAlwaysOnTop: re-styling the window resets the
  // display affinity on Windows, which would silently drop the exclusion.
  win.setAlwaysOnTop(true, 'floating')
  win.setContentProtection(true)
  hardenWebContents(win)
  loadRendererPage(win, 'index')
  // Windows drops display affinity set on a hidden window when it is first
  // presented — re-apply it on every show (idempotent; runs before the
  // first composited frame can leak into a share).
  win.on('show', () => {
    if (!win.isContentProtected()) win.setContentProtection(true)
  })
  attachTransparentWindowBlurGuard(win)
  return win
}

export function createSettingsWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...SETTINGS_SIZE,
    icon: APP_ICON_PATH,
    minWidth: SETTINGS_SIZE.width,
    minHeight: 560,
    maxWidth: SETTINGS_SIZE.width,
    maxHeight: 820,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    show: false,
    useContentSize: true,
    webPreferences: secureWebPreferences(preloadPath())
  })
  // Excluded from screen captures/recordings, same as the assistant popup.
  win.setContentProtection(true)
  hardenWebContents(win)
  loadRendererPage(win, 'settings')
  // Windows drops display affinity set on a hidden window when it is first
  // presented — re-apply it on every show (idempotent; runs before the
  // first composited frame can leak into a share).
  win.on('show', () => {
    if (!win.isContentProtected()) win.setContentProtection(true)
  })
  attachTransparentWindowBlurGuard(win)

  return win
}

export interface OverlaySpec {
  bounds: { x: number; y: number; width: number; height: number }
  displayId: number
}

/** A fullscreen, click-capturing, transparent selection layer over one display. */
export function createOverlayWindow(spec: OverlaySpec): BrowserWindow {
  const win = new BrowserWindow({
    x: spec.bounds.x,
    y: spec.bounds.y,
    width: spec.bounds.width,
    height: spec.bounds.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    webPreferences: secureWebPreferences(preloadPath())
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  // Excluded from screen captures/recordings: a selection in progress must
  // never leak into a live share (viewers keep seeing the normal desktop).
  win.setContentProtection(true)
  hardenWebContents(win)
  loadRendererPage(win, 'overlay')
  // Windows drops display affinity set on a hidden window when it is first
  // presented — re-apply it on every show (idempotent; runs before the
  // first composited frame can leak into a share).
  win.on('show', () => {
    if (!win.isContentProtected()) win.setContentProtection(true)
  })
  attachTransparentWindowBlurGuard(win)

  return win
}

/**
 * Places a window in the bottom-right corner of the display that contains the
 * pointer (tray-adjacent), with a margin from the screen edges, clamped to
 * that display's work area. Leaves the window untouched when screen
 * information is unavailable.
 */
export function placeOnPointerDisplayCorner(
  win: BrowserWindow,
  size: { width: number; height: number },
  margin = 16
): void {
  try {
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const area = display.workArea
    const x = Math.max(area.x + margin, Math.round(area.x + area.width - size.width - margin))
    const y = Math.max(area.y + margin, Math.round(area.y + area.height - size.height - margin))
    win.setBounds({ x, y, width: size.width, height: size.height })
  } catch {
    // Fallback: leave the window wherever the OS placed it.
  }
}

export { BrowserWindow }
