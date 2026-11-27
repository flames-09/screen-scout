#!/usr/bin/env node
/**
 * Publishes a Screen Scout release to the relay's update feed (D1).
 *
 * The installer bytes live on GitHub Releases (free, no payment method —
 * R2 requires a card even on its free tier). This script optionally uploads
 * local build artifacts as release assets (--upload) and writes the small
 * manifest rows the relay serves at /updates/latest.json:
 *
 *   D1 table `update_manifest` — one row per platform
 *   ('win' | 'mac-arm64' | 'mac-x64').
 *
 * Usage (from the repo root):
 *
 *   # Windows only (legacy default: dist/Screen-Scout-<v>-setup.exe):
 *   node scripts/upload-update.mjs [--url <download-url>] [--notes "..."]
 *
 *   # All platforms (with upload of the files to the release):
 *   node scripts/upload-update.mjs \
 *     --platform win --file dist/Screen-Scout-0.1.2-setup.exe \
 *     --platform mac-arm64 --file dist/Screen-Scout-0.1.2-mac-arm64.dmg \
 *     --platform mac-x64 --file dist/Screen-Scout-0.1.2-mac-x64.dmg \
 *     --upload [--notes "..."]
 *
 * `--upload` attaches each --file to the v<version> GitHub release first
 * (needs GH_TOKEN with repo scope) — CI produces artifacts, not release
 * assets, so this replaces dragging big DMGs by hand. Every platform URL is
 * HEAD-checked (size must match the local file) before publishing, so a
 * mistyped link cannot brick the feed. Requires `npx wrangler login` (or
 * CLOUDFLARE_API_TOKEN) with D1 access.
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
const DB_NAME = 'screen-scout-relay'
const REPO = 'flames-09/screen-scout'

const PLATFORMS = ['win', 'mac-arm64', 'mac-x64']
/** Dist filename per platform (electron-builder artifactName conventions). */
const defaultFileName = (platform) =>
  platform === 'win'
    ? `Screen-Scout-${version}-setup.exe`
    : `Screen-Scout-${version}-mac-${platform.replace('mac-', '')}.dmg`

// ---- Argument parsing -------------------------------------------------------
const argv = process.argv
const argValue = (flag) => {
  const idx = argv.indexOf(flag)
  return idx !== -1 ? argv[idx + 1] : undefined
}
const upload = argv.includes('--upload')
const notesArg = argv.indexOf('--notes')
const urlArg = argv.indexOf('--url')

// The app validates the manifest with `notes` max 2000 — an over-long note
// would make EVERY client reject the feed, so truncate rather than publish.
const MAX_NOTES_CHARS = 2000
const rawNotesValue = notesArg !== -1 ? argv[notesArg + 1] : ''
const rawNotes = typeof rawNotesValue === 'string' ? rawNotesValue : ''
const notes = rawNotes.length > MAX_NOTES_CHARS ? `${rawNotes.slice(0, MAX_NOTES_CHARS - 1)}…` : rawNotes
if (notes !== rawNotes) {
  console.warn(`--notes truncated to ${MAX_NOTES_CHARS} characters (app schema limit).`)
}

/** [{ platform, filePath }] — strict pairs: --file must directly follow its --platform. */
const entries = []
for (let i = 2; i < argv.length; i++) {
  const token = argv[i]
  if (token === '--platform') {
    const platform = argv[i + 1]
    if (!PLATFORMS.includes(platform)) {
      console.error(`Unknown platform "${platform}". Expected one of: ${PLATFORMS.join(', ')}.`)
      process.exit(1)
    }
    let filePath
    if (argv[i + 2] === '--file') {
      filePath = argv[i + 3]
      if (typeof filePath !== 'string' || filePath === '') {
        console.error('--file needs a path.')
        process.exit(1)
      }
      i += 2 // consume --file + path
    } else {
      filePath = join(root, 'dist', defaultFileName(platform))
    }
    entries.push({ platform, filePath: resolve(root, filePath) })
    i++ // consume the platform value
  } else if (token === '--file') {
    console.error('--file must directly follow its --platform <p>.')
    process.exit(1)
  }
}
if (entries.length === 0) {
  // Legacy single-platform default: the Windows installer.
  const exeName = `Screen-Scout-${version}-setup.exe`
  const overrideUrl = urlArg !== -1 ? argv[urlArg + 1] : undefined
  entries.push({
    platform: 'win',
    filePath: join(root, 'dist', exeName),
    ...(overrideUrl ? { urlOverride: overrideUrl } : {})
  })
}
{
  const seen = new Set()
  for (const entry of entries) {
    if (seen.has(entry.platform)) {
      console.error(`Platform "${entry.platform}" listed more than once.`)
      process.exit(1)
    }
    seen.add(entry.platform)
  }
}

