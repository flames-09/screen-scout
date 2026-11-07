import { clipboard, nativeImage } from 'electron'
import type { CropImage } from '../capture/image-processing'
import { encodeCropUnderLimit } from '../capture/image-processing'
import { imageImportSchema } from '@shared/schemas'
import type { ImageImportResult } from '@shared/types'

/**
 * Importing images from OUTSIDE the app (clipboard bitmap or a dropped file)
 * into the attachment pipeline.
 *
 * The renderer is untrusted and nativeImage only decodes PNG/JPEG, so every
 * import is validated and RE-ENCODED through the same size-capped encoder the
 * capture flow uses. Nothing is stored or uploaded here — the result lands in
 * the renderer's pending attachment exactly like a captured crop would.
 */

export function importImageBytes(raw: unknown, maxEncodedBytes: number): ImageImportResult {
  const parsed = imageImportSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, message: "That image can't be attached — it's too large or unreadable." }
  }
  let img: Electron.NativeImage
  try {
    img = nativeImage.createFromBuffer(Buffer.from(parsed.data))
  } catch {
    return { ok: false, message: "That file isn't a supported image (PNG or JPEG)." }
  }
  if (img.isEmpty()) {
    return { ok: false, message: "That file isn't a supported image (PNG or JPEG)." }
  }
  return finishImport(img as unknown as CropImage, maxEncodedBytes)
}

/** Reads an image straight from the system clipboard (covers bitmap-only pastes). */
export function importClipboardImage(maxEncodedBytes: number): ImageImportResult {
  let img: Electron.NativeImage
  try {
    img = clipboard.readImage()
  } catch {
    return { ok: false, message: "Couldn't read the clipboard image." }
  }
  if (img.isEmpty()) {
    return { ok: false, message: 'No image found on the clipboard.' }
  }
  return finishImport(img as unknown as CropImage, maxEncodedBytes)
}

function finishImport(img: CropImage, maxEncodedBytes: number): ImageImportResult {
  try {
    const encoded = encodeCropUnderLimit(img, { maxEncodedBytes })
    return {
      ok: true,
      dataUrl: encoded.dataUrl,
      width: encoded.width,
      height: encoded.height,
      bytes: encoded.bytes,
      mime: encoded.mime
    }
  } catch {
    return { ok: false, message: "Couldn't prepare that image for attaching. Try again." }
  }
}
