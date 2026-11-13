import type { ApiChange, ApiPoint, FieldLayer, FieldMap } from './types'

const apiRoot = import.meta.env.VITE_API_URL ?? '/api'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

function requestHeaders(initial?: HeadersInit): Headers {
  const headers = new Headers(initial)
  if (import.meta.env.DEV) {
    headers.set('X-Dev-User', import.meta.env.VITE_DEV_USER ?? 'local-user')
  }
  return headers
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = requestHeaders(init.headers)
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const response = await fetch(`${apiRoot}${path}`, { ...init, headers })
  if (!response.ok) {
    let detail: unknown = response.statusText
    try {
      detail = (await response.json()).detail ?? detail
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
    }
    throw new ApiError(
      typeof detail === 'string' ? detail : `Request failed (${response.status})`,
      response.status,
      detail,
    )
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export function getMaps(): Promise<FieldMap[]> {
  return request('/maps')
}

export function createMap(name: string, description: string): Promise<FieldMap> {
  return request('/maps', {
    method: 'POST',
    body: JSON.stringify({ name, description }),
  })
}

export function getLayers(mapId: string): Promise<FieldLayer[]> {
  return request(`/maps/${mapId}/layers`)
}

export function getPoints(
  mapId: string,
  bounds?: { west: number; south: number; east: number; north: number },
): Promise<ApiPoint[]> {
  const params = new URLSearchParams()
  if (bounds) {
    params.set('min_lng', String(bounds.west))
    params.set('min_lat', String(bounds.south))
    params.set('max_lng', String(bounds.east))
    params.set('max_lat', String(bounds.north))
  }
  params.set('limit', '500')
  return request(`/maps/${mapId}/points?${params}`)
}

export function createPoint(
  mapId: string,
  point: Pick<
    ApiPoint,
    | 'id'
    | 'layer_id'
    | 'lat'
    | 'lng'
    | 'title'
    | 'description'
    | 'captured_at'
    | 'client_created_at'
    | 'location_accuracy_m'
  >,
): Promise<ApiPoint> {
  return request(`/maps/${mapId}/points`, {
    method: 'POST',
    body: JSON.stringify(point),
  })
}

export function updatePoint(
  point: Pick<
    ApiPoint,
    'id' | 'layer_id' | 'lat' | 'lng' | 'title' | 'description' | 'captured_at' | 'location_accuracy_m'
  >,
  expectedVersion: number,
): Promise<ApiPoint> {
  const { layer_id, lat, lng, title, description, captured_at, location_accuracy_m } = point
  return request(`/points/${point.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      expected_version: expectedVersion,
      layer_id,
      lat,
      lng,
      title,
      description,
      captured_at,
      location_accuracy_m,
    }),
  })
}

export function deletePoint(pointId: string, expectedVersion: number): Promise<void> {
  return request(`/points/${pointId}?expected_version=${expectedVersion}`, { method: 'DELETE' })
}

export function uploadPhoto(
  pointId: string,
  file: Blob,
  filename: string,
  capturedAt: string | null,
  expectedVersion: number,
): Promise<{ id: string; point_version: number }> {
  const form = new FormData()
  form.append('file', file, filename)
  form.append('expected_version', String(expectedVersion))
  if (capturedAt) form.append('captured_at', capturedAt)
  return request(`/points/${pointId}/photos`, { method: 'POST', body: form })
}

export function deletePhoto(photoId: string, expectedVersion: number): Promise<void> {
  return request(`/photos/${photoId}?expected_version=${expectedVersion}`, { method: 'DELETE' })
}

export function getChanges(mapId: string, afterId: number): Promise<ApiChange[]> {
  return request(`/maps/${mapId}/changes?after_id=${afterId}&limit=500`)
}

export function getPoint(pointId: string): Promise<ApiPoint> {
  return request(`/points/${pointId}`)
}

export async function getPhotoBlob(url: string): Promise<Blob> {
  const response = await fetch(new URL(url, new URL(apiRoot, window.location.origin)).toString(), {
    headers: requestHeaders(),
  })
  if (!response.ok) {
    throw new ApiError(`Photo request failed (${response.status})`, response.status, null)
  }
  return response.blob()
}

export function toApiPoint(
  point: import('./types').FieldPoint,
): Pick<
  ApiPoint,
  | 'id'
  | 'map_id'
  | 'layer_id'
  | 'lat'
  | 'lng'
  | 'title'
  | 'description'
  | 'created_by'
  | 'captured_at'
  | 'client_created_at'
  | 'location_accuracy_m'
  | 'version'
  | 'photos'
> {
  return {
    id: point.id,
    map_id: point.mapId,
    layer_id: point.layerId,
    lat: point.lat,
    lng: point.lng,
    title: point.title || null,
    description: point.description || null,
    created_by: point.author,
    captured_at: point.capturedAt,
    client_created_at: point.clientCreatedAt,
    location_accuracy_m: point.accuracyM,
    version: point.version ?? 1,
    photos: [],
  }
}
