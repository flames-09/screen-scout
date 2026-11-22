import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  needsUpdate,
  resolveInstallerUrl,
  UpdateService,
  type UpdateDeps,
  type UpdatePhase
} from '../src/main/updates/update-service'

const INSTALLER = Buffer.alloc(16 * 1024, 7)
const INSTALLER_SHA = createHash('sha256').update(INSTALLER).digest('hex')

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '9.9.9',
    url: '/updates/Screen-Scout-9.9.9-setup.exe',
    sha256: INSTALLER_SHA,
    sizeBytes: INSTALLER.length,
    notes: 'test update',
    ...overrides
  }
}

interface FakeRoute {
  match(url: string): boolean
  respond(): { status: number; body?: () => Uint8Array | string }
}

function makeDeps(overrides: {
  routes?: FakeRoute[]
  currentVersion?: string
  baseUrl?: string
} = {}): { deps: UpdateDeps; phases: UpdatePhase[]; files: Map<string, Uint8Array[]>; unlinked: string[]; spawned: string[][]; destroyedStreams: string[] } {
  const phases: UpdatePhase[] = []
  const files = new Map<string, Uint8Array[]>()
  const unlinked: string[] = []
  const spawned: string[][] = []
  const destroyedStreams: string[] = []
  const routes = overrides.routes ?? [
    {
      match: (url) => url.endsWith('/updates/latest.json'),
      respond: () => ({ status: 200, body: () => JSON.stringify(manifest()) })
    },
    {
      match: (url) => url.includes('/updates/Screen-Scout-9.9.9-setup.exe'),
      respond: () => ({ status: 200, body: () => INSTALLER })
    }
  ]
  const deps: UpdateDeps = {
    fetch: (async (input: string) => {
      const route = routes.find((r) => r.match(input))
      if (!route) return { ok: false, status: 404 }
      const res = route.respond()
      if (res.status !== 200) return { ok: false, status: res.status }
      const payload = res.body ? res.body() : INSTALLER
      const bytes = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
      // Chunk the body so the streaming path is exercised.
      const half = Math.floor(bytes.length / 2)
      const body = (async function* () {
        yield bytes.subarray(0, half)
        yield bytes.subarray(half)
      })()
      return { ok: true, status: 200, body }
    }) as UpdateDeps['fetch'],
    baseUrl: () => overrides.baseUrl ?? 'https://relay.test',
    currentVersion: () => overrides.currentVersion ?? '0.1.0',
    tempDir: () => '/tmp-fake',
    joinPath: (...parts) => parts.join('/'),
    fs: {
      createWriteStream: (p) => {
        const chunks: Uint8Array[] = []
        files.set(p, chunks)
        // Real streams emit 'finish' asynchronously after end(), so listeners
        // attached after end() still fire — mirror that with a microtask.
        let finishCb: (() => void) | null = null
        return {
          write: (chunk) => {
            chunks.push(chunk)
            return true
          },
          end: () => {
            queueMicrotask(() => finishCb?.())
            return undefined
          },
          once: (event, cb) => {
            if (event === 'finish') finishCb = cb
            void cb
            return undefined
          },
          destroy: () => {
            destroyedStreams.push(p)
            return undefined
          }
        }
      },
      unlink: (p) => {
        unlinked.push(p)
      },
      exists: (p) => files.has(p)
    },
    spawn: (file, args) => {
      spawned.push([file, ...args])
      return { unref: () => undefined }
    },
    onState: (phase) => phases.push(phase)
  }
  return { deps, phases, files, unlinked, spawned, destroyedStreams }
}

describe('version comparison', () => {
  it('compares semver numerically', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
    expect(compareVersions('9.9.9', '0.1.0')).toBe(1)
    expect(compareVersions('0.1.0', '9.9.9')).toBe(-1)
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1)
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
  })

  it('ignores a v prefix and prerelease suffixes', () => {
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0)
    expect(needsUpdate('1.0.0-beta', '1.0.0')).toBe(false)
    expect(needsUpdate('v0.2.0', '0.1.9')).toBe(true)
  })
})

describe('installer URL resolution', () => {
  it('resolves relative URLs against the feed and passes absolute ones through', () => {
    expect(resolveInstallerUrl('https://relay.test', '/updates/x.exe')).toBe('https://relay.test/updates/x.exe')
    expect(resolveInstallerUrl('https://relay.test/', 'updates/x.exe')).toBe('https://relay.test/updates/x.exe')
    expect(resolveInstallerUrl('https://relay.test', 'https://cdn.test/x.exe')).toBe('https://cdn.test/x.exe')
  })
})