const sleep = (ms) => new Promise((resolveTimeout) => setTimeout(resolveTimeout, ms))

function sha256Of(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

// ---- Optional: attach the files to the GitHub release -----------------------
function githubHeaders(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra
  }
}

async function uploadToRelease(token, filePath, assetName) {
  const buf = readFileSync(filePath)
  const relRes = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/v${version}`, {
    headers: githubHeaders(token)
  })
  if (!relRes.ok) {
    console.error(`Release v${version} not found (HTTP ${relRes.status}). Create it first.`)
    process.exit(1)
  }
  const release = (await relRes.json())
  const uploadRes = await fetch(
    `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`,
    {
      method: 'POST',
      headers: githubHeaders(token, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(buf.length)
      }),
      body: buf
    }
  )
  if (!uploadRes.ok) {
    console.error(`Asset upload failed (HTTP ${uploadRes.status}): ${(await uploadRes.text()).slice(0, 400)}`)
    process.exit(1)
  }
  console.log(`  uploaded ${assetName} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`)
}

// ---- Build + verify each platform entry -------------------------------------
const GH_TOKEN = process.env.GH_TOKEN
if (upload && !GH_TOKEN) {
  console.error('--upload requires GH_TOKEN (a PAT with repo contents access).')
  process.exit(1)
}

const rows = []
for (const entry of entries) {
  const { platform, filePath } = entry
  if (!existsSync(filePath)) {
    console.error(`Missing ${filePath}. Build it first (npm run dist / CI mac artifact).`)
    process.exit(1)
  }
  const fileName = filePath.split(/[\\/]/).pop()
  const downloadUrl =
    entry.urlOverride ??
    `https://github.com/${REPO}/releases/download/v${version}/${encodeURIComponent(fileName)}`

  if (upload) {
    await uploadToRelease(GH_TOKEN, filePath, fileName)
  }

  // Verify the hosted asset before pointing clients at it. Freshly uploaded
  // assets can take a few seconds to propagate, hence the retries.
  let head = null
  for (let attempt = 1; attempt <= (upload ? 6 : 1); attempt++) {
    head = await fetch(downloadUrl, { method: 'HEAD', redirect: 'follow' })
    if (head.ok) break
    if (attempt < (upload ? 6 : 1)) await sleep(5000)
  }
  if (!head || !head.ok) {
    console.error(`Download URL did not check out (HTTP ${head ? head.status : '?'}): ${downloadUrl}`)
    console.error('Attach the asset to the GitHub release first (or pass --upload).')
    process.exit(1)
  }
  const localSize = readFileSync(filePath).length
  const remoteLength = Number(head.headers.get('content-length') ?? 0)
  if (remoteLength && remoteLength !== localSize) {
    console.error(
      `Remote asset is ${remoteLength} bytes but the local file is ${localSize} — ` +
        'the release asset does not match this build. Re-upload it first.'
    )
    process.exit(1)
  }

  rows.push({ platform, version, url: downloadUrl, sha256: sha256Of(filePath), size: localSize })
}

