import { toRaw } from 'vue'
import {
  ApiError,
  createMap,
  createPoint,
  deletePhoto,
  deletePoint,
  getChanges,
  getLayers,
  getMaps,
  getPhotoBlob,
  getPoint,
  getPoints,
  getMapShareToken,
  getRememberedMapShareToken,
  rememberMapShareToken,
  setMapShareToken,
  toApiPoint,
  updatePoint,
  uploadPhoto,
} from './api'
import { offlineDb } from './offline-db'
import type {
  ApiChange,
  ApiPoint,
  FieldLayer,
  FieldMap,
  FieldPoint,
  PosterEvent,
  PosterEventInput,
  PendingOperation,
  PhotoReference,
  StoredPhoto,
  SyncCursor,
} from './types'

export interface Workspace {
  map: FieldMap
  maps: FieldMap[]
  layers: FieldLayer[]
}

export interface SyncSummary {
  pending: number
  conflicts: number
  failed: number
}

let activeSync: Promise<SyncSummary> | null = null

function isDirty(point: FieldPoint): boolean {
  return point.syncStatus === 'pending'
    || point.syncStatus === 'conflict'
    || point.syncStatus === 'failed'
    || point.syncStatus === 'delete-pending'
}

function fromApiPoint(point: ApiPoint): FieldPoint {
  return {
    id: point.id,
    mapId: point.map_id,
    layerId: point.layer_id,
    lat: point.lat,
    lng: point.lng,
    title: point.title ?? '',
    description: point.description ?? '',
    recordType: point.record_type,
    campaign: point.campaign ?? '',
    quantity: point.quantity,
    status: point.status,
    lastObservedAt: point.last_observed_at,
    removedAt: point.removed_at,
    removalReason: point.removal_reason,
    removalConfidence: point.removal_confidence,
    removalNote: point.removal_note ?? '',
    events: [],
    capturedAt: point.captured_at,
    clientCreatedAt: point.client_created_at ?? point.captured_at,
    accuracyM: point.location_accuracy_m,
    author: point.created_by,
    version: point.version,
    syncStatus: 'synced',
    photos: point.photos.map((photo) => ({
      id: photo.id,
      filename: photo.original_filename,
      status: 'synced',
      capturedAt: photo.captured_at,
    })),
  }
}

function operation(
  mapId: string,
  pointId: string,
  type: PendingOperation['type'],
  expectedVersion: number | null,
  photoId?: string,
  posterEvents?: PosterEventInput[],
): PendingOperation {
  return {
    id: crypto.randomUUID(),
    mapId,
    pointId,
    type,
    expectedVersion,
    photoId,
    posterEvents,
    attempts: 0,
    nextAttemptAt: 0,
    status: 'pending',
    createdAt: Date.now(),
  }
}

/**
 * Unwrap Vue reactive proxies — including nested ones — into plain data.
 * IndexedDB's structuredClone rejects any proxy with a DataCloneError, so
 * everything written to the offline store must pass through this first.
 * Points reach these entry points both as full reactive proxies (straight
 * from a ref) and as plain objects with nested proxy arrays (after
 * spreading a reactive point), so the unwrap is recursive.
 */
function toPlainData<T>(value: T): T {
  const raw = toRaw(value)
  if (raw === null || typeof raw !== 'object') return raw as T
  if (raw instanceof Blob) return raw as T
  if (Array.isArray(raw)) {
    return (raw as unknown[]).map((item) => toPlainData(item)) as T
  }
  if (Object.getPrototypeOf(raw) !== Object.prototype) return raw as T
  const plain: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(raw)) {
    plain[key] = toPlainData(item)
  }
  return plain as T
}

