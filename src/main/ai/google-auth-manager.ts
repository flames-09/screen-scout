import { decodeIdTokenEmail, refreshGoogleIdToken, runGoogleAuthFlow, type TokenFetchLike } from './google-auth'

/**
 * Keeps a Google account session alive for hosted mode.
 *
 * The relay only accepts short-lived Google id_tokens (~1 hour). This manager:
 *  - runs the interactive browser flow once (on sign-in) and stores the long
 *   -lived refresh token via the SecretStore,
 *  - hands out cached id_tokens and silently mints new ones from the refresh
 *    token,
 *  - signals `auth-required` when only an interactive sign-in can fix it (no
 *    refresh token, revoked session) so the UI can prompt again.
 *
 * No Google credential ever reaches the renderer or the chat payload — only
 * the relay registration call sees the id_token.
 */

export class GoogleAuthError extends Error {
  constructor(
    public code: 'auth-required' | 'network' | 'no-client-id',
    message: string
  ) {
    super(message)
    this.name = 'GoogleAuthError'
  }
}

/** Refresh id tokens well before Google's ~1h expiry. */
const ID_TOKEN_CACHE_MS = 50 * 60 * 1000

export interface GoogleAuthManagerDeps {
  clientId(): string
  /** Baked relay URL; empty disables Google sign-in (the secret lives there). */
  relayUrl(): string
  getRefreshToken(): string | null
  /** Persists the refresh token; returns whether it will survive a restart. */
  saveRefreshToken(token: string): boolean
  clearRefreshToken(): void
  openExternal(url: string): Promise<void> | void
  /** Electron net.fetch (or a test double) with a JSON-able Response. */
  fetchImpl: TokenFetchLike
  flowTimeoutMs?: number
}

export class GoogleAuthManager {
  private cachedIdToken: string | null = null
  private cachedAt = 0
  private pendingFlow: Promise<{ email?: string; persisted?: boolean }> | null = null

  constructor(private deps: GoogleAuthManagerDeps) {}

  isConfigured(): boolean {
    return this.deps.clientId().trim() !== '' && this.deps.relayUrl().trim() !== ''
  }

  /** Interactive sign-in: browser → loopback → relay-ready id token. Single-flight. */
  async signIn(): Promise<{ email?: string; persisted?: boolean }> {
    if (!this.isConfigured()) {
      throw new GoogleAuthError('no-client-id', 'Google sign-in is not available in this build.')
    }
    if (this.pendingFlow) return await this.pendingFlow
    const pending = this.runSignInFlow()
    this.pendingFlow = pending
    try {
      return await pending
    } finally {
      if (this.pendingFlow === pending) this.pendingFlow = null
    }
  }

  private relayEndpoint(path: string): string {
    return `${this.deps.relayUrl().trim().replace(/\/$/, '')}${path}`
  }

  private async runSignInFlow(): Promise<{ email?: string; persisted?: boolean }> {
    const result = await runGoogleAuthFlow({
      clientId: this.deps.clientId().trim(),
      openExternal: (url) => this.deps.openExternal(url),
      fetchImpl: this.deps.fetchImpl,
      exchangeUrl: this.relayEndpoint('/v1/auth/google/exchange'),
      timeoutMs: this.deps.flowTimeoutMs
    })
    if (!result.ok) {
      // Denied / closed windows are the user's choice — not a network fault.
      throw new GoogleAuthError(result.code === 'denied' ? 'auth-required' : 'network', result.message)
    }
    let persisted = true
    if (result.refreshToken) persisted = this.deps.saveRefreshToken(result.refreshToken)
    this.cachedIdToken = result.idToken
    this.cachedAt = Date.now()
    return { email: decodeIdTokenEmail(result.idToken) ?? undefined, persisted }
  }

  /**
   * A fresh-enough id_token for relay registration. Throws GoogleAuthError
   * ('auth-required') when an interactive sign-in is needed.
   */
  async getIdToken(signal?: AbortSignal): Promise<string> {
    if (!this.isConfigured()) {
      throw new GoogleAuthError('auth-required', 'Google sign-in is not available in this build.')
    }
    if (this.cachedIdToken && Date.now() - this.cachedAt < ID_TOKEN_CACHE_MS) return this.cachedIdToken

    const refreshToken = this.deps.getRefreshToken()
    if (!refreshToken) {
      throw new GoogleAuthError('auth-required', 'Sign in with Google to keep using the free service.')
    }
    let result: { ok: true; idToken: string } | { ok: false; message: string }
    try {
      result = await refreshGoogleIdToken(
        this.deps.clientId().trim(),
        refreshToken,
        this.deps.fetchImpl,
        this.relayEndpoint('/v1/auth/google/refresh')
      )
    } catch {
      throw new GoogleAuthError('network', 'Could not refresh the Google session. Check your connection.')
    }
    if (!result.ok) {
      throw new GoogleAuthError('auth-required', result.message)
    }
    this.cachedIdToken = result.idToken
    this.cachedAt = Date.now()
    return result.idToken
  }

  /** Drop cached id token state (refresh token removal is the SecretStore's job). */
  clear(): void {
    this.cachedIdToken = null
    this.cachedAt = 0
  }
}
