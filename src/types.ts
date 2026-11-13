export type MapRole = 'owner' | 'editor' | 'viewer'

export interface FieldMap {
  id: string
  name: string
  description: string | null
  visibility: 'private' | 'public'
  created_by: string
  current_role?: MapRole | null
  created_at: string
  updated_at: string
}

export interface FieldLayer {
  id: string
  map_id: string
  name: string
  description: string | null
  color: string
  icon: string | null
  sort_order: number
  is_visible_by_default: boolean
  created_at: string
  updated_at: string
}

export interface ApiPhoto {
  id: string
  original_filename: string
  mime_type: string
  size_bytes: number
  width: number
  height: number
  captured_at: string | null
  uploaded_at: string
  url: string
  thumbnail_url: string
}

export interface ApiPoint {
  id: string
  map_id: string
  layer_id: string
  lat: number
  lng: number
  title: string | null
  description: string | null
  created_by: string
  captured_at: string
  created_at: string
  updated_at: string
  client_created_at: string | null
  location_accuracy_m: number | null
  version: number
  photos: ApiPhoto[]
}

export interface ApiChange {
  id: number
  entity_type: string
  entity_id: string
  action: string
  version: number
  actor_id: string
  created_at: string
}

export type SyncStatus = 'synced' | 'pending' | 'conflict' | 'failed' | 'delete-pending'
export type PhotoStatus = 'pending' | 'uploading' | 'failed' | 'synced'

export interface PhotoReference {
  id: string
  filename: string
  status: PhotoStatus
  capturedAt: string | null
}

export interface FieldPoint {
  id: string
  mapId: string
  layerId: string
  lat: number
  lng: number
  title: string
  description: string
  capturedAt: string
  clientCreatedAt: string
  accuracyM: number | null
  author: string
  version: number | null
  syncStatus: SyncStatus
  photos: PhotoReference[]
  serverShadow?: ApiPoint | null
}

export interface StoredPhoto {
  id: string
  pointId: string
  file: Blob
  filename: string
  mimeType: string
  capturedAt: string | null
  status: PhotoStatus
  remoteId?: string
}

export type OperationType = 'create' | 'update' | 'delete' | 'delete-photo'

export interface PendingOperation {
  id: string
  mapId: string
  pointId: string
  type: OperationType
  expectedVersion: number | null
  photoId?: string
  attempts: number
  nextAttemptAt: number
  status: 'pending' | 'conflict' | 'failed'
  createdAt: number
}

export interface SyncCursor {
  mapId: string
  eventId: number
}