export async function initializeWorkspace(selectedMapId?: string): Promise<Workspace> {
  const cachedMaps = await offlineDb.maps.orderBy('updated_at').reverse().toArray()
  let map = selectedMapId
    ? cachedMaps.find((cachedMap) => cachedMap.id === selectedMapId)
    : cachedMaps[0]
  let availableMaps = cachedMaps

  if (navigator.onLine) {
    try {
      const serverMaps = await getMaps()
      if (selectedMapId) {
        map = serverMaps.find((serverMap) => serverMap.id === selectedMapId)
        if (!map) {
          throw new ApiError('Map is not available', 404, 'Map is not available')
        }
      } else {
        map = serverMaps[0]
      }
      if (!map && !selectedMapId) {
        const created = await createMap('Community survey', 'Shared field observations')
        map = created.map
        setMapShareToken(created.owner_share_token, true)
        rememberMapShareToken(map.id, created.owner_share_token)
        serverMaps.push(map)
      }
      if (!map) throw new Error('No map is available')
      const activeMap = map
      const token = getMapShareToken()
      if (token) rememberMapShareToken(activeMap.id, token)
      availableMaps = [
        ...serverMaps,
        ...cachedMaps.filter((cachedMap) => getRememberedMapShareToken(cachedMap.id)),
      ].filter(
        (candidate, index, all) =>
          all.findIndex((other) => other.id === candidate.id) === index,
      )
      await offlineDb.maps.put(activeMap)
      const layers = await getLayers(activeMap.id)
      await offlineDb.transaction('rw', offlineDb.layers, async () => {
        await offlineDb.layers.where('map_id').equals(activeMap.id).delete()
        await offlineDb.layers.bulkPut(layers)
      })
    } catch (error) {
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        throw error
      }
      if (!map) throw error
    }
  }

  if (!map) throw new Error('Connect once to load or create a map before using it offline')
  const layers = await offlineDb.layers.where('map_id').equals(map.id).sortBy('sort_order')
  if (!layers.length) throw new Error('No cached layers are available for this map')
  return { map, maps: availableMaps, layers }
}

export function getCachedPoints(mapId: string): Promise<FieldPoint[]> {
  return offlineDb.points.where('mapId').equals(mapId).toArray()
}

export async function deleteCachedLayerData(mapId: string, layerId: string): Promise<void> {
  await offlineDb.transaction(
    'rw',
    offlineDb.layers,
    offlineDb.points,
    offlineDb.photos,
    offlineDb.operations,
    async () => {
      const points = await offlineDb.points.where('mapId').equals(mapId).toArray()
      for (const point of points.filter((candidate) => candidate.layerId === layerId)) {
        await offlineDb.points.delete(point.id)
        await offlineDb.photos.where('pointId').equals(point.id).delete()
        await offlineDb.operations.where('pointId').equals(point.id).delete()
      }
      await offlineDb.layers.delete(layerId)
    },
  )
}

export async function deleteCachedWorkspace(mapId: string): Promise<void> {
  await offlineDb.transaction(
    'rw',
    offlineDb.maps,
    offlineDb.layers,
    offlineDb.points,
    offlineDb.photos,
    offlineDb.operations,
    async () => {
      const points = await offlineDb.points.where('mapId').equals(mapId).toArray()
      const operations = await offlineDb.operations.where('mapId').equals(mapId).toArray()
      const pointIds = new Set([
        ...points.map((point) => point.id),
        ...operations.map((item) => item.pointId),
      ])
      for (const pointId of pointIds) {
        await offlineDb.photos.where('pointId').equals(pointId).delete()
      }
      await offlineDb.points.where('mapId').equals(mapId).delete()
      await offlineDb.operations.where('mapId').equals(mapId).delete()
      await offlineDb.layers.where('map_id').equals(mapId).delete()
      await offlineDb.maps.delete(mapId)
    },
  )
  await offlineDb.cursors.delete(mapId)
}

