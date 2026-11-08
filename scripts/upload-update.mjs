#!/usr/bin/env node
/**
 * Publishes a Screen Scout installer to the relay's update feed (R2).
 *
 * Usage (from the repo root, after `npm run dist`):
 *   node scripts/upload-update.mjs [--notes "Release notes"]
 *
 * Uploads:
 *   r2://screen-scout-updates/updates/Screen-Scout-<v>-setup.exe
 *   r2://screen-scout-updates/updates/latest.json
 *
 * latest.json is what installed apps poll; the exe is what they download.
 * Requires `npx wrangler login` (or CLOUDFLARE_API_TOKEN) with R2 write access.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const BUCKET = 'screen-scout-updates'

const notesArg = process.argv.indexOf('--notes')
const notes = notesArg !== -1 ? process.argv[notesArg + 1] : ''

const exeName = `Screen-Scout-${version}-setup.exe`
const exePath = join(root, 'dist', exeName)
if (!existsSync(exePath)) {
  console.error(`Missing ${exePath}. Run "npm run dist" first.`)
  process.exit(1)
}

const installer = readFileSync(exePath)
const sha256 = createHash('sha256').update(installer).digest('hex')
const manifest = {
  version,
  url: `/updates/${exeName}`,
  sha256,
  sizeBytes: installer.length,
  notes,
  pubDate: new Date().toISOString()
}

function wrangler(args) {
  console.log(`> npx wrangler ${args.join(' ')}`)
  execFileSync('npx', ['wrangler', ...args], { cwd: join(root, 'relay'), stdio: 'inherit', shell: process.platform === 'win32' })
}

const tmp = mkdtempSync(join(tmpdir(), 'scout-update-'))
const manifestPath = join(tmp, 'latest.json')
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

try {
  wrangler(['r2', 'object', 'put', `${BUCKET}/updates/${exeName}`, '--file', exePath, '--content-type', 'application/octet-stream'])
  wrangler(['r2', 'object', 'put', `${BUCKET}/updates/latest.json`, '--file', manifestPath, '--content-type', 'application/json'])
  console.log(`\nPublished ${version}:`)
  console.log(`  sha256  ${sha256}`)
  console.log(`  size    ${(installer.length / 1024 / 1024).toFixed(1)} MB`)
  console.log(`  feed    /updates/latest.json`)
} finally {
  try {
    unlinkSync(manifestPath)
  } catch {
    // best effort
  }
}
