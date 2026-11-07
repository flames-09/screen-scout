// Renders the real built UI in Electron windows with stub IPC and captures
// screenshots to .design/ for visual QA. Run after `npm run build`:
//   npx electron scripts/design-shot.cjs
//
// The chat harness drives the REAL renderer reducer by emitting ChatEvent
// payloads over the same channels the main process uses.
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const OUT_DIR = path.join(__dirname, '..', '.design')
const PRELOAD = path.join(__dirname, '..', 'out', 'preload', 'index.js')
const PAGES = path.join(__dirname, '..', 'out', 'renderer')

// 1x1 green PNG
const FAKE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

let noticeAcknowledged = false
const fakeSettings = () => ({
  model: 'meta/llama-3.2-90b-vision-instruct',
  baseUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
  shortcut: 'Shift+R',
  requestTimeoutSec: 60,
  launchOnStartup: false,
  noticeAcknowledged,
  maxImageBytes: 5 * 1024 * 1024,
  hasApiKey: true,
  keyStorageSecure: true,
  shortcutStatus: 'registered'
})

ipcMain.handle('settings:get', () => fakeSettings())
ipcMain.handle('settings:save', () => fakeSettings())
ipcMain.handle('key:save', () => ({ ok: true, secure: true }))
ipcMain.handle('key:remove', () => ({ ok: true }))
ipcMain.handle('connection:test', async () => ({
  ok: true,
  message: 'Connected. meta/llama-3.2-90b-vision-instruct accepted an image and replied.',
  detail: 'OK'
}))
ipcMain.handle('window:hide', () => ({ ok: true }))
ipcMain.handle('window:resizeBy', () => ({ ok: true }))
ipcMain.handle('settings:open', () => ({ ok: true }))
ipcMain.handle('chat:cancel', () => ({ ok: true }))

// --- chat: an accept + streamed events, erroring when an image is attached ---
const ANSWER =
  'The screenshot shows a rate-limit response. Key points:\n\n' +
  '- The API accepted the image (5.2 MB PNG)\n' +
  '- Streaming began within `240 ms`, then the connection reset\n\n' +
  '```js\nconst res = await fetch(url, { method: "POST" })\n```\n\n' +
  'See the [NVIDIA status page](https://status.nvidia.com) for live incidents.'

ipcMain.handle('chat:send', (event, input) => {
  const sender = event.sender
  const requestId = input.requestId // echo the renderer's id — the reducer matches on it
  const emit = (payload) => sender.send('chat:event', payload)

  if (input.imageDataUrl) {
    setTimeout(() => emit({ type: 'delta', requestId, text: 'Uploading…' }), 250)
    setTimeout(
      () =>
        emit({
          type: 'error',
          requestId,
          error: {
            code: 'network',
            message: "Couldn't reach the NVIDIA API.",
            detail: 'net::ERR_CONNECTION_RESET after 4096 bytes',
            retryable: true
          }
        }),
      900
    )
  } else {
    const third = Math.ceil(ANSWER.length / 3)
    setTimeout(() => emit({ type: 'delta', requestId, text: ANSWER.slice(0, third) }), 400)
    setTimeout(() => emit({ type: 'delta', requestId, text: ANSWER.slice(third, third * 2) }), 700)
    setTimeout(() => emit({ type: 'complete', requestId, text: ANSWER }), 1000)
  }
  return { status: 'accepted' }
})

// selection: instantly "capture" a fake region (scaled up so the
// preview thumbnails are visible in screenshots)
const { nativeImage } = require('electron')
const capturedImage = nativeImage
  .createFromDataURL(FAKE_PNG)
  .resize({ width: 160, height: 100 })

ipcMain.handle('selection:start', () => ({
  status: 'captured',
  dataUrl: capturedImage.toDataURL(),
  width: 640,
  height: 400,
  bytes: 12345,
  mime: 'image/png'
}))