export async function cacheServerPoint(
  apiPoint: ApiPoint,
  options: { forceConflict?: boolean } = {},
): Promise<void> {
  const existing = await offlineDb.points.get(apiPoint.id)
  if (existing && isDirty(existing)) {
    if (options.forceConflict) {
      await offlineDb.transaction('rw', offlineDb.points, offlineDb.operations, async () => {
        await offlineDb.points.put({
          ...existing,
          syncStatus: 'conflict',
          serverShadow: apiPoint,
        })
        const queued = await offlineDb.operations.where('pointId').equals(existing.id).toArray()
        await offlineDb.operations.bulkPut(
          queued.map((item) => ({ ...item, status: 'conflict' as const })),
        )
      })
    }
    return
  }

  const point = fromApiPoint(apiPoint)
  await offlineDb.points.put({ ...point, events: existing?.events ?? [] })
  await cachePhotoBlobs(apiPoint)
}

async function cachePhotoBlobs(apiPoint: ApiPoint): Promise<void> {
  for (const photo of apiPoint.photos) {
    if (await offlineDb.photos.get(photo.id)) continue
    const blob = await getPhotoBlob(photo.url)
    const stored: StoredPhoto = {
      id: photo.id,
      pointId: apiPoint.id,
      file: blob,
      filename: photo.original_filename,
      mimeType: photo.mime_type,
      capturedAt: photo.captured_at,
      status: 'synced',
      remoteId: photo.id,
    }
    await offlineDb.photos.put(stored)
  }
}

export async function fetchPointsInBounds(
  mapId: string,
  bounds: { west: number; south: number; east: number; north: number },
): Promise<void> {
  if (!navigator.onLine) return
  const rows = await getPoints(mapId, bounds)
  for (const row of rows) await cacheServerPoint(row)
}

export async function createLocalPoint(
  point: FieldPoint,
  photos: StoredPhoto[],
): Promise<void> {
  const source = toPlainData(point)
  const plainPhotos = toPlainData(photos)
  const queued = operation(source.mapId, source.id, 'create', null)
  await offlineDb.transaction(
    'rw',
    offlineDb.points,
    offlineDb.photos,
    offlineDb.operations,
    async () => {
      await offlineDb.points.put({ ...source, version: null, syncStatus: 'pending' })
      if (plainPhotos.length) await offlineDb.photos.bulkPut(plainPhotos)
      await offlineDb.operations.put(queued)
    },
  )
}

export async function updateLocalPoint(
  point: FieldPoint,
  addedPhotos: StoredPhoto[],
  removedPhotoIds: string[],
  posterEvent?: PosterEventInput,
): Promise<void> {
  const source = toPlainData(point)
  const plainPhotos = toPlainData(addedPhotos)
  await offlineDb.transaction(
    'rw',
    offlineDb.points,
    offlineDb.photos,
    offlineDb.operations,
    async () => {
      await offlineDb.points.put(source)
      if (plainPhotos.length) await offlineDb.photos.bulkPut(plainPhotos)
      for (const photoId of removedPhotoIds) {
        const photo = await offlineDb.photos.get(photoId)
        if (photo?.remoteId) {
          await offlineDb.operations.put(
            operation(source.mapId, source.id, 'delete-photo', source.version, photo.remoteId),
          )
        }
        await offlineDb.photos.delete(photoId)
      }

      const queued = await offlineDb.operations
        .where('pointId')
        .equals(source.id)
        .toArray()
      const create = queued.find((item) => item.type === 'create' && item.status === 'pending')
      if (create && posterEvent) {
        await offlineDb.operations.put({
          ...create,
          posterEvents: [...(create.posterEvents ?? []), posterEvent],
        })
      } else if (!create && source.version !== null) {
        const update = queued.find((item) => item.type === 'update' && item.status === 'pending')
        if (update) {
          await offlineDb.operations.put({
            ...update,
            expectedVersion: update.expectedVersion ?? source.version,
            posterEvents: posterEvent
              ? [...(update.posterEvents ?? []), posterEvent]
              : update.posterEvents,
          })
        } else {
          await offlineDb.operations.put(
            operation(
              source.mapId,
              source.id,
              'update',
              source.version,
              undefined,
              posterEvent ? [posterEvent] : undefined,
            ),
          )
        }
      }
    },
  )
}

