/**
 * Pure policy for which dropped/pasted image sources can be attached.
 * Electron's nativeImage decodes PNG and JPEG only — anything else is
 * rejected with an honest message instead of a silently broken attachment.
 */
export function isAttachableImageMime(mime: string): boolean {
  return mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/jpg'
}
