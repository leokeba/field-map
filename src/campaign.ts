import { blobToBase64 } from './photo-bytes'
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
export async function buildCampaignPoster(capture: CampaignCapture): Promise<CampaignPoster> {
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
    fileData: await blobToBase64(capture.file),
    filename: capture.file.name,
    mimeType: capture.file.type || 'image/jpeg',
    capturedAt: capture.capturedAt,
    status: 'pending',
  }
  return { point, photo }
}

/** Base radius for "which poster am I looking at?" in campaign check mode. */
export const CHECK_MATCH_RADIUS_M = 25

export interface CheckPosition {
  lat: number
  lng: number
  accuracyM: number | null
}

export interface CheckCandidate {
  point: FieldPoint
  distanceM: number
}

export interface CheckSelection {
  /** Every active poster sorted by distance, for the disambiguation list. */
  candidates: CheckCandidate[]
  /** Posters inside the match radius (GPS accuracy added on top). */
  matches: CheckCandidate[]
  /** The single auto-selected match, or null when a human should choose. */
  auto: CheckCandidate | null
}

/** Great-circle distance in metres (haversine). */
export function haversineM(
  latA: number,
  lngA: number,
  latB: number,
  lngB: number,
): number {
  const toRad = (value: number) => (value * Math.PI) / 180
  const earthRadiusM = 6371008.8
  const dLat = toRad(latB - latA)
  const dLng = toRad(lngB - lngA)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(latA)) * Math.cos(toRad(latB)) * Math.sin(dLng / 2) ** 2
  return 2 * earthRadiusM * Math.asin(Math.min(1, Math.sqrt(a)))
}

/**
 * Rank nearby poster points for a campaign "check". Only active posters are
 * candidates (observations have no lifecycle, removed posters are closed).
 * GPS accuracy is added to the match radius so a coarse fix does not
 * silently miss the poster a few metres away; anything ambiguous is left
 * for the map disambiguation step.
 */
export function rankCheckCandidates(
  points: FieldPoint[],
  position: CheckPosition,
  radiusM: number = CHECK_MATCH_RADIUS_M,
): CheckSelection {
  const candidates: CheckCandidate[] = points
    .filter(
      (point) =>
        point.recordType === 'poster' &&
        point.status === 'active' &&
        point.syncStatus !== 'delete-pending',
    )
    .map((point) => ({
      point,
      distanceM: haversineM(position.lat, position.lng, point.lat, point.lng),
    }))
    .sort((first, second) => first.distanceM - second.distanceM)
  const effectiveRadiusM = radiusM + (position.accuracyM ?? 0)
  const matches = candidates.filter((candidate) => candidate.distanceM <= effectiveRadiusM)
  return { candidates, matches, auto: matches.length === 1 ? matches[0] : null }
}

/**
 * Candidates within this distance are treated as being at the same spot:
 * separate pins there would overlap on a phone screen and only the topmost
 * would be tappable, so they share one stacked marker instead.
 */
export const CHECK_SAME_SPOT_M = 5

export interface CheckSpot {
  lat: number
  lng: number
  candidates: CheckCandidate[]
}

/**
 * Group ranked candidates into spots. Each spot is anchored at the first
 * candidate that created it (the closest one, since input is distance-rank
 * sorted); any other candidate within `sameSpotM` of the anchor joins it.
 * Input order is preserved inside each spot.
 */
export function groupCheckSpots(
  candidates: CheckCandidate[],
  sameSpotM: number = CHECK_SAME_SPOT_M,
): CheckSpot[] {
  const spots: CheckSpot[] = []
  for (const candidate of candidates) {
    const spot = spots.find(
      (existing) =>
        haversineM(existing.lat, existing.lng, candidate.point.lat, candidate.point.lng) <= sameSpotM,
    )
    if (spot) {
      spot.candidates.push(candidate)
    } else {
      spots.push({ lat: candidate.point.lat, lng: candidate.point.lng, candidates: [candidate] })
    }
  }
  return spots
}
