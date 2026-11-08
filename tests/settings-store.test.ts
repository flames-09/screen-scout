import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DEFAULT_SETTINGS, sanitizeSettings, SettingsStore, type SettingsFs } from '../src/main/settings/settings-store'

/** Real filesystem against a temp dir — the store only uses sync calls. */
function tempStore(): { store: SettingsStore; dir: string; fsWrapper: SettingsFs } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-settings-'))
  const file = path.join(dir, 'settings.json')
  const fsWrapper: SettingsFs = {
    existsSync: (p) => fs.existsSync(p),
    readFileSync: (p) => fs.readFileSync(p, 'utf8'),
    writeFileSync: (p, d) => fs.writeFileSync(p, d),
    mkdirSync: (d) => fs.mkdirSync(d, { recursive: true })
  }
  return { store: new SettingsStore(fsWrapper, file), dir, fsWrapper: fsWrapper }
}

describe('SettingsStore', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  beforeEach(() => {
    dirs.length = 0
  })

  it('returns defaults when no file exists', () => {
    const { store, dir } = tempStore()
    dirs.push(dir)
    expect(store.load()).toEqual(DEFAULT_SETTINGS)
    expect(store.load().shortcut).toBe('Shift+R')
    expect(store.load().baseUrl).toBe('https://integrate.api.nvidia.com/v1/chat/completions')
  })

  it('persists updates and reloads them from disk', () => {
    const { store, dir } = tempStore()
    dirs.push(dir)
    store.update({ model: 'nvidia/nemotron-nano-12b-v2-vl', requestTimeoutSec: 90 })
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
    expect(raw.model).toBe('nvidia/nemotron-nano-12b-v2-vl')

    // A fresh store instance sees the same values.
    const file = path.join(dir, 'settings.json')
    const second = new SettingsStore(
      {
        existsSync: (p) => fs.existsSync(p),
        readFileSync: (p) => fs.readFileSync(p, 'utf8'),
        writeFileSync: (p, d) => fs.writeFileSync(p, d),
        mkdirSync: (d) => fs.mkdirSync(d, { recursive: true })
      },
      file
    )
    expect(second.load().model).toBe('nvidia/nemotron-nano-12b-v2-vl')
    expect(second.load().requestTimeoutSec).toBe(90)
  })

  it('recovers from a corrupt settings file with defaults', () => {
    const { store, dir } = tempStore()
    dirs.push(dir)
    fs.writeFileSync(path.join(dir, 'settings.json'), '{not json')
    expect(store.load()).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps unknown keys out of the persisted state', () => {
    const { store, dir } = tempStore()
    dirs.push(dir)
    store.update({ model: 'x/y' } as never)
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
    expect(Object.keys(raw).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort())
  })
})

