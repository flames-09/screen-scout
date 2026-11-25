import { Menu, Tray, nativeImage, app } from 'electron'
import * as path from 'node:path'
import type { BrowserWindow } from 'electron'

/**
 * System tray: the app's permanent, unobtrusive home.
 * Left-click toggles the assistant popup; the context menu exposes
 * Open assistant / Settings / Quit.
 */
export function createTray(deps: {
  assistant: () => BrowserWindow | null
  openAssistant: () => void
  openSettings: () => void
  shortcutLabel: () => string
}): Tray {
  // macOS menu bars want a monochrome template image the system can tint for
  // light/dark mode; Windows keeps the colored tile. Electron picks up the
  // 2x variant automatically when the file is named `<name>@2x.png`.
  const iconPath = path.join(
    __dirname,
    '../../assets',
    process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'
  )
  let image = nativeImage.createFromPath(iconPath)
  if (process.platform === 'darwin' && !image.isEmpty()) image.setTemplateImage(true)
  if (image.isEmpty()) {
    // Extremely defensive fallback: a 1px transparent image keeps the tray alive.
    image = nativeImage.createEmpty()
  }
  const tray = new Tray(image)

  const updateTooltip = (): void => {
    tray.setToolTip(`Screen Scout - ${deps.shortcutLabel()} to open`)
  // Note: on macOS, setContextMenu means a left-click pops the menu (click
  // events are suppressed), so mac users get the menu instead of the
  // left-click toggle. The menu's Open assistant entry covers it for now.
  }
  updateTooltip()

  const rebuild = (): void => {
    const menu = Menu.buildFromTemplate([
      { label: 'Open assistant', type: 'normal', click: () => deps.openAssistant() },
      { label: 'Settings', type: 'normal', click: () => deps.openSettings() },
      { type: 'separator' },
      { label: 'Quit Screen Scout', type: 'normal', click: () => app.quit() }
    ])
    tray.setContextMenu(menu)
  }
  rebuild()

  tray.on('click', () => deps.openAssistant())

  return tray
}
