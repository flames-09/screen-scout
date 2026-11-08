import { createHash } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { updateManifestSchema, type UpdateManifest } from '@shared/schemas'
import type { UpdatePhase } from '@shared/types'

export type { UpdatePhase } from '@shared/types'

/**
 * Update service for the packaged Windows app.
 *
 * Checks the relay's update feed (`/updates/latest.json`), downloads the
 * installer to a temp file, verifies its SHA-256 against the manifest, and
 * launches it. Deliberately NOT electron-updater: the app ships with no
 * node_modules (everything is bundled by electron-vite), so the updater is a
 * small, dependency-free module here instead.
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
  createWriteStream(path: string): { write(chunk: Uint8Array): unknown; end(): unknown; once(event: 'error' | 'finish', cb: () => void): unknown }
  unlink(path: string): void
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
  joinPath(...parts: string[]): string
  fs: UpdateFs
  spawn: SpawnLike
  onState(phase: UpdatePhase): void
}

/** Hard cap on downloaded installers, manifest size or not. */
const MAX_DOWNLOAD_BYTES = 400 * 1024 * 1024
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

  /** Fetches and validates the manifest; resolves to 'current' or 'available'. */
  async check(): Promise<UpdatePhase> {
    const base = this.deps.baseUrl().trim()
    if (!base) {
      return this.fail('Updates are not configured in this build.')
    }
    if (this.busy) return this.phase
    this.busy = true
    this.set({ kind: 'checking' })
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
      let response: Awaited<ReturnType<FetchLike>>
      try {
        response = await this.deps.fetch(`${base.replace(/\/$/, '')}/updates/latest.json`, {
          signal: controller.signal
        })
      } finally {
        clearTimeout(timer)
      }
      if (!response.ok) {
        return this.fail(`Update feed returned HTTP ${response.status}.`)
      }
      const text = await readBodyText(response)
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
      const manifest: UpdateManifest = parsed.data
      if (!needsUpdate(manifest.version, this.deps.currentVersion())) {
        this.set({ kind: 'current', version: manifest.version })
        return this.phase
      }
      this.set({ kind: 'available', version: manifest.version, notes: manifest.notes })
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
    try {
      const base = this.deps.baseUrl().trim()
      // Re-fetch the manifest so download uses fresh, validated values.
      const controller = new AbortController()
      const checkTimer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
      const manifestResponse = await this.deps.fetch(`${base.replace(/\/$/, '')}/updates/latest.json`, {
        signal: controller.signal
      })
      clearTimeout(checkTimer)
      if (!manifestResponse.ok) {
        return this.fail(`Update feed returned HTTP ${manifestResponse.status}.`)
      }
      const parsed = updateManifestSchema.safeParse(JSON.parse(await readBodyText(manifestResponse)))
      if (!parsed.success) return this.fail('Update feed returned a malformed manifest.')
      const manifest: UpdateManifest = parsed.data
      if (!needsUpdate(manifest.version, this.deps.currentVersion())) {
        this.set({ kind: 'current', version: manifest.version })
        return this.phase
      }

      const url = resolveInstallerUrl(base, manifest.url)
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

      const size = manifest.sizeBytes ?? 0
      const cap = Math.min(MAX_DOWNLOAD_BYTES, size > 0 ? Math.max(size + 1024 * 1024, size * 1.05) : MAX_DOWNLOAD_BYTES)
      target = this.deps.joinPath(this.deps.tempDir(), `Screen-Scout-setup-${manifest.version}.exe`)
      const stream = this.deps.fs.createWriteStream(target)
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
            return this.fail('Installer download exceeded the expected size.')
          }
          hash.update(chunk)
          stream.write(chunk)
          if (size > 0) {
            const percent = Math.min(99, Math.floor((received / size) * 100))
            if (percent !== lastPercent) {
              lastPercent = percent
              this.set({ kind: 'downloading', version: manifest.version, percent })
            }
          }
        }
      } finally {
        clearTimeout(stall)
      }
      stream.end()
      const finished = await new Promise<boolean>((resolve) => {
        stream.once('finish', () => resolve(true))
        stream.once('error', () => resolve(false))
      })
      if (!finished || writeState.error) {
        this.deps.fs.unlink(target)
        return this.fail(writeState.error?.message ?? 'Could not save the installer.')
      }

      const digest = hash.digest('hex').toLowerCase()
      if (digest !== manifest.sha256.toLowerCase()) {
        this.deps.fs.unlink(target)
        return this.fail('The downloaded installer failed its integrity check.')
      }
      this.set({ kind: 'verified', version: manifest.version, filePath: target })
      return this.phase
    } catch (error) {
      if (target) {
        try {
          this.deps.fs.unlink(target)
        } catch {
          // best-effort cleanup
        }
      }
      const aborted = error instanceof Error && error.name === 'AbortError'
      return this.fail(aborted ? 'Installer download stalled.' : `Installer download failed: ${errorText(error)}`)
    } finally {
      this.busy = false
      void response
    }
  }

  /** Launches the verified installer detached; the caller quits the app. */
  install(): boolean {
    if (this.phase.kind !== 'verified') return false
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
