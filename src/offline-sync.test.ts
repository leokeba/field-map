import 'fake-indexeddb/auto'
import { reactive } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getLayers } from './api'
import { offlineDb } from './offline-db'
import {
  createLocalPoint,
  deleteCachedLayerData,
  deleteCachedWorkspace,
  deleteLocalPoint,
  initializeWorkspace,
  recordPosterEventLocally,
  updateLocalPoint,
} from './offline-sync'
import type { FieldLayer, FieldMap, FieldPoint, StoredPhoto } from './types'

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    getLayers: vi.fn(),
  }
})

// Node < 21 has no global `navigator`; provide one so the tests below can redefine navigator.onLine.
if (typeof navigator === 'undefined') {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
}

// IndexedDB stores photo bytes as base64 strings, never Blobs.
const IMAGE_BYTES_B64 = 'aW1hZ2UgYnl0ZXM=' // base64("image bytes")
const CAMERA_FRAME_B64 = 'Y2FtZXJhIGZyYW1l' // base64("camera frame")

function makePoint(overrides: Partial<FieldPoint> = {}): FieldPoint {
  return {
    id: 'point-1',
    mapId: 'map-1',
    layerId: 'layer-1',
    lat: 51.5,
    lng: -0.12,
    recordType: 'poster',
    campaign: '',
    quantity: 1,
    status: 'active',
    lastObservedAt: null,
    removedAt: null,
    removalReason: null,
    removalConfidence: null,
    removalNote: '',
    title: 'Field note',
    description: '',
    capturedAt: '2026-11-13T10:00:00.000Z',
    clientCreatedAt: '2026-11-13T10:00:00.000Z',
    accuracyM: null,
    author: 'local-user',
    version: null,
    syncStatus: 'pending',
    photos: [],
    events: [],
    ...overrides,
  }
}

