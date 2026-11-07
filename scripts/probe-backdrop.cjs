// Isolated test: does the white backdrop window itself appear on screen?
const { app, BrowserWindow, desktopCapturer, screen } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay()
  const area = display.workArea
  const backdrop = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    frame: false,
    backgroundColor: '#ffffff',
    show: false
  })
  await backdrop.loadURL('data:text/html,<body style="margin:0;background:#fff"></body>')
  backdrop.show()
  backdrop.setAlwaysOnTop(true, 'normal')
  await sleep(800)
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: display.size.width, height: display.size.height }
  })
  const full = sources[0].thumbnail
  fs.writeFileSync(path.join(__dirname, '..', '.design', 'probe-backdrop-only.png'), full.toPNG())
  const center = full.crop({
    x: Math.round(area.width / 2) - 50,
    y: Math.round(area.height / 2) - 50,
    width: 100,
    height: 100
  })
  console.log('BACKDROP_CENTER_R' + JSON.stringify(center.toBitmap().slice(0, 6)))
  console.log('BACKDROP_TEST_DONE')
  app.exit(0)
})

setTimeout(() => {
  console.error('BACKDROP_TIMEOUT')
  app.exit(1)
}, 20000)
