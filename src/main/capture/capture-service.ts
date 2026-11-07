import { BrowserWindow, desktopCapturer, ipcMain, screen } from 'electron'
import type { DisplayInfo, Rect, SelectionResult, SelectionStartResult } from '@shared/types'
import { selectionRectSchema } from '@shared/schemas'
import {
  clampRectToDisplay,
  dipRectToImagePixels,
  isValidSelection,
  MIN_SELECTION_DIP,
  normalizeRect
} from './geometry'
import { encodeCropUnderLimit, type CropImage } from './image-processing'
import { createOverlayWindow } from '../windows'

/**
 * Screen-region capture orchestration.
 *
 * Correctness rules enforced here:
 *  1. The desktop is captured via `desktopCapturer` BEFORE any overlay window
 *     is shown, so the dimming UI can never appear in the crop.
 *  2. The assistant popup is hidden during selection so it is not captured.
 *  3. DIP selection rectangles are mapped through *normalized display
 *     coordinates* onto the captured thumbnail, which stays correct for
 *     mixed-DPI multi-monitor setups and negative virtual-screen origins.
 *  4. Only the cropped rectangle is encoded; full-display captures are
 *     released immediately afterwards.
 */

interface DisplayCapture {
  display: DisplayInfo
  image: CropImage
}

interface PendingSelection {
  resolve: (result: SelectionResult) => void
  overlays: Map<number, { win: BrowserWindow; display: DisplayInfo }> // key: webContents.id
  captures: Map<number, DisplayCapture> // key: display.id
  assistant: BrowserWindow
  settled: boolean
}

export class CaptureService {
  private pending: PendingSelection | null = null
  private starting = false

  constructor(
    private deps: {
      getSettingsMaxImageBytes(): number
      /** Recaptures the frost, then calls `present` (capped — see index.ts). */
      presentWithFrost?(win: BrowserWindow, present: () => void): void
    }
  ) {}

  /**
   * Only the assistant popup may start a selection through IPC — any other
   * first-party renderer (settings, overlay) is refused, matching every
   * other data handler. The direct-capture shortcut bypasses IPC entirely.
   */
  registerIpc(isAssistantSender: (sender: Electron.WebContents) => boolean): void {
    ipcMain.handle('selection:start', async (event) => {
      if (!isAssistantSender(event.sender)) {
        return { status: 'failed', message: 'Screen selection can only be started from the assistant window.' } satisfies SelectionStartResult
      }
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return { status: 'failed', message: 'No window.' } satisfies SelectionStartResult
      return this.startSelection(win)
    })

    ipcMain.on('selection:rect', (event, payload) => {
      const parsed = selectionRectSchema.safeParse(payload)
      if (!parsed.success) return
      void this.handleRect(event.sender.id, parsed.data)
    })

    ipcMain.on('selection:cancel', () => {
      this.finish({ status: 'cancelled' })
    })
  }

  isActive(): boolean {
    // `starting` covers the async preparation (desktop capture + overlay
    // creation) before `pending` exists — without it a second trigger in
    // that window would pass every guard and orphan the first session's
    // full-screen overlays.
    return this.pending !== null || this.starting
  }

  /**
   * Runs a full selection session. The invoke only reports whether the
   * overlay actually started; the crop/cancel outcome always arrives as a
   * pushed `selection:result` event on the assistant window. That keeps
   * button-initiated and global-shortcut-initiated captures on one path.
   */
  async startSelection(assistant: BrowserWindow): Promise<SelectionStartResult> {
    if (this.pending || this.starting) {
      return { status: 'failed', message: 'A screen selection is already in progress.' }
    }
    // Reserve the session slot SYNCHRONOUSLY (before any await) so parallel
    // triggers cannot double-start; `finally` hands the slot to `pending`.
    this.starting = true
    try {
      return await this.runSelection(assistant)
    } finally {
      this.starting = false
    }
  }

  private async runSelection(assistant: BrowserWindow): Promise<SelectionStartResult> {
    // 1. Hide the assistant popup so it is never part of the screenshot.
    const wasVisible = assistant.isVisible()
    if (wasVisible) assistant.hide()

    // 2. Capture every display before any overlay exists.
    let captures: Map<number, DisplayCapture>
    try {
      captures = await captureAllDisplays()
    } catch {
      // Always re-show: in the button flow the popup was visible before, and
      // in the direct-capture flow the user needs to SEE the failure (and any
      // attachment that arrived while this selection was deferring its show).
      assistant.show()
      return {
        status: 'failed',
        message: "Screen capture isn't available right now. Close apps that might be blocking capture and try again."
      }
    }
    if (captures.size === 0) {
      assistant.show()
      return { status: 'failed', message: "Couldn't access the screen. Try selecting it again." }
    }

    // 3. Show one selection overlay per captured display.
    const overlays = new Map<number, { win: BrowserWindow; display: DisplayInfo }>()
    let overlayWindows: BrowserWindow[] = []
    try {
      overlayWindows = await Promise.all(
        [...captures.values()].map(async (cap) => {
          const win = createOverlayWindow({ bounds: cap.display.bounds, displayId: cap.display.id })
          overlays.set(win.webContents.id, { win, display: cap.display })
          await new Promise<void>((resolve) => {
            if (win.isVisible()) return resolve()
            win.once('ready-to-show', () => resolve())
            setTimeout(() => resolve(), 600) // never block forever
          })
          win.show()
          return win
        })
      )
    } catch {
      for (const { win } of overlays.values()) {
        if (!win.isDestroyed()) win.destroy()
      }
      for (const w of overlayWindows) {
        if (!w.isDestroyed()) w.destroy()
      }
      this.release()
      assistant.show()
      return { status: 'failed', message: "Couldn't start screen selection. Try again." }
    }

    // 4. Overlay UI reports a rect / cancellation via `finish` → pushed event.
    const resultPromise = new Promise<SelectionResult>((resolve) => {
      this.pending = { resolve, overlays, captures, assistant, settled: false }
      for (const win of overlayWindows) {
        win.once('closed', () => {
          if (this.pending && !this.pending.settled) {
            // All overlays gone without a selection → cancelled.
            const remaining = [...this.pending.overlays.values()].filter((o) => !o.win.isDestroyed() && o.win.isVisible())
            if (remaining.length === 0) this.finish({ status: 'cancelled' })
          }
        })
      }
    })
    void resultPromise // consumed via the pushed `selection:result` event
    return { status: 'started' }
  }

