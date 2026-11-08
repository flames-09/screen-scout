import { app, BrowserWindow, clipboard, nativeImage, screen } from 'electron'
import type { SecretStore } from './security/secrets'
import type { ShortcutManager } from './shortcuts'
import type { E2eRelayHandle } from './e2e-relay'

/**
 * End-to-end user-journey test (run with `electron . --e2e`).
 *
 * Boots the REAL app in an ISOLATED userData dir (never touches the user's
 * key or settings) and drives the real renderer UI through real DOM events
 * and real IPC — no stubs on app code. Covers: popup show/hide, frosted
 * backdrop delivery, session reset on hide, the full capture flow (overlay
 * drag → crop → attachment), cancel + too-small-drag paths, image imports
 * (paste with file, paste from clipboard, drop), the redaction editor
 * (draw patches → bake), privacy notice + no-key error + retry, the
 * settings page (key save/test/remove, both shortcut re-recordings, startup
 * toggle, close), the hosted free tier against a local mock relay (mode
 * switch, quota meter, real streamed answer with no key, quota-exceeded
 * message), the direct-capture shortcut cold start, frost refresh on
 * move (session survives), corner placement with an edge margin, layout
 * overflow, and renderer console cleanliness.
 *
 * NOTE: it cannot synthesize OS-level input (global shortcut keypresses,
 * real mouse drags) — the shortcut→toggle binding is exercised directly and
 * the overlay drag through dispatched PointerEvents on the real overlay DOM.
 */

export interface E2eHooks {
  ensureAssistant(): BrowserWindow
  toggleAssistant(): void
  openSettings(): void
  /** The direct-capture shortcut handler (what Shift+C invokes). */
  startDirectCapture(): void
  togglePeek(): void
  shortcuts: ShortcutManager
  captureShortcuts: ShortcutManager
  secrets: SecretStore
  /** Local mock relay used for the hosted-mode checks (E2E only). */
  relay?: E2eRelayHandle
  /** Number of frost captures actually delivered to a renderer. */
  backdropRefreshCount(): number
}

export interface E2eSurveillance {
  consoleErrors: string[]
  failedLoads: string[]
}

/**
 * Registers renderer console-error + load-failure surveillance for every
 * window created from now on. MUST run before the first window exists —
 * otherwise early load errors are silently dropped.
 */
export function setupE2eSurveillance(): E2eSurveillance {
  const consoleErrors: string[] = []
  const failedLoads: string[] = []
  app.on('browser-window-created', (_event, win) => {
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 3) consoleErrors.push(`${win.webContents.getURL().split('/').pop()}: ${message.slice(0, 200)}`)
    })
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      if (code === -3) return // ERR_ABORTED — navigations we cancel
      failedLoads.push(`${code} ${desc} ${url.slice(0, 120)}`)
    })
  })
  return { consoleErrors, failedLoads }
}

interface Check {
  name: string
  ok: boolean
  detail?: string
}

const E2E_SHORTCUT = 'Control+Shift+F9' // Electron accelerator naming (what the recorder emits)
const E2E_CAPTURE_SHORTCUT = 'Control+Shift+F10'
const FAKE_KEY = 'nvapi-e2e-probe-key-0000000000000000'