/**
 * Apply a poster lifecycle event to a cached point and queue it for sync.
 * Optional photos (e.g. the camera capture from a campaign check) are stored
 * alongside so the sync pipeline uploads them after the event operation lands.
 */
export async function recordPosterEventLocally(
  point: FieldPoint,
  event: PosterEventInput,
  photos: StoredPhoto[] = [],
): Promise<FieldPoint> {
  if (point.recordType !== 'poster' || point.status !== 'active') {
    throw new Error('Only active poster placements can receive lifecycle events')
  }
  // Unwrap before spreading: a reactive proxy (or a plain object holding
  // nested proxy arrays) would leak proxies into `updated`, which
  // IndexedDB cannot clone (DataCloneError).
  const source = toPlainData(point)
  const updated: FieldPoint = {
    ...source,
    status: event.event_type === 'removed' ? 'removed' : 'active',
    lastObservedAt:
      event.event_type === 'observed' ? event.occurred_at : source.lastObservedAt,
    removedAt: event.event_type === 'removed' ? event.occurred_at : source.removedAt,
    removalReason:
      event.event_type === 'removed' ? event.removal_reason ?? 'unknown' : source.removalReason,
    removalConfidence:
      event.event_type === 'removed'
        ? event.removal_confidence ?? 'unknown'
        : source.removalConfidence,
    removalNote: event.event_type === 'removed' ? event.note ?? '' : source.removalNote,
    photos: [
      ...(source.photos ?? []),
      ...photos.map((stored) => ({
        id: stored.id,
        filename: stored.filename,
        status: 'pending' as const,
        capturedAt: stored.capturedAt,
      })),
    ],
    events: [
      ...(source.events ?? []),
      {
        id: crypto.randomUUID(),
        point_id: source.id,
        event_type: event.event_type,
        occurred_at: event.occurred_at,
        recorded_at: new Date().toISOString(),
        actor_id: source.author,
        removal_reason: event.removal_reason ?? null,
        removal_confidence: event.removal_confidence ?? null,
        note: event.note ?? null,
      },
    ],
    syncStatus: 'pending',
  }
  await updateLocalPoint(updated, photos, [], event)
  return updated
}

export async function deleteLocalPoint(point: FieldPoint): Promise<void> {
  const source = toPlainData(point)
  await offlineDb.transaction(
    'rw',
    offlineDb.points,
    offlineDb.photos,
    offlineDb.operations,
    async () => {
      const queued = await offlineDb.operations.where('pointId').equals(source.id).toArray()
      if (source.version === null || queued.some((item) => item.type === 'create')) {
        await offlineDb.points.delete(source.id)
        await offlineDb.photos.where('pointId').equals(source.id).delete()
        await offlineDb.operations.where('pointId').equals(source.id).delete()
        return
      }
      await offlineDb.points.put({ ...source, syncStatus: 'delete-pending' })
      await offlineDb.operations.where('pointId').equals(source.id).delete()
      await offlineDb.operations.put(
        operation(source.mapId, source.id, 'delete', source.version),
      )
    },
  )
}

function pointWrite(point: FieldPoint): ReturnType<typeof toApiPoint> {
  return toApiPoint(point)
}

async function setConflict(
  item: PendingOperation,
  point: FieldPoint | undefined,
  error: ApiError,
): Promise<void> {
  const detail = error.detail as { point?: ApiPoint } | null
  const shadow = detail?.point
  await offlineDb.transaction('rw', offlineDb.operations, offlineDb.points, async () => {
    await offlineDb.operations.put({ ...item, status: 'conflict' })
    if (point) {
      await offlineDb.points.put({
        ...point,
        syncStatus: 'conflict',
        serverShadow: shadow ?? null,
      })
    }
  })
}

async function setFailed(
  item: PendingOperation,
  point: FieldPoint | undefined,
): Promise<void> {
  await offlineDb.transaction('rw', offlineDb.operations, offlineDb.points, async () => {
    await offlineDb.operations.put({ ...item, status: 'failed' })
    if (point) await offlineDb.points.put({ ...point, syncStatus: 'failed' })
  })
}

