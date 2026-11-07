import { globalShortcut } from 'electron'

/**
 * Global shortcut registration with honest status reporting.
 * If the accelerator cannot be registered (another app owns it), the failure
 * is surfaced to Settings — never silently ignored. On quit the shortcut is
 * always unregistered.
 */

export interface ShortcutStatus {
  registered: boolean
  error?: string
}

export class ShortcutManager {
  private current: string | null = null
  private status: ShortcutStatus = { registered: false, error: 'Shortcut not registered yet.' }

  /**
   * Registers `accelerator` (e.g. "Shift+R"), replacing any previous one.
   * Returns the real outcome so the UI can report conflicts honestly.
   */
  register(accelerator: string, handler: () => void): ShortcutStatus {
    this.unregister()
    try {
      const ok = globalShortcut.register(accelerator, handler)
      if (!ok) {
        this.status = {
          registered: false,
          error: `"${accelerator}" is already in use (possibly by another Screen Scout shortcut). Pick a different shortcut in Settings.`
        }
        return this.status
      }
      this.current = accelerator
      this.status = { registered: true }
      return this.status
    } catch (error) {
      this.status = {
        registered: false,
        error: `"${accelerator}" could not be registered (${error instanceof Error ? error.message : 'unknown error'}). Pick a different shortcut in Settings.`
      }
      return this.status
    }
  }

  /** The honest outcome of the last registration attempt. */
  currentStatus(): ShortcutStatus {
    return this.status
  }

  unregister(): void {
    if (this.current) {
      try {
        globalShortcut.unregister(this.current)
      } catch {
        // Best-effort cleanup during shutdown.
      }
      this.current = null
    }
  }

  unregisterAll(): void {
    try {
      globalShortcut.unregisterAll()
    } catch {
      // Best-effort cleanup during shutdown.
    }
    this.current = null
  }
}
