#!/usr/bin/env node
/**
 * Bakes the deployed relay URL into the desktop app.
 *
 *   node scripts/set-relay-url.mjs https://screen-scout-relay.you.workers.dev
 *   node scripts/set-relay-url.mjs --clear     # disable hosted mode
 *
 * The URL only enables the UI; the relay itself enforces every limit. An empty
 * value keeps the app in Bring-Your-Own-Key mode and hides the hosted option.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const file = resolve(root, 'src/shared/hosted.ts')

const raw = (process.argv[2] ?? '').trim()
const clearing = raw === '--clear' || raw === ''

if (raw !== '--clear' && raw !== '' && !/^https?:\/\/[^\s'"]+$/.test(raw)) {
  console.error('Usage: node scripts/set-relay-url.mjs <https://your-worker.workers.dev>')
  console.error('       node scripts/set-relay-url.mjs --clear')
  process.exit(1)
}

const url = clearing ? '' : raw.replace(/\/+$/, '')
const source = readFileSync(file, 'utf8')
const pattern = /export const HOSTED_RELAY_URL = '[^']*'/
if (!pattern.test(source)) {
  console.error(`Could not find HOSTED_RELAY_URL in ${file}`)
  process.exit(1)
}

writeFileSync(file, source.replace(pattern, `export const HOSTED_RELAY_URL = '${url}'`))

if (url) {
  console.log(`Hosted relay URL set to ${url}`)
  console.log('Next: npm run build  (or npm run dist for the installer)')
} else {
  console.log('Hosted relay URL cleared — the app stays in BYOK mode.')
}
