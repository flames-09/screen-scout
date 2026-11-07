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
  /** Secret — HMAC key for device tokens. */
  TOKEN_SIGNING_SECRET?: string
  PUBLIC_MODEL_ID: string
  GROQ_MODEL: string
  CF_MODEL: string
  DEVICE_PER_DAY: string
  DEVICE_PER_WINDOW: string
  WINDOW_HOURS: string
  GLOBAL_GROQ_PER_DAY: string
  GLOBAL_CF_PER_DAY: string
  MAX_BODY_BYTES: string
  REGISTRATIONS_PER_IP_PER_DAY: string
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void
}

export interface ScheduledEventLike {
  scheduledTime: number
  cron: string
}
