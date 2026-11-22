import { app, safeStorage } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * OS-backed storage for the NVIDIA API key.
 *
 * - When `safeStorage` encryption is available (DPAPI on Windows, Keychain on
 *   macOS), the key is encrypted and stored in `api-key.bin` in the user data
 *   directory. Nothing can read it back without the OS credential context.
 * - When encryption is NOT available we do NOT fall back to plaintext. The key
 *   is kept in main-process memory for the current session only, and the UI
 *   explains the limitation.
 * - The key is never logged and never sent to the renderer; the renderer only
 *   ever learns `hasApiKey` / `keyStorageSecure` booleans.
 */

const KEY_FILE = 'api-key.bin'
const DEVICE_TOKEN_FILE = 'device-token.bin'
const GOOGLE_REFRESH_FILE = 'google-refresh-token.bin'

export class SecretStore {
  private sessionKey: string | null = null
  private sessionDeviceToken: string | null = null
  private sessionGoogleRefreshToken: string | null = null

  isSecureStorageAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  private keyFilePath(): string {
    return path.join(app.getPath('userData'), KEY_FILE)
  }

  private deviceTokenPath(): string {
    return path.join(app.getPath('userData'), DEVICE_TOKEN_FILE)
  }

  private readSecure(file: string, fallback: string | null): string | null {
    if (!this.isSecureStorageAvailable()) return fallback
    try {
      if (!fs.existsSync(file)) return fallback
      const encrypted = fs.readFileSync(file)
      if (encrypted.length === 0) return fallback
      const decrypted = safeStorage.decryptString(encrypted)
      return decrypted || fallback
    } catch {
      // Decrypt failures mean the blob was written under another OS user or
      // the key material changed; treat as "no value" rather than crashing.
      return fallback
    }
  }

  private writeSecure(
    file: string,
    value: string,
    fallbackMessage: string
  ): { ok: boolean; secure: boolean; message?: string } {
    if (!this.isSecureStorageAvailable()) {
      return { ok: true, secure: false, message: fallbackMessage }
    }
    try {
      fs.writeFileSync(file, safeStorage.encryptString(value))
      return { ok: true, secure: true }
    } catch {
      return { ok: true, secure: false, message: 'The value could not be written to secure storage; it is kept for this session only.' }
    }
  }

  /** Returns the stored key, or null when none is available. */
  getApiKey(): string | null {
    return this.readSecure(this.keyFilePath(), this.sessionKey)
  }

  /**
   * Persists the key. Returns `secure: false` when only session storage was
   * possible; callers must surface that to the user.
   */
  saveApiKey(key: string): { ok: boolean; secure: boolean; message?: string } {
    const trimmed = key.trim()
    if (trimmed.length === 0) return { ok: false, secure: false, message: 'Key is empty.' }
    if (!this.isSecureStorageAvailable()) {
      this.sessionKey = trimmed
      return {
        ok: true,
        secure: false,
        message:
          'OS-backed encryption is unavailable on this system. The key is kept in memory for this session only and will be discarded when Screen Scout exits.'
      }
    }
    try {
      fs.writeFileSync(this.keyFilePath(), safeStorage.encryptString(trimmed))
      this.sessionKey = null
      return { ok: true, secure: true }
    } catch {
      this.sessionKey = trimmed
      return {
        ok: true,
        secure: false,
        message: 'The key could not be written to secure storage; it is kept for this session only.'
      }
    }
  }

  removeApiKey(): void {
    this.sessionKey = null
    try {
      const file = this.keyFilePath()
      if (fs.existsSync(file)) fs.rmSync(file)
    } catch {
      // Best-effort removal; nothing sensitive is left in memory either way.
    }
  }

  /**
   * Hosted-mode device token (relay-issued, not the user's key). Stored the
   * same way as the API key: OS-encrypted when available, memory-only otherwise.
   */
  getDeviceToken(): string | null {
    return this.readSecure(this.deviceTokenPath(), this.sessionDeviceToken)
  }

  saveDeviceToken(token: string): { ok: boolean; secure: boolean; message?: string } {
    const trimmed = token.trim()
    if (trimmed.length === 0) return { ok: false, secure: false, message: 'Token is empty.' }
    const result = this.writeSecure(
      this.deviceTokenPath(),
      trimmed,
      'OS-backed encryption is unavailable; the hosted session token is kept in memory only.'
    )
    if (!result.secure) this.sessionDeviceToken = trimmed
    else this.sessionDeviceToken = null
    return result
  }

  removeDeviceToken(): void {
    this.sessionDeviceToken = null
    try {
      const file = this.deviceTokenPath()
      if (fs.existsSync(file)) fs.rmSync(file)
    } catch {
      // Best-effort removal.
    }
  }

  /**
   * Google OAuth refresh token (account sign-in). Long-lived credential that
   * mints short-lived Google id tokens — stored like every other secret:
   * OS-encrypted when available, memory-only otherwise.
   */
  getGoogleRefreshToken(): string | null {
    return this.readSecure(this.googleRefreshTokenPath(), this.sessionGoogleRefreshToken)
  }

  saveGoogleRefreshToken(token: string): { ok: boolean; secure: boolean; message?: string } {
    const trimmed = token.trim()
    if (trimmed.length === 0) return { ok: false, secure: false, message: 'Token is empty.' }
    const result = this.writeSecure(
      this.googleRefreshTokenPath(),
      trimmed,
      'OS-backed encryption is unavailable; the Google session token is kept in memory only.'
    )
    if (!result.secure) this.sessionGoogleRefreshToken = trimmed
    else this.sessionGoogleRefreshToken = null
    return result
  }

  removeGoogleRefreshToken(): void {
    this.sessionGoogleRefreshToken = null
    try {
      const file = this.googleRefreshTokenPath()
      if (fs.existsSync(file)) fs.rmSync(file)
    } catch {
      // Best-effort removal.
    }
  }

  private googleRefreshTokenPath(): string {
    return path.join(app.getPath('userData'), GOOGLE_REFRESH_FILE)
  }

  /** Drops any session-only secrets (used on quit). */
  dispose(): void {
    this.sessionKey = null
    this.sessionDeviceToken = null
    this.sessionGoogleRefreshToken = null
  }
}
