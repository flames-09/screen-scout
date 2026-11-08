import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'

/**
 * Tiny rotating file logger for the main process.
 *
 * Privacy rules (enforced by construction, not by discipline):
 *  - only developer-defined event strings and error messages are logged;
 *  - never a prompt, a screenshot, an API key, or a device id;
 *  - each line is newline-stripped and capped so a bad error string can't
 *    forge extra log lines or balloon the file.
 *
 * Rotation: when main.log exceeds LOG_MAX_BYTES it becomes main.1.log and a
 * fresh main.log starts; main.1.log is the only retained predecessor.
 */

export type LogLevel = 'info' | 'warn' | 'error'

export interface LoggerFs {
  existsSync(path: string): boolean
  mkdirSync(dir: string, options: { recursive: boolean }): void
  appendFileSync(path: string, data: string): void
  statSync(path: string): { size: number }
  renameSync(from: string, to: string): void
  rmSync(path: string): void
}

export interface LoggerDeps {
  logDir: string
  fs?: LoggerFs
  now?: () => number
}

export const LOG_MAX_BYTES = 512 * 1024

export class Logger {
  private readonly logDir: string
  private readonly fs: LoggerFs
  private readonly now: () => number
  private readonly mainPath: string
  private readonly backupPath: string

  constructor(deps: LoggerDeps) {
    this.logDir = deps.logDir
    this.fs = deps.fs ?? (nodeFs as unknown as LoggerFs)
    this.now = deps.now ?? Date.now
    this.mainPath = nodePath.join(this.logDir, 'main.log')
    this.backupPath = nodePath.join(this.logDir, 'main.1.log')
  }

  /** Idempotent; safe to call before any write. */
  ensureDir(): void {
    try {
      this.fs.mkdirSync(this.logDir, { recursive: true })
    } catch {
      // If we cannot create the log dir, logging becomes a no-op.
    }
  }

  logFile(): string {
    return this.mainPath
  }

  dir(): string {
    return this.logDir
  }

  info(message: string): void {
    this.write('info', message)
  }

  warn(message: string): void {
    this.write('warn', message)
  }

  error(message: string): void {
    this.write('error', message)
  }

  private write(level: LogLevel, message: string): void {
    try {
      this.ensureDir()
      this.rotateIfNeeded()
      this.fs.appendFileSync(this.mainPath, `${new Date(this.now()).toISOString()} ${level.toUpperCase()} ${sanitize(message)}\n`)
    } catch {
      // Never let logging take the app down.
    }
  }

  private rotateIfNeeded(): void {
    try {
      if (!this.fs.existsSync(this.mainPath)) return
      if (this.fs.statSync(this.mainPath).size < LOG_MAX_BYTES) return
      try {
        this.fs.rmSync(this.backupPath)
      } catch {
        // no previous backup — fine
      }
      this.fs.renameSync(this.mainPath, this.backupPath)
    } catch {
      // Rotation is best-effort.
    }
  }
}

/** One safe single-line record: no newlines, no control chars, bounded size. */
export function sanitize(message: string): string {
  return message
    .replace(/[\r\n\t]+/g, ' ')
    // Strip C0 control characters except space (0x20 is fine already).
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 2000)
}
