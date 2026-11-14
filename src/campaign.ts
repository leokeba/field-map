import type { FieldPoint, PosterEvent, StoredPhoto } from './types'

export interface CampaignCapture {
  mapId: string
  layerId: string
  lat: number
  lng: number
  accuracyM: number | null
  capturedAt: string
  author: string
  file: File
}

export interface CampaignPoster {
  point: FieldPoint
  photo: StoredPhoto
}

/**
 * Build the one-click campaign poster: an active FieldPoint with a single
 * 'placed' event plus the stored camera photo that travels with it.
 */
export function buildCampaignPoster(capture: CampaignCapture): CampaignPoster {
  const pointId = crypto.randomUUID()
  const photoId = crypto.randomUUID()
  const recordedAt = new Date().toISOString()
  const event: PosterEvent = {
    id: crypto.randomUUID(),
    point_id: pointId,
    event_type: 'placed',
    occurred_at: capture.capturedAt,
    recorded_at: recordedAt,
    actor_id: capture.author,
    removal_reason: null,
    removal_confidence: null,
    note: null,
  }
  const point: FieldPoint = {
    id: pointId,
    mapId: capture.mapId,
    layerId: capture.layerId,
    lat: capture.lat,
    lng: capture.lng,
    recordType: 'poster',
    campaign: '',
    quantity: 1,
    status: 'active',
    lastObservedAt: capture.capturedAt,
    removedAt: null,
    removalReason: null,
    removalConfidence: null,
    removalNote: '',
    title: '',
    description: '',
    capturedAt: capture.capturedAt,
    clientCreatedAt: recordedAt,
    accuracyM: capture.accuracyM,
    author: capture.author,
    version: null,
    syncStatus: 'pending',
    photos: [{ id: photoId, filename: capture.file.name, status: 'pending', capturedAt: capture.capturedAt }],
    events: [event],
  }
  const photo: StoredPhoto = {
    id: photoId,
    pointId,
    file: capture.file,
    filename: capture.file.name,
    mimeType: capture.file.type || 'image/jpeg',
    capturedAt: capture.capturedAt,
    status: 'pending',
  }
  return { point, photo }
}