  private async handleRect(webContentsId: number, raw: Rect): Promise<void> {
    const pending = this.pending
    if (!pending || pending.settled) return

    const entry = pending.overlays.get(webContentsId)
    if (!entry) return
    const { display } = entry

    const rect = clampRectToDisplay(normalizeRect(raw), display)
    if (!isValidSelection(rect, MIN_SELECTION_DIP)) {
      // Too small: keep the overlay open, nudge the user to drag a bigger area.
      if (!entry.win.isDestroyed()) {
        entry.win.webContents.send('selection:invalid', {
          message: 'Area too small — drag a larger rectangle.'
        })
      }
      return
    }

    const capture = pending.captures.get(display.id)
    if (!capture) {
      this.finish({ status: 'failed', message: "Couldn't capture that area. Try selecting it again." })
      return
    }

    // Map DIP rect → pixels on the captured thumbnail and crop.
    const imageSize = capture.image.getSize()
    const pixelRect = dipRectToImagePixels(rect, display, imageSize)
    let result: SelectionResult
    try {
      if (pixelRect.width < 2 || pixelRect.height < 2) {
        result = { status: 'failed', message: "Couldn't capture that area. Try selecting it again." }
      } else {
        const cropped = capture.image.crop(pixelRect)
        const encoded = encodeCropUnderLimit(cropped, {
          maxEncodedBytes: this.deps.getSettingsMaxImageBytes()
        })
        result = {
          status: 'captured',
          dataUrl: encoded.dataUrl,
          width: encoded.width,
          height: encoded.height,
          bytes: encoded.bytes,
          mime: encoded.mime
        }
      }
    } catch {
      result = { status: 'failed', message: "Couldn't capture that area. Try selecting it again." }
    }
    this.finish(result)
  }

  private finish(result: SelectionResult): void {
    const pending = this.pending
    if (!pending || pending.settled) return
    pending.settled = true
    this.pending = null

    for (const { win } of pending.overlays.values()) {
      if (!win.isDestroyed()) {
        win.destroy()
      }
    }

    // Show the assistant again above the freshly selected crop.
    if (!pending.assistant.isDestroyed()) {
      // Push the outcome BEFORE showing: the renderer may reset its session
      // on the visibility event, and the result must land after that reset
      // either way (a hidden popup that opens with the crop is the expected
      // flow for the direct-capture shortcut). If the renderer is still
      // loading (capture triggered within the first second after boot), the
      // listener isn't registered yet — hold the push until load completes.
      const wc = pending.assistant.webContents
      const push = (): void => {
        if (!wc.isDestroyed()) wc.send('selection:result', result)
      }
      if (wc.isLoading()) {
        wc.once('did-finish-load', push)
      } else {
        push()
      }
      // Present the popup after a fresh frost capture. The direct-capture
      // flow hid the popup via a visibility event (renderer dropped the
      // frost), and the button flow's desktop may have changed too — either
      // way the pre-show capture guarantees a correct frost. The window is
      // permanently content-protected (see windows.ts), so the frost can never
      // contain the popup; the popup presents after a snappy cap regardless
      // (see captureFrostThenPresent).
      const present = (): void => {
        if (pending.assistant.isDestroyed()) return
        if (this.pending || this.starting) return // a newer selection took over
        pending.assistant.show()
        pending.assistant.focus()
      }
      const hook = this.deps.presentWithFrost
      if (hook) hook(pending.assistant, present)
      else present()
    }

    pending.captures.clear()
    pending.resolve(result)
  }

  /** Cancels an in-progress selection (used by the global shortcut / tray). */
  cancelIfActive(): void {
    if (this.pending) this.finish({ status: 'cancelled' })
  }

  private release(): void {
    this.pending = null
  }
}

/** Captures all displays at their physical resolution before overlays exist. */
async function captureAllDisplays(): Promise<Map<number, DisplayCapture>> {
  const displays: DisplayInfo[] = screen.getAllDisplays().map((d) => ({
    id: d.id,
    bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
    scaleFactor: d.scaleFactor
  }))

  const out = new Map<number, DisplayCapture>()
  for (const display of displays) {
    const physical = {
      width: Math.max(1, Math.round(display.bounds.width * display.scaleFactor)),
      height: Math.max(1, Math.round(display.bounds.height * display.scaleFactor))
    }
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: physical
    })
    const source =
      sources.find((s) => s.display_id === String(display.id)) ??
      (sources.length === 1 ? sources[0] : sources.find((s) => sameDisplay(s.display_id, display.id)))
    if (!source) continue
    const thumb = source.thumbnail
    if (thumb.isEmpty()) continue
    out.set(display.id, { display, image: thumb as unknown as CropImage })
  }
  return out
}

function sameDisplay(sourceDisplayId: string, displayId: number): boolean {
  // On some platforms display ids are reported with different formatting.
  return sourceDisplayId === String(displayId) || sourceDisplayId.replace(/\D/g, '') === String(displayId)
}

export { sameDisplay }