describe('sanitizeSettings', () => {
  it('accepts valid patches and normalizes whitespace', () => {
    const s = sanitizeSettings({ model: '  meta/llama-3.2-90b-vision-instruct ', shortcut: 'Shift+R ' })
    expect(s.model).toBe('meta/llama-3.2-90b-vision-instruct')
    expect(s.shortcut).toBe('Shift+R')
  })

  it('falls back to defaults for invalid fields instead of throwing', () => {
    const s = sanitizeSettings({
      model: '',
      baseUrl: 'javascript:alert(1)',
      shortcut: '',
      requestTimeoutSec: -5,
      launchOnStartup: 'yes',
      maxImageBytes: 1
    })
    expect(s.model).toBe(DEFAULT_SETTINGS.model)
    expect(s.baseUrl).toBe(DEFAULT_SETTINGS.baseUrl)
    expect(s.shortcut).toBe(DEFAULT_SETTINGS.shortcut)
    expect(s.requestTimeoutSec).toBe(10)
    expect(s.launchOnStartup).toBe(false)
    expect(s.maxImageBytes).toBe(DEFAULT_SETTINGS.maxImageBytes)
  })

  it('clamps the timeout into the supported range', () => {
    expect(sanitizeSettings({ requestTimeoutSec: 99999 }).requestTimeoutSec).toBe(300)
    expect(sanitizeSettings({ requestTimeoutSec: 45 }).requestTimeoutSec).toBe(45)
  })

  it('clamps the glass tint into 0–100 and rounds', () => {
    expect(sanitizeSettings({ glassTint: 140 }).glassTint).toBe(100)
    expect(sanitizeSettings({ glassTint: -5 }).glassTint).toBe(0)
    expect(sanitizeSettings({ glassTint: 51.7 }).glassTint).toBe(52)
    expect(sanitizeSettings({}).glassTint).toBe(50)
  })

  it('never stores secrets: an apiKey field is ignored entirely', () => {
    const s = sanitizeSettings({ apiKey: 'nvapi-supersecret' } as never)
    expect((s as unknown as Record<string, unknown>).apiKey).toBeUndefined()
    expect(JSON.stringify(s)).not.toContain('supersecret')
  })

  it('defaults the capture shortcut to Shift+C', () => {
    expect(DEFAULT_SETTINGS.captureShortcut).toBe('Shift+C')
    expect(sanitizeSettings({}).captureShortcut).toBe('Shift+C')
  })

  it('keeps a valid capture shortcut and accepts the disabled sentinel', () => {
    expect(sanitizeSettings({ captureShortcut: 'Control+Alt+F7' }).captureShortcut).toBe('Control+Alt+F7')
    expect(sanitizeSettings({ captureShortcut: '' }).captureShortcut).toBe('')
  })

  it('keeps a valid peek shortcut and accepts the disabled sentinel', () => {
    expect(sanitizeSettings({ peekShortcut: 'Control+Alt+F8' }).peekShortcut).toBe('Control+Alt+F8')
    expect(sanitizeSettings({ peekShortcut: '' }).peekShortcut).toBe('')
  })

  it('defaults the peek shortcut to Shift+S', () => {
    expect(DEFAULT_SETTINGS.peekShortcut).toBe('Shift+S')
    expect(sanitizeSettings({}).peekShortcut).toBe('Shift+S')
  })

  it('falls back to the default for a malformed capture shortcut', () => {
    // A '+' with no modifier prefix fails the accelerator pattern...
    expect(sanitizeSettings({ captureShortcut: 'x+Y' }).captureShortcut).toBe('Shift+C')
    expect(sanitizeSettings({ captureShortcut: 42 }).captureShortcut).toBe('Shift+C')
  })
})

describe('access mode settings', () => {
  it('defaults to hosted mode while this build has a relay URL baked in', () => {
    // src/shared/hosted.ts carries the production relay URL (written by
    // scripts/set-relay-url.mjs). Clearing it with `--clear` flips this
    // default back to 'byok'.
    expect(DEFAULT_SETTINGS.accessMode).toBe('hosted')
    expect(DEFAULT_SETTINGS.deviceId).toBe('')
  })

  it('accepts both access modes and rejects unknown values', () => {
    expect(sanitizeSettings({ accessMode: 'hosted' }).accessMode).toBe('hosted')
    expect(sanitizeSettings({ accessMode: 'byok' }).accessMode).toBe('byok')
    expect(sanitizeSettings({ accessMode: 'hacked' }).accessMode).toBe(DEFAULT_SETTINGS.accessMode)
  })

  it('accepts a generated device id and rejects junk', () => {
    const id = 'a'.repeat(32)
    expect(sanitizeSettings({ deviceId: id }).deviceId).toBe(id)
    expect(sanitizeSettings({ deviceId: '' }).deviceId).toBe('')
    expect(sanitizeSettings({ deviceId: 'short' }).deviceId).toBe('')
    expect(sanitizeSettings({ deviceId: 'has spaces in it!!!!!!!!' }).deviceId).toBe('')
  })
})
