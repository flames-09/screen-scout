// Verifies the packaged asar contains everything the app needs at runtime.
const asar = require('@electron/asar')
const list = asar.listPackage('dist/win-unpacked/resources/app.asar')
const norm = list.map((p) => p.replace(/\\/g, '/').replace(/^\//, ''))
const need = [
  'assets/tray.png',
  'assets/icon.png',
  'out/main/index.js',
  'out/preload/index.js',
  'out/renderer/index.html',
  'out/renderer/overlay.html',
  'out/renderer/settings.html',
  'package.json'
]
let ok = true
for (const w of need) {
  const found = norm.includes(w)
  ok = ok && found
  console.log(found ? 'OK  ' : 'MISS', w)
}
// Everything is bundled by electron-vite (all packages live in devDependencies),
// so the asar should ship NO node_modules at all.
const nodeModules = norm.filter((p) => p.startsWith('node_modules/')).length
if (nodeModules > 0) {
  ok = false
  console.log('UNEXPECTED node_modules entries:', nodeModules)
  console.log('  first few:', norm.filter((p) => p.startsWith('node_modules/')).slice(0, 10))
} else {
  console.log('node_modules: none (fully bundled) OK')
}
console.log(ok ? 'ASAR COMPLETE' : 'ASAR INCOMPLETE')
process.exit(ok ? 0 : 1)