describe('UpdateService.check', () => {
  it('reports an available update for a newer manifest version', async () => {
    const { deps } = makeDeps()
    const service = new UpdateService(deps)
    const phase = await service.check()
    expect(phase.kind).toBe('available')
    if (phase.kind === 'available') {
      expect(phase.version).toBe('9.9.9')
      expect(phase.notes).toBe('test update')
    }
  })

  it('reports current when the manifest is not newer', async () => {
    const { deps } = makeDeps({ currentVersion: '9.9.9' })
    const service = new UpdateService(deps)
    const phase = await service.check()
    expect(phase.kind).toBe('current')
  })

  it('fails honestly on non-200, bad JSON, and malformed manifests', async () => {
    const bad500 = makeDeps({ routes: [{ match: () => true, respond: () => ({ status: 503 }) }] })
    expect((await new UpdateService(bad500.deps).check()).kind).toBe('error')

    const badJson = makeDeps({
      routes: [{ match: () => true, respond: () => ({ status: 200, body: () => 'not json' }) }]
    })
    const phase = await new UpdateService(badJson.deps).check()
    expect(phase.kind).toBe('error')
    if (phase.kind === 'error') expect(phase.message).toContain('JSON')

    const badManifest = makeDeps({
      routes: [
        {
          match: () => true,
          respond: () => ({ status: 200, body: () => JSON.stringify({ version: '9.9.9' }) })
        }
      ]
    })
    const malformed = await new UpdateService(badManifest.deps).check()
    expect(malformed.kind).toBe('error')
    if (malformed.kind === 'error') expect(malformed.message).toContain('malformed')
  })

  it('fails when the feed is not configured', async () => {
    const { deps } = makeDeps({ baseUrl: '' })
    const phase = await new UpdateService(deps).check()
    expect(phase.kind).toBe('error')
    if (phase.kind === 'error') expect(phase.message).toContain('not configured')
  })

  it('does not clobber a verified update when re-checked', async () => {
    const { deps, phases } = makeDeps()
    const service = new UpdateService(deps)
    await service.check()
    await service.download()
    expect(service.currentPhase().kind).toBe('verified')
    const phaseCount = phases.length
    const phase = await service.check()
    expect(phase.kind).toBe('verified')
    // No 'checking'/'available' transition may fire: the verified installer
    // would be orphaned and the user forced to re-download.
    expect(phases.length).toBe(phaseCount)
  })
})

describe('UpdateService.download', () => {
  it('streams, hashes, and verifies the installer', async () => {
    const { deps, files, phases } = makeDeps()
    const service = new UpdateService(deps)
    await service.check()
    const phase = await service.download()
    expect(phase.kind).toBe('verified')
    if (phase.kind === 'verified') {
      expect(phase.version).toBe('9.9.9')
      expect(phase.filePath).toContain('/tmp-fake/')
    }
    const written = [...files.values()][0]
    expect(Buffer.concat(written.map((c) => Buffer.from(c))).equals(INSTALLER)).toBe(true)
    // The download progress phases were emitted (at least the final one).
    const downloads = phases.filter((p) => p.kind === 'downloading')
    expect(downloads.length).toBeGreaterThan(0)
  })

  it('removes the file and errors when the hash does not match', async () => {
    const { deps, unlinked } = makeDeps({
      routes: [
        { match: (url) => url.endsWith('latest.json'), respond: () => ({ status: 200, body: () => JSON.stringify(manifest()) }) },
        { match: () => true, respond: () => ({ status: 200, body: () => Buffer.alloc(1024, 1) }) }
      ]
    })
    const service = new UpdateService(deps)
    await service.check()
    const phase = await service.download()
    expect(phase.kind).toBe('error')
    if (phase.kind === 'error') expect(phase.message).toContain('integrity')
    expect(unlinked.length).toBe(1)
  })

  it('is a no-op when no update is available', async () => {
    const { deps } = makeDeps()
    const service = new UpdateService(deps)
    const phase = await service.download()
    expect(phase.kind).toBe('idle')
  })

  it('cleans up the temp file and stream when the download exceeds the size cap', async () => {
    const oversized = Buffer.alloc(1_200_000, 3)
    const { deps, unlinked, destroyedStreams } = makeDeps({
      routes: [
        { match: (url) => url.endsWith('latest.json'), respond: () => ({ status: 200, body: () => JSON.stringify(manifest({ sizeBytes: 1024 })) }) },
        { match: () => true, respond: () => ({ status: 200, body: () => oversized }) }
      ]
    })
    const service = new UpdateService(deps)
    await service.check()
    const phase = await service.download()
    expect(phase.kind).toBe('error')
    if (phase.kind === 'error') expect(phase.message).toContain('exceeded the expected size')
    // The partial temp file and its write handle must both be released.
    expect(unlinked.length).toBe(1)
    expect(destroyedStreams.length).toBe(1)
    // The service must not wedge in 'busy': a retry reaches the feed again.
    expect(service.currentPhase().kind).toBe('error')
  })
})

describe('UpdateService.install', () => {
  it('spawns the installer silently only from the verified phase', async () => {
    const { deps, spawned } = makeDeps()
    const service = new UpdateService(deps)
    expect(service.install()).toBe(false)
    await service.check()
    await service.download()
    expect(service.install()).toBe(true)
    expect(spawned.length).toBe(1)
    expect(spawned[0].slice(1)).toEqual(['/S'])
    expect(service.currentPhase().kind).toBe('installing')
  })

  it('refuses to install when the verified file has vanished', async () => {
    const { deps, spawned } = makeDeps()
    const service = new UpdateService(deps)
    await service.check()
    await service.download()
    deps.fs.exists = () => false
    expect(service.install()).toBe(false)
    expect(spawned.length).toBe(0)
    expect(service.currentPhase().kind).toBe('error')
  })
})
