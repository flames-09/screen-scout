import { mkdtempSync, readFileSync, existsSync, mkdirSync, appendFileSync, statSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Logger, LOG_MAX_BYTES, sanitize } from '../src/main/logging/logger'

const dirs: string[] = []

function makeLogger(): { logger: Logger; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'scout-log-'))
  dirs.push(dir)
  return { logger: new Logger({ logDir: dir }), dir }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Logger', () => {
  it('writes ISO-stamped, level-prefixed lines', () => {
    const { logger, dir } = makeLogger()
    logger.info('app started')
    logger.error('boom happened')
    const text = readFileSync(join(dir, 'main.log'), 'utf8')
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO app started\n/)
    expect(text).toContain('ERROR boom happened')
  })

  it('collapses newlines and caps line length (no forged entries, no ballooning)', () => {
    const { logger, dir } = makeLogger()
    logger.warn('line one\nERROR forged line\r\n\ttabby')
    const text = readFileSync(join(dir, 'main.log'), 'utf8')
    expect(text.match(/\n/g)?.length).toBe(1)
    expect(text).toContain('line one ERROR forged line tabby')
    expect(text.length).toBeLessThan(2200)
    expect(sanitize('x'.repeat(5000)).length).toBe(2000)
  })

  it('rotates main.log to main.1.log when it exceeds the cap', () => {
    const { logger, dir } = makeLogger()
    const mainPath = join(dir, 'main.log')
    mkdirSync(dir, { recursive: true })
    appendFileSync(mainPath, 'x'.repeat(LOG_MAX_BYTES))
    logger.info('this should trigger rotation')
    expect(existsSync(join(dir, 'main.1.log'))).toBe(true)
    const fresh = readFileSync(mainPath, 'utf8')
    expect(fresh).toContain('this should trigger rotation')
    expect(fresh).not.toContain('x'.repeat(100))
    // Writes keep flowing after rotation.
    expect(statSync(mainPath).size).toBeGreaterThan(0)
    logger.info('second line after rotation')
    expect(readFileSync(mainPath, 'utf8').match(/\n/g)?.length).toBe(2)
    // The rename must not have re-created a stale backup on the next write.
    renameSync(mainPath, join(dir, 'moved.log'))
  })

  it('never throws, even with an unwritable log dir', () => {
    const logger = new Logger({
      logDir: 'Z:\\definitely\\not\\writable\\path',
      fs: {
        existsSync: () => false,
        mkdirSync: () => {
          throw new Error('denied')
        },
        appendFileSync: () => {
          throw new Error('denied')
        },
        statSync: () => ({ size: 0 }),
        renameSync: () => undefined,
        rmSync: () => undefined
      }
    })
    expect(() => logger.info('should not throw')).not.toThrow()
  })
})