export function runE2eTest(hooks: E2eHooks, surveillance: E2eSurveillance): void {
  const { consoleErrors, failedLoads } = surveillance
  const checks: Check[] = []
  const record = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, detail })
    console.log(`E2E ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  }
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  async function waitUntil(what: string, fn: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        if (await fn()) return true
      } catch {
        /* window/page may be mid-load; keep polling */
      }
      await sleep(120)
    }
    console.log(`E2E TIMEOUT waiting for ${what}`)
    return false
  }

  function windowByPage(fragment: string): BrowserWindow | null {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (win.webContents.getURL().includes(fragment)) return win
      } catch {
        /* destroyed mid-poll */
      }
    }
    return null
  }

  async function mounted(win: BrowserWindow, selector: string): Promise<boolean> {
    return win.webContents.executeJavaScript(`!!document.querySelector(${JSON.stringify(selector)})`)
  }

  /** Finds the overlay window whose React UI finished mounting. */
  async function waitOverlayMounted(timeoutMs: number): Promise<BrowserWindow | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const win = windowByPage('overlay.html')
      if (win && (await mounted(win, '.overlay-root'))) return win
      await sleep(120)
    }
    return null
  }

  const settingsWin = (): BrowserWindow | null => windowByPage('settings.html')

  /** Types into a real input/textarea like a user (native setter + input event). */
  const TYPE_JS = (selector: string, text: string): string => `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      const setter = Object.getOwnPropertyDescriptor(
        el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value'
      ).set
      setter.call(el, ${JSON.stringify(text)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()
  `

  const clickJs = (selector: string): string =>
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true })()`

  const findByTextJs = (text: string): string =>
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent && x.textContent.includes(${JSON.stringify(text)})); if (!b) return false; b.click(); return true })()`

  /** Dispatches a synthetic pointer drag on the live overlay DOM. */
  const DRAG_JS = (from: [number, number], to: [number, number]): string => `
    (() => {
      const root = document.querySelector('.overlay-root')
      if (!root) return 'no overlay root'
      const opts = (x, y) => ({ bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: 1, clientX: x, clientY: y, isPrimary: true })
      root.dispatchEvent(new PointerEvent('pointerdown', opts(${from[0]}, ${from[1]})))
      root.dispatchEvent(new PointerEvent('pointermove', opts(${(from[0] + to[0]) / 2}, ${(from[1] + to[1]) / 2})))
      root.dispatchEvent(new PointerEvent('pointermove', opts(${to[0]}, ${to[1]})))
      root.dispatchEvent(new PointerEvent('pointerup', { ...opts(${to[0]}, ${to[1]}), buttons: 0 }))
      return 'dragged'
    })()
  `

  const ESC_JS = `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 'esc' })()`

  /** Builds a small solid-color PNG in-page and returns its data URL. */
  const CANVAS_PNG_JS = (w: number, h: number, color: string): string => `
    (async () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = ${w}; canvas.height = ${h}
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = ${JSON.stringify(color)}; ctx.fillRect(0, 0, ${w}, ${h})
        return canvas.toDataURL('image/png')
      } catch (e) {
        return 'error: ' + e
      }
    })()
  `

  /** Decodes a data URL to bytes WITHOUT fetch — the page CSP blocks data: fetches. */
  const DATA_URL_TO_FILE_JS = (dataUrlVar: string, name: string): string => `
    (() => {
      const b64 = ${dataUrlVar}.split(',')[1]
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return new File([bytes], ${JSON.stringify(name)}, { type: 'image/png' })
    })()
  `

  /** Dispatches a paste carrying an image File (the file-item path). */
  const PASTE_FILE_JS = (dataUrlVar: string): string => `
    (async () => {
      try {
        const file = (${DATA_URL_TO_FILE_JS(dataUrlVar, 'pasted.png')})
        const dt = new DataTransfer()
        dt.items.add(file)
        let seen = 'no-listener'
        const probe = (e) => { seen = e.clipboardData ? [...e.clipboardData.items].map((i) => i.kind + ':' + i.type).join(',') : 'null-cd' }
        window.addEventListener('paste', probe, { capture: true, once: true })
        window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
        window.removeEventListener('paste', probe, true)
        return 'pasted; probe=' + seen
      } catch (e) {
        return 'error: ' + e
      }
    })()
  `

  /** Paste with NO image and NO text — exercises the clipboard fallback. */
  const PASTE_EMPTY_JS = `(() => {
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }))
    return 'pasted-empty'
  })()`

  /** Drops an image File onto the assistant root. */
  const DROP_FILE_JS = (dataUrlVar: string): string => `
    (async () => {
      try {
        const file = (${DATA_URL_TO_FILE_JS(dataUrlVar, 'dropped.png')})
        const dt = new DataTransfer()
        dt.items.add(file)
        const root = document.querySelector('.assistant-root')
        let seen = 'no-listener'
        const probe = (e) => { seen = e.dataTransfer ? 'files=' + e.dataTransfer.files.length : 'null-dt' }
        root.addEventListener('drop', probe, { capture: true, once: true })
        root.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
        root.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
        root.removeEventListener('drop', probe, true)
        return 'dropped; probe=' + seen
      } catch (e) {
        return 'error: ' + e
      }
    })()
  `

  /** Drag a redaction box by fractional positions across the live image. */
  const REDACT_DRAG_JS = (fx1: number, fy1: number, fx2: number, fy2: number): string => `
    (() => {
      const overlay = document.querySelector('.redact-overlay')
      const img = document.querySelector('.redact-img')
      if (!overlay || !img) return 'no editor'
      const r = img.getBoundingClientRect()
      const px = (f) => r.left + r.width * f
      const py = (f) => r.top + r.height * f
      const opts = (x, y) => ({ bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: 1, clientX: x, clientY: y, isPrimary: true })
      overlay.dispatchEvent(new PointerEvent('pointerdown', opts(px(${fx1}), py(${fy1}))))
      overlay.dispatchEvent(new PointerEvent('pointermove', opts(px((${fx1} + ${fx2}) / 2), py((${fy1} + ${fy2}) / 2))))
      overlay.dispatchEvent(new PointerEvent('pointerup', { ...opts(px(${fx2}), py(${fy2})), buttons: 0 }))
      return 'redacted-drag'
    })()
  `

  // ---- Console / load-failure surveillance is registered by the caller
  // (setupE2eSurveillance) BEFORE the first window is created.

  let watchdog: NodeJS.Timeout | null = null
  let finished = false
  function finish(code: number, extra = ''): void {
    if (finished) return // the watchdog and the main flow must never double-report
    finished = true
    if (watchdog) clearTimeout(watchdog)
    console.log(
      `E2E_RESULT ${JSON.stringify({ passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok).length, checks, consoleErrors, failedLoads })}${extra}`
    )
    console.log(code === 0 ? 'E2E_DONE' : 'E2E_FAILED')
    process.exitCode = code
    app.quit()
    setTimeout(() => app.exit(code), 3000) // safety net
  }

  void (async () => {
    // Hard watchdog: the E2E must ALWAYS terminate with diagnostics.
    watchdog = setTimeout(() => {
      console.error('E2E_WATCHDOG timeout — partial results follow')
      finish(2)
    }, 150000)
    try {
      // ---- 1. Boot ---------------------------------------------------------
      const assistant = hooks.ensureAssistant()
      await waitUntil('assistant page load', async () => !assistant.webContents.isLoading(), 8000)
      await sleep(800) // React mount
      record('boot.assistantExists', !!assistant && !assistant.isDestroyed())
      record('boot.secureStorage', hooks.secrets.isSecureStorageAvailable())

      // ---- 2. Toggle open: popup + frost -------------------------------------
      hooks.toggleAssistant()
      record('toggle.showsWindow', await waitUntil('assistant visible', async () => assistant.isVisible(), 3000))
      record(
        'ui.assistantMounted',
        await waitUntil('assistant-root', async () => mounted(assistant, '.assistant-root'), 4000)
      )
      // While VISIBLE the popup must be content-protected: invisible to screen
      // shares/recordings, while the 'show' hook re-applies the affinity that
      // Windows drops for windows protected while hidden.
      record(
        'privacy.contentProtectedWhileVisible',
        await waitUntil(
          'assistant content-protected while visible',
          async () => assistant.isContentProtected() === true,
          3000
        )
      )
      record(
        'glass.backdropArrives',
        await waitUntil('frost layer', async () => mounted(assistant, '.glass-backdrop'), 4000)
      )
      record('ui.emptyState', await mounted(assistant, '.empty-state'))

      // ---- 3. Session reset on hide ------------------------------------------
      const typed = await assistant.webContents.executeJavaScript(TYPE_JS('.composer-input', 'draft to discard'))
      record('composer.acceptsTyping', typed === true)
      hooks.toggleAssistant() // hide
      record('toggle.hidesWindow', await waitUntil('assistant hidden', async () => !assistant.isVisible(), 3000))
      record(
        'privacy.backdropDroppedOnHide',
        await waitUntil('frost dropped', async () => !(await mounted(assistant, '.glass-backdrop')), 2500)
      )
      hooks.toggleAssistant() // show again
      record('toggle.reshows', await waitUntil('assistant visible again', async () => assistant.isVisible(), 3000))
      await sleep(400)
      const draftAfter = await assistant.webContents.executeJavaScript(
        `document.querySelector('.composer-input')?.value ?? 'no-input'`
      )
      record('session.resetDiscardsDraft', draftAfter === '', `draft after reopen: "${draftAfter}"`)

      // ---- 4. Capture: real crop via real overlay + synthetic drag ------------
      record('capture.selectClicked', (await assistant.webContents.executeJavaScript(clickJs('.composer-select'))) === true)
      record(
        'capture.assistantHidesDuringSelection',
        await waitUntil('assistant hidden mid-selection', async () => !assistant.isVisible(), 2500)
      )
      const overlay = await waitOverlayMounted(6000)
      record('capture.overlayShown', overlay !== null)
      if (overlay) {
        record('capture.overlayProtected', overlay.isContentProtected() === true)
        console.log('E2E_DEBUG dispatching drag on overlay')
        const drag = await Promise.race([
          overlay.webContents.executeJavaScript(DRAG_JS([100, 100], [300, 260])),
          sleep(5000).then(() => 'DRAG_SCRIPT_TIMED_OUT')
        ])
        console.log(`E2E_DEBUG drag result: ${drag}`)
        record('capture.dragDispatched', drag === 'dragged', String(drag))
        record(
          'capture.assistantReshows',
          await waitUntil('assistant visible after capture', async () => assistant.isVisible(), 4000)
        )
        record(
          'capture.attachmentStrip',
          await waitUntil('attachment strip', async () => mounted(assistant, '.attachment'), 4000)
        )
        const dims = await assistant.webContents.executeJavaScript(
          `document.querySelector('.attachment-dims')?.textContent ?? 'none'`
        )
        record('capture.dimsShown', /\d+\s*×\s*\d+/.test(String(dims)), String(dims))
        const thumbSrc = await assistant.webContents.executeJavaScript(
          `document.querySelector('.attachment-thumb')?.getAttribute('src')?.slice(0, 15) ?? 'none'`
        )
        record('capture.thumbIsImage', String(thumbSrc).startsWith('data:image'), String(thumbSrc))
      }

      // ---- 5. Cancel path keeps the session ------------------------------------
      record('capture.reselectClicked', (await assistant.webContents.executeJavaScript(clickJs('.composer-select'))) === true)
      const overlay2 = await waitOverlayMounted(6000)
      record('capture.overlayAgain', overlay2 !== null)
      if (overlay2) {
        await overlay2.webContents.executeJavaScript(ESC_JS)
        record(
          'capture.cancelReshows',
          await waitUntil('assistant visible after cancel', async () => assistant.isVisible(), 4000)
        )
        await sleep(400)
        record('capture.cancelKeepsAttachment', await mounted(assistant, '.attachment'))
      }

      // ---- 6. Too-small selections: click-guard + main-process rejection -------
      record('capture.reselect2', (await assistant.webContents.executeJavaScript(clickJs('.composer-select'))) === true)
      const overlay3 = await waitOverlayMounted(6000)
      record('capture.overlayThird', overlay3 !== null)
      if (overlay3) {
        // A 2×1 drag: below the renderer's 4px guard — no rect is ever reported.
        await overlay3.webContents.executeJavaScript(DRAG_JS([50, 50], [52, 51]))
        await sleep(400)
        record('capture.clickGuardKeepsOverlay', overlay3.isVisible() && !overlay3.isDestroyed())
        // A 6×5 drag: passes the renderer guard, but main requires ≥8 DIP —
        // this exercises the real rejection + the "Area too small" toast.
        await overlay3.webContents.executeJavaScript(DRAG_JS([50, 50], [56, 55]))
        record(
          'capture.tooSmallShowsHint',
          await waitUntil('too-small toast', async () => mounted(overlay3, '.overlay-toast'), 2500)
        )
        record('capture.tooSmallKeepsOverlay', overlay3.isVisible() && !overlay3.isDestroyed())
        await overlay3.webContents.executeJavaScript(ESC_JS)
        record(
          'capture.tinyCancelReshows',
          await waitUntil('assistant visible after tiny-cancel', async () => assistant.isVisible(), 4000)
        )
      }

      // ---- 7. Image imports: paste (file), paste (clipboard), drop -------------
      const pastePng = await assistant.webContents.executeJavaScript(CANVAS_PNG_JS(40, 30, '#3366cc'))
      if (!String(pastePng).startsWith('data:image/png;base64,')) {
        console.log(`E2E_DEBUG pastePng invalid: ${String(pastePng).slice(0, 60)}`)
      }
      record(
        'images.pasteFileAttaches',
        await (async () => {
          const dispatched = await assistant.webContents.executeJavaScript(PASTE_FILE_JS(JSON.stringify(pastePng)))
          // Poll for the DIMS to change — `.attachment` already exists from the
          // earlier capture, so existence would race the async import.
          const ok = await waitUntil(
            'attachment after paste',
            async () => {
              const d = await assistant.webContents.executeJavaScript(`document.querySelector('.attachment-dims')?.textContent ?? ''`)
              return String(d).includes('40×30')
            },
            4000
          )
          if (!ok) {
            const toast = await assistant.webContents.executeJavaScript(
              `document.querySelector('.toast.error')?.textContent ?? 'no toast'`
            )
            console.log(`E2E_DEBUG paste toast: ${toast} | dispatched: ${dispatched}`)
            return false
          }
          return true
        })(),
        'expected a 40×30 attachment'
      )

      // Bitmap-only clipboard: main writes an image, the paste carries nothing.
      // NOTE: this overwrites the REAL system clipboard; Electron cannot
      // preserve clipboard images, so only prior TEXT is restored below —
      // any image on the user's clipboard is lost to this test run.
      const clipboardPng = await assistant.webContents.executeJavaScript(CANVAS_PNG_JS(64, 48, '#22aa66'))
      const previousClipboardText = clipboard.readText()
      clipboard.writeImage(nativeImage.createFromDataURL(clipboardPng))
      try {
        await assistant.webContents.executeJavaScript(PASTE_EMPTY_JS)
        record(
          'images.pasteFromClipboardAttaches',
          await waitUntil(
            'attachment after clipboard paste',
            async () => {
              const d = await assistant.webContents.executeJavaScript(`document.querySelector('.attachment-dims')?.textContent ?? ''`)
              return String(d).includes('64×48')
            },
            4000
          ),
          'expected a 64×48 attachment'
        )
      } finally {
        // Best-effort: restore whatever text was on the clipboard (images can
        // only be overwritten, not preserved).
        clipboard.writeText(previousClipboardText)
      }

      const dropPng = await assistant.webContents.executeJavaScript(CANVAS_PNG_JS(50, 38, '#cc3366'))
      record(
        'images.dropFileAttaches',
        await (async () => {
          await assistant.webContents.executeJavaScript(DROP_FILE_JS(JSON.stringify(dropPng)))
          const ok = await waitUntil(
            'attachment after drop',
            async () => {
              const d = await assistant.webContents.executeJavaScript(`document.querySelector('.attachment-dims')?.textContent ?? ''`)
              return String(d).includes('50×38')
            },
            4000
          )
          if (!ok) {
            const toast = await assistant.webContents.executeJavaScript(
              `document.querySelector('.toast.error')?.textContent ?? 'no toast'`
            )
            console.log(`E2E_DEBUG drop toast: ${toast}`)
            return false
          }
          return true
        })(),
        'expected a 50×38 attachment'
      )

      // ---- 7b. Redaction: draw patches → bake → attachment replaced -------------
      const thumbBeforeRedact = await assistant.webContents.executeJavaScript(
        `document.querySelector('.attachment-thumb')?.getAttribute('src')?.length ?? 0`
      )
      record('redact.opened', (await assistant.webContents.executeJavaScript(clickJs('[aria-label="Redact the attached image"]'))) === true)
      record('redact.editorShown', await waitUntil('redact editor', async () => mounted(assistant, '.redact-editor'), 3000))
      await sleep(400) // let the image decode
      const drag1 = await assistant.webContents.executeJavaScript(REDACT_DRAG_JS(0.1, 0.1, 0.35, 0.3))
const drag2 = await assistant.webContents.executeJavaScript(REDACT_DRAG_JS(0.55, 0.5, 0.85, 0.8))
      record('redact.boxesDrawn', drag1 === 'redacted-drag' && drag2 === 'redacted-drag')
      const boxCount = await assistant.webContents.executeJavaScript(`document.querySelectorAll('.redact-box').length`)
      record('redact.twoPatches', boxCount === 2, `${boxCount} patches`)
      record('redact.applyClicked', (await assistant.webContents.executeJavaScript(findByTextJs('Apply'))) === true)
      record(
        'redact.attachmentReplaced',
        await waitUntil('attachment after redact', async () => mounted(assistant, '.attachment'), 4000)
      )
      await sleep(300)
      const thumbAfterRedact = await assistant.webContents.executeJavaScript(
        `document.querySelector('.attachment-thumb')?.getAttribute('src')?.length ?? 0`
      )
      record('redact.bakedNewImage', thumbAfterRedact > 0 && thumbAfterRedact !== thumbBeforeRedact, `len ${thumbBeforeRedact} → ${thumbAfterRedact}`)
      record('redact.editorClosed', !(await mounted(assistant, '.redact-editor')))

      // ---- 8. Chat: privacy notice → no-key error → retry ----------------------
      await assistant.webContents.executeJavaScript(TYPE_JS('.composer-input', 'What does this show?'))
      record('chat.sendClicked', (await assistant.webContents.executeJavaScript(clickJs('.composer-send'))) === true)
      record(
        'chat.privacyNoticeShown',
        await waitUntil('privacy notice', async () => mounted(assistant, '.privacy-notice'), 2500)
      )
      record(
        'chat.sendOnceClicked',
        (await assistant.webContents.executeJavaScript(clickJs('.privacy-actions .btn-primary'))) === true
      )
      record(
        'chat.errorBubbleShown',
        await waitUntil('error bubble', async () => mounted(assistant, '.error-msg'), 4000)
      )
      record(
        'privacy.attachmentClearedAfterSend',
        await waitUntil('attachment cleared', async () => !(await mounted(assistant, '.attachment')), 2500)
      )
      const errText = await assistant.webContents.executeJavaScript(
        `document.querySelector('.error-text')?.textContent ?? 'none'`
      )
      record('chat.errorMentionsKey', /key/i.test(String(errText)), String(errText).slice(0, 80))
      const errDetail = await assistant.webContents.executeJavaScript(
        `document.querySelector('.error-detail-body')?.textContent ?? ''`
      )
      if (errDetail) console.log(`E2E_DEBUG error detail: ${String(errDetail).slice(0, 160)}`)

      // Retry: re-sends the failed turn; still no key → error persists.
      const retryClicked = await assistant.webContents.executeJavaScript(findByTextJs('Try again'))
      record('chat.retryClicked', retryClicked === true)
      record(
        'chat.retryErrorsAgain',
        await waitUntil('error bubble after retry', async () => mounted(assistant, '.error-msg'), 4000)
      )
      // ---- Peek: hide WITHOUT resetting, reopen exactly where we left off ----
      record(
        'peek.typesDraft',
        (await assistant.webContents.executeJavaScript(TYPE_JS('.composer-input', 'peek draft survives'))) === true
      )
      hooks.togglePeek() // hide (resetSession: false) — the draft must survive
      record(
        'peek.hidesWindow',
        await waitUntil('assistant hidden after peek', async () => !assistant.isVisible(), 3000)
      )
      hooks.togglePeek() // show — the renderer was never reset
      record(
        'peek.reshowsWindow',
        await waitUntil('assistant visible after peek', async () => assistant.isVisible(), 3000)
      )
      record('peek.sessionSurvives', await mounted(assistant, '.error-msg'))
      const draftAfterPeek = await assistant.webContents.executeJavaScript(
        `document.querySelector('.composer-input')?.value ?? ''`
      )
      record('peek.draftSurvives', draftAfterPeek === 'peek draft survives', String(draftAfterPeek))
      hooks.togglePeek() // hide again — the next show is the normal full flow
      record(
        'peek.rehides',
        await waitUntil('assistant hidden after re-peek', async () => !assistant.isVisible(), 3000)
      )
      hooks.togglePeek()
      record(
        'peek.reshowsAgain',
        await waitUntil('assistant visible after re-peek show', async () => assistant.isVisible(), 3000)
      )

      await assistant.webContents.executeJavaScript(findByTextJs('Clear'))

      // ---- 8. Settings ---------------------------------------------------------
      record(
        'settings.openFromHeader',
        (await assistant.webContents.executeJavaScript(clickJs('[aria-label="Open settings"]'))) === true
      )
      record(
        'settings.windowShown',
        await waitUntil('settings window visible', async () => settingsWin()?.isVisible() === true, 4000)
      )
      const settings = settingsWin()
      if (!settings) {
        finish(1)
        return
      }
      await waitUntil('settings mounted', async () => mounted(settings, '.settings-root'), 4000)
      record(
        'settings.frostArrives',
        await waitUntil('settings frost', async () => mounted(settings, '.glass-backdrop'), 4000)
      )
      record('settings.contentProtected', settings.isContentProtected() === true)
      record('settings.keyMasked', await mounted(settings, 'input[type=password]'))

      // Key save → secure status → honest test-connection failure → remove.
      record('settings.keyTyped', (await settings.webContents.executeJavaScript(TYPE_JS('input[type=password]', FAKE_KEY))) === true)
      record('settings.saveKeyClicked', (await settings.webContents.executeJavaScript(findByTextJs('Save key securely'))) === true)
      record(
        'settings.keySavedState',
        await waitUntil('key-status secure', async () => mounted(settings, '.key-status.secure'), 4000)
      )
      const hasKey = await settings.webContents.executeJavaScript(
        `(async () => (await window.scout.settings.get()).hasApiKey)()`
      )
      record('settings.hasApiKeyTrue', hasKey === true)

      record('settings.testClicked', (await settings.webContents.executeJavaScript(findByTextJs('Test connection'))) === true)
      record(
        'settings.testResultShown',
        await waitUntil('test result', async () => mounted(settings, '.test-result'), 26000)
      )
      const testOk = await settings.webContents.executeJavaScript(
        `document.querySelector('.test-result')?.classList.contains('ok') ?? null`
      )
      record('settings.testHonestFailure', testOk === false, `test result class ok=${testOk} (fake key must fail)`)

      record('settings.removeKeyClicked', (await settings.webContents.executeJavaScript(findByTextJs('Remove key'))) === true)
      record(
        'settings.keyRemoved',
        await waitUntil('key-status none', async () => mounted(settings, '.key-status.none'), 4000)
      )

      // Shortcut re-recording via the real recorder.
      record('settings.changeShortcutClicked', (await settings.webContents.executeJavaScript(findByTextJs('Change shortcut'))) === true)
      await settings.webContents.executeJavaScript(
        `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F9', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))`
      )
      record(
        'settings.shortcutRebound',
        await waitUntil(
          'shortcut display updated',
          async () =>
            (await settings.webContents.executeJavaScript(
              `document.querySelector('.shortcut-display')?.textContent ?? ''`
            )) === E2E_SHORTCUT,
          4000
        ),
        `expected ${E2E_SHORTCUT}`
      )
      record('shortcuts.registered', hooks.shortcuts.currentStatus().registered === true, JSON.stringify(hooks.shortcuts.currentStatus()))

      // Capture-shortcut re-recording via the real recorder (second row).
      record(
        'settings.changeCaptureShortcutClicked',
        (await settings.webContents.executeJavaScript(findByTextJs('Change capture shortcut'))) === true
      )
      await settings.webContents.executeJavaScript(
        `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))`
      )
      record(
        'settings.captureShortcutRebound',
        await waitUntil(
          'capture shortcut display updated',
          async () =>
            (await settings.webContents.executeJavaScript(
              `document.querySelectorAll('.shortcut-display')[1]?.textContent ?? ''`
            )) === E2E_CAPTURE_SHORTCUT,
          4000
        ),
        `expected ${E2E_CAPTURE_SHORTCUT}`
      )
      record(
        'captureShortcuts.registered',
        hooks.captureShortcuts.currentStatus().registered === true,
        JSON.stringify(hooks.captureShortcuts.currentStatus())
      )

      // Startup toggle flips the stored setting.
      const beforeStartup = await settings.webContents.executeJavaScript(
        `(async () => (await window.scout.settings.get()).launchOnStartup)()`
      )
      await settings.webContents.executeJavaScript(clickJs('.toggle-input'))
      record(
        'settings.startupToggles',
        await waitUntil(
          'startup flipped',
          async () =>
            (await settings.webContents.executeJavaScript(
              `(async () => (await window.scout.settings.get()).launchOnStartup)()`
            )) !== beforeStartup,
          4000
        )
      )

      // Model chip live-update: saving a new model must push it to the popup
      // header instantly (the popup refetches on focus, but focus does not
      // reliably return to an always-on-top window after settings closes).
      const SELECT_JS = (selector: string, value: string): string =>
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); return true })()`
      const NEW_MODEL = 'nvidia/nemotron-nano-12b-v2-vl'
      record(
        'settings.modelSelected',
        (await settings.webContents.executeJavaScript(SELECT_JS('select[aria-label="Model"]', NEW_MODEL))) === true
      )
      record('settings.modelSaved', (await settings.webContents.executeJavaScript(findByTextJs('Save model'))) === true)
      record(
        'settings.modelChipLiveUpdate',
        await waitUntil(
          'assistant model chip updated',
          async () => {
            const chip = await assistant.webContents.executeJavaScript(`document.querySelector('.header-model')?.textContent ?? ''`)
            return String(chip).includes('nemotron-nano-12b-v2-vl')
          },
          3000
        )
      )
      // Restore the default model — the chip must update back the same way.
      record(
        'settings.modelRestored',
        (await settings.webContents.executeJavaScript(
          SELECT_JS('select[aria-label="Model"]', 'meta/llama-3.2-90b-vision-instruct')
        )) === true && (await settings.webContents.executeJavaScript(findByTextJs('Save model'))) === true
      )
      record(
        'settings.modelChipRestored',
        await waitUntil(
          'assistant model chip restored',
          async () => {
            const chip = await assistant.webContents.executeJavaScript(`document.querySelector('.header-model')?.textContent ?? ''`)
            return String(chip).includes('llama-3.2-90b-vision-instruct')
          },
          3000
        )
      )

      // ---- Appearance: glass tint slider (preview → save → restore) ----------
      const tintVar = async (): Promise<string> =>
        String(
          await settings.webContents.executeJavaScript(
            `document.documentElement.style.getPropertyValue('--glass-tint')`
          )
        )
      await settings.webContents.executeJavaScript(`(() => {
        const slider = document.querySelector('[data-testid="tint-slider"]')
        if (!slider) return false
        slider.value = '80'
        slider.dispatchEvent(new Event('input', { bubbles: true }))
        slider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
        return true
      })()`)
      record(
        'appearance.tintPreview',
        await waitUntil('tint preview applied', async () => (await tintVar()) === '80', 3000),
        await tintVar()
      )
      record(
        'appearance.tintSaved',
        await waitUntil(
          'tint persisted',
          async () => {
            const pub = (await settings.webContents.executeJavaScript(`window.scout.settings.get()`)) as {
              glassTint?: number
            }
            return pub.glassTint === 80
          },
          4000
        )
      )
      await settings.webContents.executeJavaScript(`(() => {
        const slider = document.querySelector('[data-testid="tint-slider"]')
        slider.value = '50'
        slider.dispatchEvent(new Event('input', { bubbles: true }))
        slider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
        return true
      })()`)
      record(
        'appearance.tintRestored',
        await waitUntil('tint restored to default', async () => (await tintVar()) === '50', 3000),
        await tintVar()
      )

      // Close settings via the X — the frost must drop from memory.
      record('settings.closeClicked', (await settings.webContents.executeJavaScript(clickJs('[aria-label="Close settings"]'))) === true)
      record(
        'settings.windowHides',
        await waitUntil('settings hidden', async () => settingsWin()?.isVisible() === false, 3000)
      )
      record(
        'privacy.settingsBackdropDropped',
        await waitUntil('settings frost dropped', async () => !(await mounted(settings, '.glass-backdrop')), 2500)
      )

      // ---- 8b. Hosted free tier against the local mock relay -------------------
      if (hooks.relay) {
        hooks.openSettings()
        record(
          'hosted.settingsReopened',
          await waitUntil('settings visible for hosted', async () => settingsWin()?.isVisible() === true, 4000)
        )
        const hostedSettings = settingsWin()
        if (hostedSettings) {
          record('hosted.accessCardsShown', await mounted(hostedSettings, '.access-options'))
          record(
            'hosted.modeSwitchClicked',
            (await hostedSettings.webContents.executeJavaScript(findByTextJs('Free hosted mode'))) === true
          )
          record(
            'hosted.quotaMeterShown',
            await waitUntil('quota meter', async () => mounted(hostedSettings, '.quota-meter'), 5000)
          )
          let quotaText = ''
          const quotaNumbers = await waitUntil(
            'quota numbers',
            async () => {
              quotaText = String(
                await hostedSettings.webContents.executeJavaScript(
                  `document.querySelector('.quota-line')?.textContent ?? ''`
                )
              )
              return /27 of 30/.test(quotaText) && /7 of 10/.test(quotaText)
            },
            5000
          )
          record('hosted.quotaNumbers', quotaNumbers, quotaText)

          // ---- Updates: the mock relay advertises 9.9.9; check → download → verified.
          const updatesStatus = async (): Promise<string> =>
            String(
              await hostedSettings.webContents.executeJavaScript(
                `document.querySelector('[data-testid="updates-status"]')?.textContent ?? ''`
              )
            )
          record(
            'updates.checkClicked',
            (await hostedSettings.webContents.executeJavaScript(clickJs('[data-testid="updates-check"]'))) === true
          )
          record(
            'updates.available',
            await waitUntil('update available', async () => (await updatesStatus()).includes('9.9.9'), 6000),
            await updatesStatus()
          )
          record(
            'updates.downloadClicked',
            (await hostedSettings.webContents.executeJavaScript(clickJs('[data-testid="updates-download"]'))) === true
          )
          record(
            'updates.verified',
            await waitUntil('update verified', async () => (await updatesStatus()).includes('ready to install'), 8000),
            await updatesStatus()
          )

          // ---- Support: diagnostics copy reports success in the Settings UI.
          await hostedSettings.webContents.executeJavaScript(clickJs('[data-testid="diagnostics-copy"]'))
          record(
            'support.diagnosticsCopied',
            await waitUntil(
              'diagnostics copied note',
              async () =>
                (await hostedSettings.webContents.executeJavaScript(`document.body.innerText`)).includes(
                  'Diagnostics copied'
                ),
              5000
            )
          )

          record(
            'hosted.closeSettings',
            (await hostedSettings.webContents.executeJavaScript(clickJs('[aria-label="Close settings"]'))) === true
          )
          await waitUntil('settings hidden after hosted', async () => settingsWin()?.isVisible() === false, 3000)
        }

        // With no API key saved, a hosted question must still be answered.
        const transcript = async (): Promise<string> =>
          String(await assistant.webContents.executeJavaScript(`document.querySelector('.chat-scroll')?.innerText ?? ''`))
        await assistant.webContents.executeJavaScript(TYPE_JS('.composer-input', 'hosted answer?'))
        record('hosted.sendClicked', (await assistant.webContents.executeJavaScript(clickJs('.composer-send'))) === true)
        record(
          'hosted.answerArrives',
          await waitUntil('hosted answer', async () => (await transcript()).includes('The answer is 42.'), 8000),
          (await transcript()).slice(0, 300)
        )
        const relayChat = hooks.relay.state.lastChat
        record(
          'hosted.requestShape',
          relayChat?.model === 'scout-vision-1' && relayChat?.hasToken === true && relayChat?.hasImage === false,
          JSON.stringify(relayChat)
        )

        // Exhausted quota renders the friendly message, not a raw HTTP error.
        hooks.relay.setQuotaExceeded(true)
        await assistant.webContents.executeJavaScript(findByTextJs('Clear'))
        await assistant.webContents.executeJavaScript(TYPE_JS('.composer-input', 'one more?'))
        await assistant.webContents.executeJavaScript(clickJs('.composer-send'))
        record(
          'hosted.quotaErrorShown',
          await waitUntil('quota error', async () => (await transcript()).includes('free limit'), 6000),
          (await transcript()).slice(0, 300)
        )
        hooks.relay.setQuotaExceeded(false)

        // Back to BYOK so the remaining sections keep their original setup.
        await assistant.webContents.executeJavaScript(
          `(async () => { await window.scout.settings.save({ accessMode: 'byok' }); return true })()`
        )
        await assistant.webContents.executeJavaScript(findByTextJs('Clear'))
      }

      // ---- 9. Direct capture: shortcut → overlay → crop → popup -----------------
      hooks.toggleAssistant() // hide the popup first — the shortcut must work cold
      record(
        'directCapture.popupHidden',
        await waitUntil('assistant hidden', async () => !assistant.isVisible(), 3000)
      )
      hooks.startDirectCapture()
      const overlay4 = await waitOverlayMounted(6000)
      record('directCapture.overlayShown', overlay4 !== null)
      if (overlay4) {
        const drag = await Promise.race([
          overlay4.webContents.executeJavaScript(DRAG_JS([100, 100], [300, 260])),
          sleep(5000).then(() => 'DRAG_SCRIPT_TIMED_OUT')
        ])
        record('directCapture.dragDispatched', drag === 'dragged', String(drag))
        record(
          'directCapture.popupReshows',
          await waitUntil('assistant visible from direct capture', async () => assistant.isVisible(), 4000)
        )
        record(
          'directCapture.attachmentArrives',
          await waitUntil('attachment from direct capture', async () => mounted(assistant, '.attachment'), 4000)
        )
        const dims = await assistant.webContents.executeJavaScript(
          `document.querySelector('.attachment-dims')?.textContent ?? 'none'`
        )
        record('directCapture.dimsMatchDrag', /200\s*×\s*160/.test(String(dims)), String(dims))
      }

      // ---- 9b. Frost follows a move; the session must survive the refresh -------
      const backdropCountBefore = hooks.backdropRefreshCount()
      const before = assistant.getBounds()
      assistant.setBounds({ x: Math.max(0, before.x - 60), y: Math.max(0, before.y - 60), width: before.width, height: before.height })
      record(
        'backdrop.refreshedAfterMove',
        await waitUntil(
          'frost refresh counter advanced after move',
          async () => hooks.backdropRefreshCount() > backdropCountBefore,
          6000
        )
      )
      record('backdrop.sessionSurvivesMove', await mounted(assistant, '.attachment'))

      // ---- 9c. Default placement: bottom-right corner with an edge margin -------
      hooks.toggleAssistant() // hide, then show again → showAssistant places it
      await waitUntil('assistant hidden for placement', async () => !assistant.isVisible(), 3000)
      hooks.toggleAssistant()
      record(
        'placement.popupReshows',
        await waitUntil('assistant visible for placement', async () => assistant.isVisible(), 3000)
      )
      await sleep(400)
      const pb = assistant.getBounds()
      const cursor = screen.getCursorScreenPoint()
      const area = screen.getDisplayNearestPoint(cursor).workArea
      const wantRight = area.x + area.width - 16
      const wantBottom = area.y + area.height - 16
      record(
        'placement.bottomRightCorner',
        Math.abs(pb.x + pb.width - wantRight) <= 2 && Math.abs(pb.y + pb.height - wantBottom) <= 2,
        `right=${pb.x + pb.width} want=${wantRight} bottom=${pb.y + pb.height} want=${wantBottom}`
      )

      // ---- 10. Assistant layout at min size --------------------------------------
      const b = assistant.getBounds()
      assistant.setBounds({ x: b.x, y: b.y, width: 380, height: 460 })
      await sleep(350)
      const assistantOverflow = await assistant.webContents.executeJavaScript(
        `(() => { const d = document.documentElement; return { w: d.scrollWidth - d.clientWidth, h: d.scrollHeight - d.clientHeight } })()`
      )
      record('layout.assistantNoHorizontalOverflow', assistantOverflow.w <= 2, JSON.stringify(assistantOverflow))

      // ---- 11. Console cleanliness ------------------------------------------------
      record('console.noRendererErrors', consoleErrors.length === 0, consoleErrors.slice(0, 4).join(' | '))
      record('console.noFailedLoads', failedLoads.length === 0, failedLoads.slice(0, 3).join(' | '))

      const failed = checks.filter((c) => !c.ok).length
      finish(failed === 0 ? 0 : 1)
    } catch (error) {
      console.error(`E2E_CRASHED ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      finish(1)
    }
  })()
}