// Frosted-glass backdrop: emulate the main process by sending a fake
// "desktop behind the window" image right after the page loads.
function sendFakeBackdrop(win) {
  // A bright, high-contrast stand-in: after blur + dim it must read as
  // unmistakable soft glows through the slab.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="560">
    <rect width="440" height="560" fill="#f5f2ea"/>
    <circle cx="70" cy="90" r="70" fill="#ffcf5a"/>
    <circle cx="400" cy="180" r="55" fill="#ff8a5a"/>
    <rect x="220" y="330" width="190" height="120" rx="14" fill="#5ab4ff"/>
    <rect x="30" y="430" width="150" height="90" rx="14" fill="#7fe89a"/>
  </svg>`
  const dataUrl =
    'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  win.webContents.send('window:backdrop', { dataUrl })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function shot(win, name) {
  const image = await win.webContents.capturePage()
  fs.writeFileSync(path.join(OUT_DIR, name), image.toPNG())
  console.log(`captured .design/${name}`)
}

// Type into the real composer and press the real send button.
async function typeAndSend(win, text) {
  await win.webContents.executeJavaScript(`
    (() => {
      const ta = document.querySelector('.composer-input')
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, ${JSON.stringify(text)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('.composer-send').click()
    })()
  `)
}

async function windowWith(page, size) {
  const win = new BrowserWindow({
    ...size,
    frame: false,
    show: true,
    backgroundColor: '#0e0e10',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  await win.loadFile(path.join(PAGES, page))
  if (page !== 'overlay.html') {
    // Match the real flow: the main process capture lands ~150ms after show,
    // by which time the renderer has mounted and subscribed.
    setTimeout(() => sendFakeBackdrop(win), 300)
  }
  await sleep(900) // fonts + animations settle
  const probe = await win.webContents.executeJavaScript(
    (() => {
      return `
    (() => {
      const el = document.querySelector('.glass-backdrop')
      if (!el) return 'NO BACKDROP ELEMENT'
      const cs = getComputedStyle(el)
      return JSON.stringify({
        bg: cs.backgroundImage.slice(0, 60),
        filter: cs.filter,
        z: cs.zIndex,
        opacity: cs.opacity
      })
    })()
  `
    })()
  )
  console.log('BACKDROP_PROBE ' + probe)
  return win
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const created = []
  try {
    // 1) First run: privacy notice instead of the empty state.
    noticeAcknowledged = false
    const firstRun = await windowWith('index.html', { width: 440, height: 560 })
    created.push(firstRun)
    await shot(firstRun, 'first-run.png')
    firstRun.hide()

    // 2) A live conversation: answer, then attachment + error + retry buttons.
    noticeAcknowledged = true
    const convo = await windowWith('index.html', { width: 440, height: 640 })
    created.push(convo)
    await typeAndSend(convo, 'What does this error mean?')
    await sleep(600) // user bubble + thinking dots
    await shot(convo, 'thinking.png')
    await sleep(900) // full markdown answer
    await convo.webContents.executeJavaScript(
      `document.querySelector('.composer-select')?.click()`
    )
    await sleep(500) // attachment strip (+ quick prompts)
    await typeAndSend(convo, 'Explain the highlighted part')
    await sleep(1300) // error bubble lands
    const probe = await convo.webContents.executeJavaScript(
      (() => {
        return `
    (() => {
      const btn = document.querySelector('.composer-send')
      const ta = document.querySelector('.composer-input')
      return JSON.stringify({
        disabled: btn ? btn.disabled : null,
        bg: btn ? getComputedStyle(btn).backgroundImage.slice(0, 50) : null,
        bgc: btn ? getComputedStyle(btn).backgroundColor : null,
        cls: btn ? btn.className : null,
        draft: ta ? ta.value : null
      })
    })()
  `
      })()
    )
    console.log('PROBE ' + probe)
    await shot(convo, 'conversation.png')

    // 3) Settings + overlay.
    const settings = await windowWith('settings.html', { width: 540, height: 720 })
    created.push(settings)
    await shot(settings, 'settings.png')
    settings.hide()

    const overlay = await windowWith('overlay.html', { width: 720, height: 460 })
    created.push(overlay)
    await shot(overlay, 'overlay.png')

    console.log('DESIGN_SHOTS_DONE')
  } catch (error) {
    console.error('DESIGN_SHOT_FAILED', error)
  } finally {
    for (const win of created) {
      try {
        win.destroy()
      } catch {}
    }
    app.exit(0)
  }
}).catch((error) => {
  console.error('DESIGN_SHOT_READY_FAILED', error)
  app.exit(1)
})

// Never hang: bound the whole run.
setTimeout(() => {
  console.error('DESIGN_SHOT_TIMEOUT')
  app.exit(1)
}, 45000)