describe('offline point queue', () => {
  beforeEach(async () => {
    vi.unstubAllGlobals()
    vi.mocked(getLayers).mockReset()
    await offlineDb.delete()
    await offlineDb.open()
  })

  it('persists a new point, photo blob, and idempotent create operation together', async () => {
    const point = makePoint()
    const photo: StoredPhoto = {
      id: 'photo-local-1',
      pointId: point.id,
      fileData: IMAGE_BYTES_B64,
      filename: 'field.jpg',
      mimeType: 'image/jpeg',
      capturedAt: null,
      status: 'pending',
    }

    await createLocalPoint(point, [photo])

    expect(await offlineDb.points.get(point.id)).toMatchObject({
      mapId: point.mapId,
      syncStatus: 'pending',
      version: null,
    })
    expect(await offlineDb.photos.get(photo.id)).toMatchObject({
      pointId: point.id,
      status: 'pending',
    })
    expect(await offlineDb.operations.where('pointId').equals(point.id).toArray()).toMatchObject([
      { type: 'create', status: 'pending', expectedVersion: null },
    ])
  })

  it('coalesces repeated edits against the original server version', async () => {
    const point = makePoint({ version: 4, syncStatus: 'synced' })
    await offlineDb.points.put(point)

    await updateLocalPoint({ ...point, title: 'First edit', syncStatus: 'pending' }, [], [])
    await updateLocalPoint({ ...point, title: 'Latest edit', syncStatus: 'pending' }, [], [])

    const operations = await offlineDb.operations.where('pointId').equals(point.id).toArray()
    expect(operations).toHaveLength(1)
    expect(operations[0]).toMatchObject({
      type: 'update',
      expectedVersion: 4,
      status: 'pending',
    })
  })

  it('queues poster removal details with an offline point update', async () => {
    const point = makePoint({ version: 3, syncStatus: 'synced' })
    await offlineDb.points.put(point)

    const updated = await recordPosterEventLocally(point, {
      event_type: 'removed',
      occurred_at: '2026-11-14T08:30:00.000Z',
      removal_reason: 'suspected_opposition',
      removal_confidence: 'suspected',
      note: 'Poster was gone during a routine check.',
    })

    expect(updated.status).toBe('removed')
    expect(updated.removedAt).toBe('2026-11-14T08:30:00.000Z')
    expect(await offlineDb.operations.where('pointId').equals(point.id).toArray()).toMatchObject([
      {
        type: 'update',
        expectedVersion: 3,
        posterEvents: [{ event_type: 'removed', removal_reason: 'suspected_opposition' }],
      },
    ])
  })

  it('queues a check event and its camera photo in one offline operation', async () => {
    const point = makePoint({ version: 2, syncStatus: 'synced' })
    await offlineDb.points.put(point)
    const photo: StoredPhoto = {
      id: 'photo-check-1',
      pointId: point.id,
      fileData: CAMERA_FRAME_B64,
      filename: 'poster-check.jpg',
      mimeType: 'image/jpeg',
      capturedAt: '2026-11-14T09:00:00.000Z',
      status: 'pending',
    }

    const updated = await recordPosterEventLocally(
      point,
      {
        event_type: 'observed',
        occurred_at: '2026-11-14T09:00:00.000Z',
        note: 'Still up during campaign check.',
      },
      [photo],
    )

    expect(updated.status).toBe('active')
    expect(updated.lastObservedAt).toBe('2026-11-14T09:00:00.000Z')
    expect(updated.events).toHaveLength(1)
    expect(await offlineDb.photos.get(photo.id)).toMatchObject({
      pointId: point.id,
      status: 'pending',
    })
    const operations = await offlineDb.operations.where('pointId').equals(point.id).toArray()
    expect(operations).toHaveLength(1)
    expect(operations[0]).toMatchObject({
      type: 'update',
      expectedVersion: 2,
      posterEvents: [{ event_type: 'observed' }],
    })
  })

  it('records a check event from a reactive point without a DataCloneError', async () => {
    // The campaign check flow hands over `checkTarget.value`, a deeply
    // reactive proxy of a cached point. IndexedDB cannot clone proxies, so
    // the store must unwrap before writing. The fixture mirrors a real
    // cached poster: an existing photo reference, a placed event, and a
    // serverShadow — the nested objects that leak as proxies when the
    // point is spread.
    const point = reactive(
      makePoint({
        version: 2,
        syncStatus: 'synced',
        photos: [
          {
            id: 'photo-1',
            filename: 'original.jpg',
            status: 'synced',
            capturedAt: '2026-11-13T10:00:00.000Z',
          },
        ],
        events: [
          {
            id: 'event-1',
            point_id: 'point-1',
            event_type: 'placed',
            occurred_at: '2026-11-13T10:00:00.000Z',
            recorded_at: '2026-11-13T10:00:00.000Z',
            actor_id: 'local-user',
            removal_reason: null,
            removal_confidence: null,
            note: null,
          },
        ],
        serverShadow: {
          id: 'point-1',
          map_id: 'map-1',
          layer_id: 'layer-1',
          lat: 51.5,
          lng: -0.12,
          title: 'Field note',
          description: '',
          record_type: 'poster',
          campaign: '',
          quantity: 1,
          status: 'active',
          last_observed_at: '2026-11-13T10:00:00.000Z',
          removed_at: null,
          removal_reason: null,
          removal_confidence: null,
          removal_note: '',
          created_by: 'local-user',
          captured_at: '2026-11-13T10:00:00.000Z',
          created_at: '2026-11-13T10:00:00.000Z',
          updated_at: '2026-11-13T10:00:00.000Z',
          client_created_at: null,
          location_accuracy_m: null,
          version: 2,
          photos: [],
        },
      }),
    )
    const photo: StoredPhoto = {
      id: 'photo-check-2',
      pointId: point.id,
      fileData: CAMERA_FRAME_B64,
      filename: 'poster-check.jpg',
      mimeType: 'image/jpeg',
      capturedAt: '2026-11-14T09:00:00.000Z',
      status: 'pending',
    }

    const updated = await recordPosterEventLocally(
      point,
      { event_type: 'observed', occurred_at: '2026-11-14T09:00:00.000Z' },
      [photo],
    )

    expect(updated.lastObservedAt).toBe('2026-11-14T09:00:00.000Z')
    expect(updated.photos).toEqual([
      {
        id: 'photo-1',
        filename: 'original.jpg',
        status: 'synced',
        capturedAt: '2026-11-13T10:00:00.000Z',
      },
      {
        id: photo.id,
        filename: photo.filename,
        status: 'pending',
        capturedAt: photo.capturedAt,
      },
    ])
    expect(updated.events).toHaveLength(2)
    expect(updated.events?.[1]).toMatchObject({
      event_type: 'observed',
      occurred_at: '2026-11-14T09:00:00.000Z',
    })
    const stored = await offlineDb.points.get(point.id)
    expect(stored?.syncStatus).toBe('pending')
    expect(stored?.photos).toEqual(updated.photos)
    expect(stored?.events).toHaveLength(2)
    expect(await offlineDb.photos.get(photo.id)).toMatchObject({ status: 'pending' })
  })

  it('updates a plain point that still holds nested reactive arrays', async () => {
    // The point editor spreads a reactive point from `points.value` into a
    // fresh object: plain at the top level, but `events` and `photos` are
    // still reactive proxies. The boundary must unwrap those too.
    const reactivePoint = reactive(makePoint({ version: 3, syncStatus: 'synced' }))
    const edited: FieldPoint = { ...reactivePoint, title: 'Edited title', syncStatus: 'pending' }

    await updateLocalPoint(edited, [], [])

    const stored = await offlineDb.points.get(edited.id)
    expect(stored?.title).toBe('Edited title')
    expect(stored?.syncStatus).toBe('pending')
    const operations = await offlineDb.operations.where('pointId').equals(edited.id).toArray()
    expect(operations).toHaveLength(1)
    expect(operations[0].type).toBe('update')
  })

  it('queues follow-up observations and updates the latest observation time', async () => {
    const point = makePoint({ version: 2, syncStatus: 'synced' })
    await offlineDb.points.put(point)

    const updated = await recordPosterEventLocally(point, {
      event_type: 'observed',
      occurred_at: '2026-11-14T08:30:00.000Z',
      note: 'Still visible.',
    })

    expect(updated.lastObservedAt).toBe('2026-11-14T08:30:00.000Z')
    expect(await offlineDb.operations.where('pointId').equals(point.id).toArray()).toMatchObject([
      {
        type: 'update',
        posterEvents: [{ event_type: 'observed', note: 'Still visible.' }],
      },
    ])
  })

  it('keeps offline removal with a point that has not synced yet', async () => {
    const point = makePoint()
    await createLocalPoint(point, [])

    await recordPosterEventLocally(point, {
      event_type: 'removed',
      occurred_at: '2026-11-14T08:30:00.000Z',
      removal_reason: 'unknown',
      removal_confidence: 'unknown',
    })

    expect(await offlineDb.operations.where('pointId').equals(point.id).toArray()).toMatchObject([
      {
        type: 'create',
        posterEvents: [{ event_type: 'removed', removal_reason: 'unknown' }],
      },
    ])
    expect((await offlineDb.points.get(point.id))?.status).toBe('removed')
  })

  it('removes an unsynced point and its files without sending a delete', async () => {
    const point = makePoint()
    const photo: StoredPhoto = {
      id: 'photo-local-2',
      pointId: point.id,
      fileData: IMAGE_BYTES_B64,
      filename: 'queued.jpg',
      mimeType: 'image/jpeg',
      capturedAt: null,
      status: 'pending',
    }
    await createLocalPoint(point, [photo])

    await deleteLocalPoint(point)

    expect(await offlineDb.points.get(point.id)).toBeUndefined()
    expect(await offlineDb.photos.get(photo.id)).toBeUndefined()
    expect(await offlineDb.operations.where('pointId').equals(point.id).count()).toBe(0)
  })

  it('clears a deleted layer and its cached points, photos, and queued operations', async () => {
    const point = makePoint({ layerId: 'deleted-layer' })
    const otherPoint = makePoint({ id: 'point-2', layerId: 'remaining-layer' })
    const photo: StoredPhoto = {
      id: 'photo-for-deleted-layer',
      pointId: point.id,
      fileData: IMAGE_BYTES_B64,
      filename: 'queued.jpg',
      mimeType: 'image/jpeg',
      capturedAt: null,
      status: 'pending',
    }
    await offlineDb.layers.bulkPut([
      {
        id: 'deleted-layer',
        map_id: point.mapId,
        name: 'Deleted layer',
        description: null,
        color: '#318b69',
        icon: null,
        sort_order: 0,
        is_visible_by_default: true,
        created_at: point.capturedAt,
        updated_at: point.capturedAt,
      },
      {
        id: 'remaining-layer',
        map_id: point.mapId,
        name: 'Remaining layer',
        description: null,
        color: '#318b69',
        icon: null,
        sort_order: 1,
        is_visible_by_default: true,
        created_at: point.capturedAt,
        updated_at: point.capturedAt,
      },
    ])
    await createLocalPoint(point, [photo])
    await createLocalPoint(otherPoint, [])

    await deleteCachedLayerData(point.mapId, 'deleted-layer')

    expect(await offlineDb.layers.get('deleted-layer')).toBeUndefined()
    expect(await offlineDb.layers.get('remaining-layer')).toBeDefined()
    expect(await offlineDb.points.get(point.id)).toBeUndefined()
    expect(await offlineDb.photos.get(photo.id)).toBeUndefined()
    expect(await offlineDb.operations.where('pointId').equals(point.id).count()).toBe(0)
    expect(await offlineDb.points.get(otherPoint.id)).toBeDefined()
  })

  it('clears all cached data for a deleted map', async () => {
    const point = makePoint()
    const photo: StoredPhoto = {
      id: 'photo-for-deleted-map',
      pointId: point.id,
      fileData: IMAGE_BYTES_B64,
      filename: 'queued.jpg',
      mimeType: 'image/jpeg',
      capturedAt: null,
      status: 'pending',
    }
    const map: FieldMap = {
      id: point.mapId,
      name: 'Field map',
      description: null,
      visibility: 'private',
      created_by: 'local-user',
      current_role: 'owner',
      created_at: point.capturedAt,
      updated_at: point.capturedAt,
    }
    await offlineDb.maps.put(map)
    await offlineDb.layers.put({
      id: point.layerId,
      map_id: point.mapId,
      name: 'Observations',
      description: null,
      color: '#318b69',
      icon: null,
      sort_order: 0,
      is_visible_by_default: true,
      created_at: point.capturedAt,
      updated_at: point.capturedAt,
    })
    await createLocalPoint(point, [photo])
    await offlineDb.cursors.put({ mapId: map.id, eventId: 7 })

    await deleteCachedWorkspace(map.id)

    expect(await offlineDb.maps.get(map.id)).toBeUndefined()
    expect(await offlineDb.layers.count()).toBe(0)
    expect(await offlineDb.points.count()).toBe(0)
    expect(await offlineDb.photos.count()).toBe(0)
    expect(await offlineDb.operations.count()).toBe(0)
    expect(await offlineDb.cursors.count()).toBe(0)
  })

  it('does not fall back to cached private data after link authentication fails', async () => {
    await offlineDb.maps.put({
      id: 'private-map',
      name: 'Private map',
      description: null,
      visibility: 'private',
      created_by: 'anonymous',
      current_role: 'owner',
      created_at: '2026-11-13T10:00:00.000Z',
      updated_at: '2026-11-13T10:00:00.000Z',
    })
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: 'Invalid private map link' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )

    await expect(initializeWorkspace()).rejects.toMatchObject({ status: 401 })
  })

  it('removes layers from the offline cache when they are absent from the server', async () => {
    const map: FieldMap = {
      id: 'map-1',
      name: 'Field map',
      description: null,
      visibility: 'private',
      created_by: 'local-user',
      current_role: 'owner',
      created_at: '2026-11-13T10:00:00.000Z',
      updated_at: '2026-11-13T10:00:00.000Z',
    }
    const staleLayer: FieldLayer = {
      id: 'deleted-layer',
      map_id: map.id,
      name: 'Deleted layer',
      description: null,
      color: '#318b69',
      icon: null,
      sort_order: 0,
      is_visible_by_default: true,
      created_at: map.created_at,
      updated_at: map.updated_at,
    }
    const serverLayer = { ...staleLayer, id: 'remaining-layer', name: 'Remaining layer' }
    await offlineDb.maps.put(map)
    await offlineDb.layers.put(staleLayer)
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify([map]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    vi.mocked(getLayers).mockResolvedValue([serverLayer])

    const workspace = await initializeWorkspace(map.id)

    expect(workspace.layers).toEqual([serverLayer])
    expect(await offlineDb.layers.where('map_id').equals(map.id).toArray()).toEqual([serverLayer])
  })
})
