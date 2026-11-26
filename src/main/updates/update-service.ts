import { createHash } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { updateManifestSchema, type UpdateManifest, type UpdatePlatformManifest } from '@shared/schemas'
import type { UpdatePhase } from '@shared/types'

export type { UpdatePhase } from '@shared/types'

/**
 * Update service for the packaged Windows and macOS (beta) apps.
 *
 * Checks the relay's update feed (`/updates/latest.json`), downloads the
 * platform installer to disk, verifies its SHA-256 against the manifest,
 * and finishes the update. Deliberately NOT electron-updater: the app ships
 * with no node_modules (everything is bundled by electron-vite), so the
 * updater is a small, dependency-free module here instead.
 *
 * Platform finishing moves (handled by the caller in main/index.ts):
 * - Windows: launch the verified NSIS installer with `/S` (silent).
 * - macOS: the verified DMG sits in ~/Downloads — unsigned apps cannot be
 *   replaced in place, so the user gets a Finder hand-off with instructions.
 *
 * Integrity model: HTTPS to the relay + the manifest's sha256 over the exact
 * installer bytes. The app is unsigned, so this is the strongest available
 * channel binding; code signing will supersede it later.
 *
 * Electron-free and side-effect-injected so it can be unit-tested exhaustively.
 */

export type FetchLike = (input: string, init: { signal: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  headers?: { get(name: string): string | null }
  body?: AsyncIterable<Uint8Array> | { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null
  text?: () => Promise<string>
}>

/** Minimal fs surface for streaming the installer to disk (faked in tests). */
export interface UpdateFs {
  createWriteStream(path: string): {
    write(chunk: Uint8Array): unknown
    end(): unknown
    once(event: 'error' | 'finish', cb: () => void): unknown
    destroy(): unknown
  }
  unlink(path: string): void
  /** Optional existence probe (real fs provides existsSync-compatible). */
  exists?(path: string): boolean
}

export interface SpawnLike {
  (file: string, args: string[]): { unref(): void } & Partial<ChildProcess>
}

export interface UpdateDeps {
  fetch: FetchLike
  /** Resolved update-feed root (relay URL); '' disables the feature. */
  baseUrl(): string
  currentVersion(): string
  tempDir(): string
  /** Where finished mac DMGs are parked (~/Downloads on darwin). */
  downloadsDir?(): string
  /** Override for tests; defaults to the real platform key. */
  platformKey?(): string
  joinPath(...parts: string[]): string
  fs: UpdateFs
  spawn: SpawnLike
  onState(phase: UpdatePhase): void
}

/** Hard cap on downloaded installers, manifest size or not. */
const MAX_DOWNLOAD_BYTES = 600 * 1024 * 1024
/** A fully stalled download (no bytes for this long) is treated as failed. */
const DOWNLOAD_STALL_MS = 60_000
/** Manifest checks must never hang the UI. */
const CHECK_TIMEOUT_MS = 15_000

/** Numeric semver-ish comparison; prerelease suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const num = (v: string): number[] =>
    v
      .replace(/^v/i, '')
      .split(/[-+]/)[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0)
  const pa = num(a)
  const pb = num(b)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1
  }
  return 0
}

/** True when the manifest describes a version newer than the running app. */
export function needsUpdate(manifestVersion: string, currentVersion: string): boolean {
  return compareVersions(manifestVersion, currentVersion) > 0
}

/** Absolute URL for a manifest entry (relative URLs resolve against the feed). */
export function resolveInstallerUrl(baseUrl: string, url: string): string {
  if (/^https?:\/\//i.test(url)) return url
  return `${baseUrl.replace(/\/$/, '')}${url.startsWith('/') ? '' : '/'}${url}`
}

/** Which manifest platform entry serves this build ('win' | 'mac-arm64' | 'mac-x64'). */
export function platformKey(platform: string = process.platform, arch: string = process.arch): string {
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  return 'win'
}

/**
 * Picks the manifest entry for this build: the platforms map wins; the
 * top-level fields are the legacy Windows-only feed. Returns null when the
 * feed publishes no build for this platform (mac before its first release).
 */
export function selectPlatformManifest(
  manifest: UpdateManifest,
  key: string
): UpdatePlatformManifest | null {
  const entry = manifest.platforms?.[key]
  if (entry) return entry
  if (key === 'win') return manifest
  return null
}

export class UpdateService {
  private phase: UpdatePhase = { kind: 'idle' }
  private busy = false

  constructor(private readonly deps: UpdateDeps) {}

  currentPhase(): UpdatePhase {
    return this.phase
  }

  private set(phase: UpdatePhase): void {
    this.phase = phase
    this.deps.onState(phase)
  }

  private fail(message: string): UpdatePhase {
    this.set({ kind: 'error', message })
    return this.phase
  }

  private key(): string {
    return this.deps.platformKey?.() ?? platformKey()
  }

  /** Fetches and validates the manifest; resolves to 'current' or 'available'. */
  async check(): Promise<UpdatePhase> {
    const base = this.deps.baseUrl().trim()
    if (!base) {
      return this.fail('Updates are not configured in this build.')
    }
    if (this.busy) return this.phase
    // A downloaded-but-not-yet-installed update must not be clobbered by a
    // re-check (manual or the 6-hour auto-check): it would orphan the
    // verified installer and force a full re-download.
    if (this.phase.kind === 'verified' || this.phase.kind === 'installing') return this.phase
    this.busy = true
    this.set({ kind: 'checking' })
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
      // The deadline covers the manifest BODY read too: headers alone arriving
      // must not leave the service wedged in 'busy' forever.
      let text: string
      try {
        const response = await this.deps.fetch(`${base.replace(/\/$/, '')}/updates/latest.json`, {
          signal: controller.signal
        })
        if (!response.ok) {
          return this.fail(`Update feed returned HTTP ${response.status}.`)
        }
        text = await readBodyText(response)
      } finally {
        clearTimeout(timer)
      }
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch {
        return this.fail('Update feed returned invalid JSON.')
      }
      const parsed = updateManifestSchema.safeParse(raw)
      if (!parsed.success) {
        return this.fail('Update feed returned a malformed manifest.')
      }
      const entry = selectPlatformManifest(parsed.data, this.key())
      if (!entry) {
        // No build published for this platform yet (e.g. mac before its
        // first release) — a quiet "up to date" beats an error.
        this.set({ kind: 'current', version: this.deps.currentVersion() })
        return this.phase
      }
      if (!needsUpdate(entry.version, this.deps.currentVersion())) {
        this.set({ kind: 'current', version: entry.version })
        return this.phase
      }
      this.set({ kind: 'available', version: entry.version, notes: entry.notes })
      return this.phase
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError'
      return this.fail(aborted ? 'Update check timed out.' : `Update check failed: ${errorText(error)}`)
    } finally {
      this.busy = false
    }
  }

  /** Downloads and verifies the installer for the current 'available' phase. */
  async download(): Promise<UpdatePhase> {
    if (this.phase.kind !== 'available') return this.phase
    if (this.busy) return this.phase
    this.busy = true
    let response: Awaited<ReturnType<FetchLike>> | null = null
    let target = ''
    // Tracked so every failure path can release the file handle before the
    // temp-file unlink (Windows refuses to unlink open files).
    let stream: ReturnType<UpdateFs['createWriteStream']> | null = null
    try {
      const base = this.deps.baseUrl().trim()
      // Re-fetch the manifest so download uses fresh, validated values.
      const controller = new AbortController()
      const checkTimer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
      // Deadline covers the body read as well (same rationale as check()).
      let manifestText: string
      try {
        const manifestResponse = await this.deps.fetch(`${base.replace(/\/$/, '')}/updates/latest.json`, {
          signal: controller.signal
        })
        if (!manifestResponse.ok) {
          return this.fail(`Update feed returned HTTP ${manifestResponse.status}.`)
        }
        manifestText = await readBodyText(manifestResponse)
      } finally {
        clearTimeout(checkTimer)
      }
      const parsed = updateManifestSchema.safeParse(JSON.parse(manifestText))
      if (!parsed.success) return this.fail('Update feed returned a malformed manifest.')
      const entry = selectPlatformManifest(parsed.data, this.key())
      if (!entry) {
        this.set({ kind: 'current', version: this.deps.currentVersion() })
        return this.phase
      }
      if (!needsUpdate(entry.version, this.deps.currentVersion())) {
        this.set({ kind: 'current', version: entry.version })
        return this.phase
      }

      const url = resolveInstallerUrl(base, entry.url)
      const downloadController = new AbortController()
      const stall = setTimeout(() => downloadController.abort(), DOWNLOAD_STALL_MS)
      const resetStall = (): void => {
        clearTimeout(stall)
        stall.refresh()
      }
      try {
        response = await this.deps.fetch(url, { signal: downloadController.signal })
      } catch (error) {
        clearTimeout(stall)
        throw error
      }
      if (!response.ok) {
        clearTimeout(stall)
        return this.fail(`Installer download returned HTTP ${response.status}.`)
      }

      const size = entry.sizeBytes ?? 0
      const cap = Math.min(MAX_DOWNLOAD_BYTES, size > 0 ? Math.max(size + 1024 * 1024, size * 1.05) : MAX_DOWNLOAD_BYTES)
      // Name the file after the published asset (setup.exe on Windows, the
      // arch dmg on macOS). Mac DMGs land in ~/Downloads so the user can
      // open them directly; Windows installs from temp.
      const assetName = entry.url.split('?')[0].split('/').pop() || `Screen-Scout-${entry.version}`
      const downloadDir = this.deps.downloadsDir?.() ?? this.deps.tempDir()
      target = this.deps.joinPath(downloadDir, assetName)
      stream = this.deps.fs.createWriteStream(target)
      const writeState: { error: Error | null } = { error: null }
      stream.once('error', () => {
        writeState.error = new Error('Could not write the installer to disk.')
      })

      const hash = createHash('sha256')
      let received = 0
      let lastPercent = -1
      try {
        for await (const chunk of iterateBody(response)) {
          resetStall()
          received += chunk.length
          if (received > cap) {
            downloadController.abort()
            // Throw (not fail-and-return) so the outer catch releases the
            // stream handle and unlinks the partial temp file.
            const capError = new Error('Installer download exceeded the expected size.') as Error & { code?: string }
            capError.code = 'UPDATE_SIZE_CAP'
            throw capError
          }
          hash.update(chunk)
          stream.write(chunk)
          if (size > 0) {
            const percent = Math.min(99, Math.floor((received / size) * 100))
            if (percent !== lastPercent) {
              lastPercent = percent
              this.set({ kind: 'downloading', version: entry.version, percent })
            }
          }
        }
      } finally {
        clearTimeout(stall)
      }
      const out = stream
      out.end()
      const finished = await new Promise<boolean>((resolve) => {
        out.once('finish', () => resolve(true))
        out.once('error', () => resolve(false))
      })
      if (!finished || writeState.error) {
        this.deps.fs.unlink(target)
        return this.fail(writeState.error?.message ?? 'Could not save the installer.')
      }

      const digest = hash.digest('hex').toLowerCase()
      if (digest !== entry.sha256.toLowerCase()) {
        this.deps.fs.unlink(target)
        return this.fail('The downloaded installer failed its integrity check.')
      }
      this.set({ kind: 'verified', version: entry.version, filePath: target })
      return this.phase
    } catch (error) {
      if (target) {
        try {
          stream?.destroy()
        } catch {
          // best-effort cleanup
        }
        try {
          this.deps.fs.unlink(target)
        } catch {
          // best-effort cleanup
        }
      }
      const code = (error as { code?: unknown } | null)?.code
      if (code === 'UPDATE_SIZE_CAP' && error instanceof Error) {
        return this.fail(error.message)
      }
      const aborted = error instanceof Error && error.name === 'AbortError'
      return this.fail(aborted ? 'Installer download stalled.' : `Installer download failed: ${errorText(error)}`)
    } finally {
      this.busy = false
      void response
    }
  }

  /**
   * Windows finishing move: launches the verified NSIS installer detached
   * (the caller quits the app). On macOS the caller handles 'verified'
   * differently — a Finder hand-off to the DMG — and never calls this.
   */
  install(): boolean {
    if (this.phase.kind !== 'verified') return false
    // The verified file can vanish between download and Install (temp
    // cleaners); quitting on a missing installer would just kill the app.
    if (this.deps.fs.exists?.(this.phase.filePath) === false) {
      this.fail('The downloaded installer is gone. Check for updates and download it again.')
      return false
    }
    this.set({ kind: 'installing', version: this.phase.version })
    this.deps.spawn(this.phase.filePath, ['/S']).unref()
    return true
  }
}

async function* iterateBody(response: NonNullable<Awaited<ReturnType<FetchLike>>>): AsyncGenerator<Uint8Array> {
  const body = response.body
  if (!body) throw new Error('Installer response had no body.')
  if (typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      yield chunk
    }
    return
  }
  const reader = (body as { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } }).getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) return
    if (value) yield value
  }
}

async function readBodyText(response: NonNullable<Awaited<ReturnType<FetchLike>>>): Promise<string> {
  if (typeof response.text === 'function') return response.text()
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of iterateBody(response)) {
    total += chunk.length
    if (total > 64 * 1024) throw new Error('Manifest exceeded 64 KB.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
