import type { StoredPhoto } from './types'

/**
 * Photo bytes are persisted in IndexedDB as base64 strings, never as Blobs:
 * iOS Safari intermittently fails to store Blob/File objects ("Error preparing
 * Blob/File data to be stored in object store", webkit#188438). Plain strings
 * clone and persist reliably on every platform.
 */

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

export function base64ToBlob(data: string, type: string): Blob {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let offset = 0; offset < binary.length; offset += 1) {
    bytes[offset] = binary.charCodeAt(offset)
  }
  return new Blob([bytes], { type })
}

/** Structural check for btoa() output; atob() accepts exactly this shape. */
export function looksLikeBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value)
}

/**
 * Rehydrate a stored photo's base64 payload into an uploadable Blob.
 * Returns null when the row carries no usable bytes: iOS Safari's Blob-store
 * bug (webkit#188438) can leave records with a corrupt or missing payload,
 * and callers must skip those instead of throwing from atob().
 */
export function photoBlob(photo: StoredPhoto & { file?: unknown }): Blob | null {
  if (typeof photo.fileData === 'string' && looksLikeBase64(photo.fileData)) {
    try {
      return base64ToBlob(photo.fileData, photo.mimeType)
    } catch {
      return null
    }
  }
  // Legacy rows written before the base64 migration.
  if (photo.file instanceof Blob) return photo.file
  return null
}
