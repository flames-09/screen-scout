// Shows REAL windows (two acrylic recipes) on the real desktop and captures
// the actual screen compositing — corners, acrylic blur, shadow — which
// capturePage cannot see. Verification only:
//   npx electron scripts/probe-glass.cjs
const { app, BrowserWindow, desktopCapturer, screen } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const OUT = path.join(__dirname, '..', '.design')
const PRELOAD = path.join(__dirname, '..', 'out', 'preload', 'index.js')
const PAGE = path.join(__dirname, '..', 'out', 'renderer', 'index.html')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Strip the CSS tint so only the OS material layer is judged.
const STRIP_TINT = `
  const style = document.createElement('style')
  style.textContent = '.glass-root { background: rgba(10,10,12,0.25) !important; backdrop-filter: none !important; }'
  document.head.appendChild(style)
`

// Hide the page entirely: only the window's own OS surface remains.
const HIDE_PAGE = `
  const style = document.createElement('style')
  style.textContent = '.glass-root { display: none !important; }'
  document.head.appendChild(style)
`

function makeWindow(variant, x, y) {
  const base = {
    width: 440,
    height: 560,
    frame: false,
    hasShadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    show: false,
    useContentSize: true,
    x,
    y,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  }
  // A: transparent + acrylic (current recipe — already shown to fail)
  if (variant === 'transparent') {
    return new BrowserWindow({
      ...base,
      transparent: true,
      backgroundColor: '#00000000',
      backgroundMaterial: 'acrylic'
    })
  }
  // A1: opaque + alpha backgroundColor + acrylic
  if (variant === 'opaque-alpha') {
    return new BrowserWindow({
      ...base,
      transparent: false,
      backgroundColor: '#00000000',
      backgroundMaterial: 'acrylic'
    })
  }
  // A2: opaque + no backgroundColor + acrylic
  return new BrowserWindow({
    ...base,
    transparent: false,
    backgroundMaterial: 'acrylic'
  })
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const created = []
  try {
    const display = screen.getPrimaryDisplay()
    const area = display.workArea
    // High-contrast backdrop: real acrylic will glow white through the slab,
    // opaque paint will stay dark. This makes the blur unambiguous.
    const backdrop = new BrowserWindow({
      x: area.x,
      y: area.y,
      width: area.width,
      height: area.height,
      frame: false,
      backgroundColor: '#ffffff',
      alwaysOnTop: false,
      show: false,
      webPreferences: { offscreen: false }
    })
    await backdrop.loadURL(
      'data:text/html,<body style="margin:0;background:#fff"></body>'
    )
    backdrop.show()
    // 'floating' is topmost on Windows (level 'normal' is not); the probe
    // windows use the same level but are shown later, so they stack above.
    backdrop.setAlwaysOnTop(true, 'floating')
    await sleep(400)

    const variants = [
      ['transparent', area.x + 40, area.y + 40],
      ['opaque-alpha', area.x + area.width - 480, area.y + 40],
      ['opaque-plain', area.x + 40, area.y + 120]
    ]
    const shots = []
    for (const [variant, x, y] of variants) {
      const win = makeWindow(variant, x, y)
      created.push(win)
      await win.loadFile(PAGE)
      await win.webContents.executeJavaScript(STRIP_TINT)
      win.show()
      await sleep(1400) // acrylic settle
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: display.size.width, height: display.size.height }
      })
      const full = sources[0].thumbnail
      const crop = full.crop({
        x: Math.max(0, x - 30),
        y: Math.max(0, y - 30),
        width: 500,
        height: 620
      })
      const file = path.join(OUT, `probe-${variant}.png`)
      fs.writeFileSync(file, crop.toPNG())
      shots.push(`probe-${variant}.png`)
      win.hide()
    }

    // Bare-surface test: page hidden entirely, one transparent + one opaque
    // window — whatever appears is the OS material, no page paint at all.
    for (const [variant, x, y] of [
      ['bare-transparent', area.x + 40, area.y + 40],
      ['bare-opaque', area.x + area.width - 480, area.y + 120]
    ]) {
      const win = makeWindow(variant.startsWith('bare-opaque') ? 'opaque-plain' : 'transparent', x, y)
      created.push(win)
      await win.loadFile(PAGE)
      await win.webContents.executeJavaScript(HIDE_PAGE)
      win.show()
      await sleep(1400)
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: display.size.width, height: display.size.height }
      })
      const full = sources[0].thumbnail
      const crop = full.crop({
        x: Math.max(0, x - 30),
        y: Math.max(0, y - 30),
        width: 500,
        height: 620
      })
      const file = path.join(OUT, `probe-${variant}.png`)
      fs.writeFileSync(file, crop.toPNG())
      shots.push(`probe-${variant}.png`)
      win.hide()
    }
    for (const s of shots) console.log('captured .design/' + s)
    console.log('PROBE_DONE')
  } catch (error) {
    console.error('PROBE_FAILED', error)
  } finally {
    for (const w of created) {
      try {
        w.destroy()
      } catch {}
    }
    app.exit(0)
  }
}).catch((e) => {
  console.error('PROBE_READY_FAILED', e)
  app.exit(1)
})

setTimeout(() => {
  console.error('PROBE_TIMEOUT')
  app.exit(1)
}, 45000)
