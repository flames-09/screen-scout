/**
 * Minimal ambient types for the Worker runtime.
 *
 * We deliberately keep these hand-written instead of pulling in the whole
 * @cloudflare/workers-types package: the relay only uses a tiny slice of the
 * platform (fetch, D1, Workers AI, crypto, streams) and keeping the surface
 * small makes the pure logic easy to unit test in plain Node/vitest.
 */

export interface D1Result<T = unknown> {
  results?: T[]
  success: boolean
  meta?: Record<string, unknown>
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = unknown>(colName?: string): Promise<T | null>
  run<T = unknown>(): Promise<D1Result<T>>
  all<T = unknown>(): Promise<D1Result<T>>
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
  exec(query: string): Promise<D1Result>
}

export interface Ai {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>
}

export interface Env {
  DB: D1Database
  AI: Ai
  /** Secret — Groq API key (free tier). */
  GROQ_API_KEY?: string
  /**
   * Secret — NVIDIA build.nvidia.com API key. When present, image turns are
   * served by NVIDIA's hosted vision model first, with Workers AI as fallback.
   */
  NVIDIA_API_KEY?: string
  /** Secret — HMAC key for device tokens. */
  TOKEN_SIGNING_SECRET?: string
  PUBLIC_MODEL_ID: string
  GROQ_MODEL: string
  CF_MODEL: string
  /** NVIDIA vision model id (defaults to nvidia/nemotron-3.5-super-vl-120b-a12b). */
  NVIDIA_MODEL?: string
  DEVICE_PER_DAY: string
  DEVICE_PER_WINDOW: string
  WINDOW_HOURS: string
  GLOBAL_GROQ_PER_DAY: string
  GLOBAL_CF_PER_DAY: string
  /** Account-wide daily cap for the NVIDIA image pool (optional, default 400). */
  GLOBAL_NVIDIA_PER_DAY?: string
  MAX_BODY_BYTES: string
  REGISTRATIONS_PER_IP_PER_DAY: string
  /** Per-IP/day cap on account deletions (default 3; stops quota-reset farming). */
  DELETES_PER_IP_PER_DAY?: string
  /** Google Sign-In OAuth client id (public). Empty = /auth/google disabled. */
  GOOGLE_CLIENT_ID?: string
  /** Daily image-question cap per Google account (default 5). */
  ACCOUNT_IMAGE_PER_DAY?: string
  /** Daily text-question cap per Google account (default 50). */
  ACCOUNT_CHAT_PER_DAY?: string
  /** Kill switch: set to "false" to pause the hosted service (maintenance). */
  HOSTED_ENABLED?: string
  /** Oldest app version the hosted service still accepts ("0.0.0" = no gate). */
  MIN_APP_VERSION?: string
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void
}

export interface ScheduledEventLike {
  scheduledTime: number
  cron: string
}