async function scheduleRetry(item: PendingOperation): Promise<void> {
  const attempts = item.attempts + 1
  await offlineDb.operations.put({
    ...item,
    attempts,
    nextAttemptAt: Date.now() + Math.min(60_000, 1000 * 2 ** attempts),
  })
}

async function processOperation(item: PendingOperation): Promise<void> {
  const point = await offlineDb.points.get(item.pointId)
  if (!point) {
    await offlineDb.operations.delete(item.id)
    return
  }

  try {
    if (item.type === 'create') {
      const saved = await createPoint(item.mapId, {
        id: point.id,
        layer_id: point.layerId,
        lat: point.lat,
        lng: point.lng,
        title: point.title || null,
        description: point.description || null,
        captured_at: point.capturedAt,
        client_created_at: point.clientCreatedAt,
        location_accuracy_m: point.accuracyM,
        record_type: point.recordType,
        campaign: point.campaign || null,
        quantity: point.quantity,
        status: point.status,
        removed_at: point.removedAt,
        removal_reason: point.removalReason,
        removal_confidence: point.removalConfidence,
        removal_note: point.removalNote || null,
        poster_events: item.posterEvents ?? [],
      })
      await offlineDb.points.put({
        ...fromApiPoint(saved),
        photos: point.photos,
        events: point.events,
      })
    } else if (item.type === 'update') {
      if (item.expectedVersion === null) {
        throw new Error('Queued point update is missing its base version')
      }
      const write = pointWrite(point)
      const saved = await updatePoint(
        write,
        point.version ?? item.expectedVersion,
        item.posterEvents,
      )
      await offlineDb.points.put({
        ...fromApiPoint(saved),
        photos: point.photos,
        events: point.events,
      })
    } else if (item.type === 'delete') {
      if (item.expectedVersion === null) {
        throw new Error('Queued point deletion is missing its base version')
      }
      await deletePoint(item.pointId, point.version ?? item.expectedVersion)
      await offlineDb.points.delete(point.id)
      await offlineDb.photos.where('pointId').equals(point.id).delete()
    } else if (item.type === 'delete-photo' && item.photoId) {
      if (item.expectedVersion === null) {
        throw new Error('Queued photo deletion is missing its point version')
      }
      await deletePhoto(item.photoId, point.version ?? item.expectedVersion)
      const saved = await getPoint(item.pointId)
      await offlineDb.points.put({
        ...fromApiPoint(saved),
        photos: point.photos.filter((photo) => photo.id !== item.photoId),
      })
    }
    await offlineDb.operations.delete(item.id)
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      await setConflict(item, point, error)
      return
    }
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      await setFailed(item, point)
      return
    }
    if (error instanceof TypeError || (error instanceof ApiError && error.status >= 500)) {
      await scheduleRetry(item)
      return
    }
    throw error
  }
}

async function processPhotos(mapId: string): Promise<void> {
  const points = await offlineDb.points.where('mapId').equals(mapId).toArray()
  for (const point of points) {
    if (point.version === null || point.syncStatus === 'conflict' || point.syncStatus === 'delete-pending') {
      continue
    }
    const photos = await offlineDb.photos.where('pointId').equals(point.id).toArray()
    for (const photo of photos) {
      if (photo.status !== 'pending') continue
      await offlineDb.photos.put({ ...photo, status: 'uploading' })
      try {
        const result = await uploadPhoto(
          point.id,
          photo.file,
          photo.filename,
          photo.capturedAt,
          point.version,
        )
        const updatedPoint: FieldPoint = {
          ...point,
          version: result.point_version,
          photos: point.photos.map((ref) =>
            ref.id === photo.id
              ? { ...ref, id: result.id, status: 'synced' }
              : ref,
          ),
        }
        const stored: StoredPhoto = {
          ...photo,
          id: result.id,
          status: 'synced',
          remoteId: result.id,
        }
        await offlineDb.transaction('rw', offlineDb.points, offlineDb.photos, async () => {
          await offlineDb.photos.delete(photo.id)
          await offlineDb.photos.put(stored)
          await offlineDb.points.put(updatedPoint)
        })
        Object.assign(point, updatedPoint)
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          const item = operation(mapId, point.id, 'update', point.version)
          await setConflict(item, point, error)
          await offlineDb.photos.put({ ...photo, status: 'failed' })
          continue
        }
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          await offlineDb.photos.put({ ...photo, status: 'failed' })
          continue
        }
        if (error instanceof TypeError || (error instanceof ApiError && error.status >= 500)) {
          await offlineDb.photos.put({ ...photo, status: 'pending' })
          continue
        }
        throw error
      }
    }
  }
}

