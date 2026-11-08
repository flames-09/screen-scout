import { z } from 'zod'
import { DEFAULT_MAX_IMAGE_BYTES } from './types'

/**
 * Zod schemas used to validate every IPC payload in the main process.
 * The renderer is considered untrusted; nothing is executed before it parses.
 */

const ACCELERATOR_RE = /^(?:Ctrl|Control|Cmd|Command|Alt|Option|AltGr|Shift|Super|CmdOrControl|Meta)\+/i

export const acceleratorSchema = z
  .string()
  .trim()
  .min(2)
  .max(48)
  .refine((v) => !v.includes('+') || ACCELERATOR_RE.test(v), {
    message: 'Shortcut must look like "Shift+R" (modifiers first, then a key).'
  })

export const modelIdSchema = z.string().trim().min(3).max(160)

export const baseUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((v) => /^https?:\/\//i.test(v), { message: 'Endpoint must be an http(s) URL.' })

export const apiKeySchema = z.string().min(8).max(4096)

export const settingsSchema = z.object({
  model: modelIdSchema,
  baseUrl: baseUrlSchema,
  /** 'hosted' uses Screen Scout's relay (no key); 'byok' uses the user's key. */
  accessMode: z.enum(['hosted', 'byok']),
  /** Random per-install id for the hosted free tier; '' until generated. */
  deviceId: z.union([z.literal(''), z.string().regex(/^[A-Za-z0-9_-]{16,64}$/)]),
  shortcut: acceleratorSchema,
  /** Empty string disables the direct-capture shortcut. */
  captureShortcut: z.union([acceleratorSchema, z.literal('')]),
  /** Empty string disables the peek shortcut (hide without resetting). */
  peekShortcut: z.union([acceleratorSchema, z.literal('')]),
  requestTimeoutSec: z.number().int().min(10).max(300),
  launchOnStartup: z.boolean(),
  noticeAcknowledged: z.boolean(),
  /** Periodic + on-demand update checks against the relay's update feed. */
  updatesEnabled: z.boolean().default(true),
  /** Glass tint strength 0–100 (50 = shipped default look). */
  glassTint: z.number().int().min(0).max(100).default(50),
  maxImageBytes: z.number().int().min(256 * 1024).max(10 * 1024 * 1024).default(DEFAULT_MAX_IMAGE_BYTES)
})
export type SettingsPayload = z.infer<typeof settingsSchema>

export const saveSettingsSchema = settingsSchema.partial()

export const chatTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(16_000)
})

/** Conversation context sent along with each request. Trimmed defensively. */
export const historySchema = z.array(chatTurnSchema).max(16)

export const MAX_IMAGE_DATA_URL_CHARS = 8 * 1024 * 1024 // ~6 MB binary after base64

export const sendDataUrlSchema = z
  .string()
  .max(MAX_IMAGE_DATA_URL_CHARS)
  .refine((v) => /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(v), {
    message: 'Attachment must be a base64 PNG or JPEG data URL.'
  })

export const sendMessageSchema = z.object({
  requestId: z.string().uuid(),
  text: z.string().max(8000),
  imageDataUrl: sendDataUrlSchema.optional(),
  history: historySchema.default([])
})

export const requestIdSchema = z.object({ requestId: z.string().uuid() })

export const selectionRectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive(),
  height: z.number().positive()
})

export const resizeSchema = z.object({
  deltaWidth: z.number().int(),
  deltaHeight: z.number().int()
})

export const openExternalSchema = z
  .string()
  .max(2048)
  .refine((v) => /^https?:\/\//i.test(v), { message: 'Only http(s) links can be opened.' })

export const testConnectionSchema = z.object({
  baseUrl: baseUrlSchema.optional(),
  model: modelIdSchema.optional()
})

/**
 * Image bytes handed over from the clipboard or a dropped file. The renderer
 * is untrusted: size is capped before anything is decoded in the main process.
 */
export const IMPORT_MAX_IMAGE_BYTES = 32 * 1024 * 1024

/**
 * Update feed manifest served by the relay at /updates/latest.json. The
 * installer URL may be absolute or relative to the relay root; sha256 is the
 * lowercase hex digest of the installer file.
 */
export const updateManifestSchema = z.object({
  version: z.string().trim().regex(/^v?\d+\.\d+\.\d+$/),
  url: z.string().trim().min(1).max(2048),
  sha256: z.string().trim().regex(/^[a-fA-F0-9]{64}$/),
  sizeBytes: z.number().int().positive().max(400 * 1024 * 1024).optional(),
  notes: z.string().trim().max(2000).optional(),
  pubDate: z.string().trim().max(40).optional()
})
export type UpdateManifest = z.infer<typeof updateManifestSchema>

export const imageImportSchema = z
  .instanceof(Uint8Array)
  .refine((b) => b.byteLength > 0 && b.byteLength <= IMPORT_MAX_IMAGE_BYTES, {
    message: 'Image is too large to attach (limit 32 MB).'
  })

/** Formats a Zod failure into a short, user-readable string. */
export function formatZodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ')
}