// ---- Write the manifest rows (one per platform, conflict-safe) --------------
function wrangler(args) {
  // Run the local wrangler binary directly via node (no shell): a shell wrapper
  // can swallow wrangler's non-zero exit code, which once made a failed R2
  // upload print a success message. node propagates the real exit code.
  const wranglerBin = join(root, 'relay', 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  console.log(`> wrangler ${args.join(' ')}`)
  execFileSync(process.execPath, [wranglerBin, ...args], { cwd: join(root, 'relay'), stdio: 'inherit' })
}

const sql = (value) => `'${String(value).replace(/'/g, "''")}'`
const tmp = mkdtempSync(join(tmpdir(), 'scout-update-'))
const manifestPath = join(tmp, 'manifest.sql')
writeFileSync(
  manifestPath,
  [
    '-- generated by scripts/upload-update.mjs',
    ...rows.map(
      (row) => [
        'INSERT INTO update_manifest (platform, version, url, sha256, size_bytes, notes, pub_date)',
        `VALUES (${sql(row.platform)}, ${sql(row.version)}, ${sql(row.url)}, ${sql(row.sha256)}, ${row.size}, ${sql(notes)}, ${sql(new Date().toISOString())})`,
        'ON CONFLICT(platform) DO UPDATE SET',
        '  version = excluded.version,',
        '  url = excluded.url,',
        '  sha256 = excluded.sha256,',
        '  size_bytes = excluded.size_bytes,',
        '  notes = excluded.notes,',
        '  pub_date = excluded.pub_date;'
      ].join('\n')
    ),
    ''
  ].join('\n')
)

try {
  wrangler(['d1', 'execute', DB_NAME, '--remote', '-y', '--file', manifestPath])
  console.log(`\nPublished ${version}:`)
  for (const row of rows) {
    console.log(`  ${row.platform.padEnd(10)} ${row.url}`)
    console.log(`  ${' '.repeat(10)} sha256 ${row.sha256}`)
    console.log(`  ${' '.repeat(10)} size   ${(row.size / 1024 / 1024).toFixed(1)} MB`)
  }
  console.log(`  feed     /updates/latest.json (served from D1)`)

  // ---- Post-publish verification: read the LIVE feed back --------------------
  // A feed that disagrees with what was just written (wrong D1 database,
  // partially applied SQL, an edge cache serving stale rows) silently bricks
  // updates for every client, so verify and fail loudly instead.
  const hostedSrc = readFileSync(join(root, 'src', 'shared', 'hosted.ts'), 'utf8')
  const relayMatch = hostedSrc.match(/HOSTED_RELAY_URL = '([^']+)'/)
  if (!relayMatch) throw new Error('Could not read HOSTED_RELAY_URL from src/shared/hosted.ts.')
  const feedUrl = `${relayMatch[1]}/updates/latest.json`
  let feed = null
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(feedUrl, { headers: { 'cache-control': 'no-cache' } })
    if (res.ok) {
      feed = await res.json()
      break
    }
    if (attempt < 4) await sleep(2000)
  }
  if (!feed || typeof feed !== 'object') {
    throw new Error(`Feed verification failed: ${feedUrl} did not return 200 after publishing.`)
  }
  const problems = []
  // The top-level manifest IS the win row (relay builds it that way), so the
  // two must agree; a divergence means a mangled feed.
  if (feed.platforms?.win?.version !== undefined && feed.version !== feed.platforms.win.version) {
    problems.push(`top-level version (${feed.version}) != platforms.win.version (${feed.platforms.win.version})`)
  }
  for (const row of rows) {
    const remote = feed.platforms?.[row.platform]
    if (remote?.version !== version) {
      problems.push(`${row.platform}: feed version is ${remote?.version ?? 'missing'}, expected ${version}`)
    } else if (remote.url !== row.url || remote.sha256 !== row.sha256 || remote.sizeBytes !== row.size) {
      // sizeBytes matters as much as the hash: the client caps the download
      // from it, so a corrupted size makes every client abort the update.
      problems.push(`${row.platform}: feed url/sha256/sizeBytes do not match what was just published`)
    }
  }
  if (problems.length > 0) {
    console.error(`\nLive feed at ${feedUrl} does not match the published manifest:`)
    for (const problem of problems) console.error(`  - ${problem}`)
    throw new Error('Feed verification failed — the update feed is NOT serving this release.')
  }
  console.log(`  verified  live feed serves ${version} for ${rows.map((r) => r.platform).join(', ')}`)
} finally {
  try {
    unlinkSync(manifestPath)
  } catch {
    // best effort
  }
}