async function applyChange(change: ApiChange): Promise<void> {
  if (change.entity_type !== 'point') return
  const local = await offlineDb.points.get(change.entity_id)
  if (change.action === 'deleted') {
    if (local && isDirty(local)) {
      await offlineDb.points.put({
        ...local,
        syncStatus: 'conflict',
        serverShadow: null,
      })
      const queued = await offlineDb.operations.where('pointId').equals(local.id).toArray()
      await offlineDb.operations.bulkPut(queued.map((item) => ({ ...item, status: 'conflict' as const })))
    } else {
      await offlineDb.points.delete(change.entity_id)
      await offlineDb.photos.where('pointId').equals(change.entity_id).delete()
    }
    return
  }

  try {
    const current = await getPoint(change.entity_id)
    await cacheServerPoint(current, {
      forceConflict: Boolean(local && isDirty(local) && change.actor_id !== local.author),
    })
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      await offlineDb.points.delete(change.entity_id)
      await offlineDb.photos.where('pointId').equals(change.entity_id).delete()
      return
    }
    throw error
  }
}

async function pollChanges(mapId: string): Promise<void> {
  const cursor: SyncCursor | undefined = await offlineDb.cursors.get(mapId)
  let afterId = cursor?.eventId ?? 0
  while (true) {
    const changes = await getChanges(mapId, afterId)
    if (!changes.length) break
    for (const change of changes) {
      await applyChange(change)
      afterId = change.id
      await offlineDb.cursors.put({ mapId, eventId: afterId })
    }
    if (changes.length < 500) break
  }
}

export function syncMap(mapId: string): Promise<SyncSummary> {
  if (activeSync) return activeSync
  activeSync = (async () => {
    if (!navigator.onLine) return getSyncSummary(mapId)
    const queued = await offlineDb.operations
      .where('mapId')
      .equals(mapId)
      .sortBy('createdAt')
    for (const item of queued) {
      if (item.status === 'pending' && item.nextAttemptAt <= Date.now()) {
        await processOperation(item)
      }
    }
    await processPhotos(mapId)
    await pollChanges(mapId)
    return getSyncSummary(mapId)
  })()
  return activeSync.finally(() => {
    activeSync = null
  })
}

export async function getSyncSummary(mapId: string): Promise<SyncSummary> {
  const points = await offlineDb.points.where('mapId').equals(mapId).toArray()
  const operations = await offlineDb.operations.where('mapId').equals(mapId).toArray()
  const photos = await Promise.all(
    points.map((point) => offlineDb.photos.where('pointId').equals(point.id).toArray()),
  )
  const photoPending = photos.flat().filter((photo) => photo.status !== 'synced').length
  return {
    pending: operations.filter((item) => item.status === 'pending').length + photoPending,
    conflicts: points.filter((point) => point.syncStatus === 'conflict').length,
    failed:
      operations.filter((item) => item.status === 'failed').length +
      photos.flat().filter((photo) => photo.status === 'failed').length,
  }
}

