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

/** Rehydrate a stored photo's base64 payload into an uploadable Blob. */
export function photoBlob(photo: StoredPhoto): Blob {
  return base64ToBlob(photo.fileData, photo.mimeType)
}
