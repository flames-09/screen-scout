import { describe, expect, it } from 'vitest'
import { serveUpdateManifest, serveUpdateRedirect, type UpdateManifest } from '../relay/src/index'
import type { Env } from '../relay/src/types'

const MANIFEST: UpdateManifest = {
  version: '0.1.1',
  url: 'https://github.com/flames-09/screen-scout/releases/download/v0.1.1/Screen-Scout-0.1.1-setup.exe',
  sha256: 'a'.repeat(64),
  sizeBytes: 97_824_932,
  notes: 'test notes',
  pubDate: '2026-11-25T00:00:00.000Z'
}

/** Minimal D1 stub: prepare().first() returns the given row (or throws). */
function fakeEnv(row: UpdateManifest | null, fail = false): Env {
  const first = async (): Promise<UpdateManifest | null> => {
    if (fail) throw new Error('d1 down')
    return row
  }
  const stmt = {
    bind: () => ({ run: first, all: first, first }),
    first,
    raw: first
  }
  return { DB: { prepare: () => stmt, batch: async () => [] } } as unknown as Env
}

describe('update feed (D1 manifest + GitHub asset)', () => {
  it('serves the manifest as JSON without caching', async () => {
    const res = await serveUpdateManifest(fakeEnv(MANIFEST))
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toEqual(MANIFEST)
  })

  it('reports the feed as unconfigured when no manifest row exists', async () => {
    const res = await serveUpdateManifest(fakeEnv(null))
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('updates-unavailable')
  })

  it('degrades gracefully when D1 fails', async () => {
    const res = await serveUpdateManifest(fakeEnv(MANIFEST, true))
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('updates-unavailable')
  })

  it('redirects /updates/<installer> to the hosted asset', async () => {
    const res = await serveUpdateRedirect(fakeEnv(MANIFEST), 'updates/Screen-Scout-0.1.1-setup.exe')
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe(MANIFEST.url)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('404s for asset names that do not match the published installer', async () => {
    const res = await serveUpdateRedirect(fakeEnv(MANIFEST), 'updates/some-other-file.exe')
    expect(res.status).toBe(404)
  })
})