export async function keepLocalVersion(pointId: string): Promise<void> {
  const point = await offlineDb.points.get(pointId)
  if (!point || point.syncStatus !== 'conflict') return
  const queued = await offlineDb.operations.where('pointId').equals(pointId).toArray()
  await offlineDb.operations.bulkDelete(queued.map((item) => item.id))

  if (point.serverShadow) {
    await cachePhotoBlobs(point.serverShadow)
    const baseVersion = point.serverShadow.version
    const serverPhotos = fromApiPoint(point.serverShadow).photos
    const mergedPhotos = [
      ...serverPhotos,
      ...point.photos.filter((photo) => !serverPhotos.some((remote) => remote.id === photo.id)),
    ]
    await offlineDb.points.put({
      ...point,
      version: baseVersion,
      photos: mergedPhotos,
      syncStatus: 'pending',
      serverShadow: undefined,
    })
    await offlineDb.operations.put(
      operation(point.mapId, point.id, 'update', baseVersion),
    )
    return
  }

  const newId = crypto.randomUUID()
  const existingPhotos = await offlineDb.photos.where('pointId').equals(point.id).toArray()
  const refIds = new Map(
    existingPhotos
      .filter((photo) => photo.remoteId)
      .map((photo) => [photo.id, crypto.randomUUID()]),
  )
  const newRefs = point.photos.map((photo) => {
    const nextId = refIds.get(photo.id)
    return nextId ? { ...photo, id: nextId, status: 'pending' as const } : photo
  })
  await offlineDb.transaction('rw', offlineDb.points, offlineDb.photos, offlineDb.operations, async () => {
    await offlineDb.points.delete(point.id)
    await offlineDb.points.put({
      ...point,
      id: newId,
      version: null,
      syncStatus: 'pending',
      photos: newRefs,
      serverShadow: undefined,
    })
    await offlineDb.photos.bulkPut(
      existingPhotos.map((photo) => ({
        ...photo,
        id: refIds.get(photo.id) ?? photo.id,
        pointId: newId,
        status: photo.remoteId ? 'pending' : photo.status,
        remoteId: undefined,
      })),
    )
    await offlineDb.photos.where('pointId').equals(point.id).delete()
    await offlineDb.operations.put(operation(point.mapId, newId, 'create', null))
  })
}

export async function useServerVersion(pointId: string): Promise<void> {
  const point = await offlineDb.points.get(pointId)
  if (!point || point.syncStatus !== 'conflict') return
  const queued = await offlineDb.operations.where('pointId').equals(pointId).toArray()
  await offlineDb.operations.bulkDelete(queued.map((item) => item.id))
  if (!point.serverShadow) {
    await offlineDb.points.delete(pointId)
    await offlineDb.photos.where('pointId').equals(pointId).delete()
    return
  }
  await cachePhotoBlobs(point.serverShadow)
  const serverPoint = fromApiPoint(point.serverShadow)
  const keptIds = new Set(serverPoint.photos.map((photo) => photo.id))
  const localPhotos = await offlineDb.photos.where('pointId').equals(pointId).toArray()
  await offlineDb.photos.bulkDelete(
    localPhotos.filter((photo) => !keptIds.has(photo.id)).map((photo) => photo.id),
  )
  await offlineDb.points.put(serverPoint)
}

export async function retryFailedPhoto(photoId: string): Promise<void> {
  const photo = await offlineDb.photos.get(photoId)
  if (photo?.status === 'failed') {
    await offlineDb.photos.put({ ...photo, status: 'pending' })
  }
}

export async function retryPointOperation(pointId: string): Promise<void> {
  const point = await offlineDb.points.get(pointId)
  const queued = await offlineDb.operations.where('pointId').equals(pointId).toArray()
  await offlineDb.operations.bulkPut(
    queued.map((item) => ({
      ...item,
      status: 'pending' as const,
      attempts: 0,
      nextAttemptAt: 0,
    })),
  )
  if (point?.syncStatus === 'failed') {
    await offlineDb.points.put({ ...point, syncStatus: 'pending' })
  }
}
