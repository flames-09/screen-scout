import { describe, expect, it } from 'vitest'
import {
  serveUpdateManifest,
  serveUpdateRedirect,
  type UpdateManifest,
  type UpdateManifestRow
} from '../relay/src/index'
import type { Env } from '../relay/src/types'

function manifest(platform: string, file: string): UpdateManifestRow {
  return {
    platform,
    version: '0.1.2',
    url: `https://github.com/flames-09/screen-scout/releases/download/v0.1.2/${file}`,
    sha256: 'a'.repeat(64),
    sizeBytes: 97_824_932,
    notes: 'test notes',
    pubDate: '2026-11-26T00:00:00.000Z'
  }
}

const WIN = manifest('win', 'Screen-Scout-0.1.2-setup.exe')
const MAC_ARM64 = manifest('mac-arm64', 'Screen-Scout-0.1.2-mac-arm64.dmg')

/** Minimal D1 stub: prepare().all() returns the given rows (or throws). */
function fakeEnv(rows: UpdateManifestRow[], fail = false): Env {
  const all = async (): Promise<{ results: UpdateManifestRow[] }> => {
    if (fail) throw new Error('d1 down')
    return { results: rows }
  }
  const stmt = {
    bind: () => ({ run: all, all, first: all }),
    all,
    first: all,
    raw: all
  }
  return { DB: { prepare: () => stmt, batch: async () => [] } } as unknown as Env
}

describe('update feed (D1 manifest + GitHub asset)', () => {
  it('serves the win manifest at the top level plus a platforms map, without caching', async () => {
    const res = await serveUpdateManifest(fakeEnv([WIN, MAC_ARM64]))
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = (await res.json()) as UpdateManifest & { platforms: Record<string, UpdateManifest> }
    const { platform: _winPlatform, ...winManifest } = WIN
    const { platform: _macPlatform, ...macManifest } = MAC_ARM64
    expect(body).toEqual({ ...winManifest, platforms: { win: winManifest, 'mac-arm64': macManifest } })
  })

  it('keeps serving a win-only feed exactly like the pre-platform shape', async () => {
    const res = await serveUpdateManifest(fakeEnv([WIN]))
    expect(res.status).toBe(200)
    const body = (await res.json()) as UpdateManifest & { platforms: Record<string, UpdateManifest> }
    const { platform: _winPlatform, ...winManifest } = WIN
    expect(body).toEqual({ ...winManifest, platforms: { win: winManifest } })
  })

  it('reports the feed as unconfigured when the win row is missing', async () => {
    const res = await serveUpdateManifest(fakeEnv([MAC_ARM64]))
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('updates-unavailable')
  })

  it('reports the feed as unconfigured when no manifest rows exist', async () => {
    const res = await serveUpdateManifest(fakeEnv([]))
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('updates-unavailable')
  })

  it('degrades gracefully when D1 fails', async () => {
    const res = await serveUpdateManifest(fakeEnv([WIN], true))
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('updates-unavailable')
  })

  it('redirects /updates/<installer> to the hosted asset', async () => {
    const res = await serveUpdateRedirect(fakeEnv([WIN]), 'updates/Screen-Scout-0.1.2-setup.exe')
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe(WIN.url)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('redirects per-platform assets (mac dmg) to their own row', async () => {
    const res = await serveUpdateRedirect(fakeEnv([WIN, MAC_ARM64]), 'updates/Screen-Scout-0.1.2-mac-arm64.dmg')
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe(MAC_ARM64.url)
  })

  it('404s for asset names that do not match any published installer', async () => {
    const res = await serveUpdateRedirect(fakeEnv([WIN, MAC_ARM64]), 'updates/some-other-file.exe')
    expect(res.status).toBe(404)
  })
})
