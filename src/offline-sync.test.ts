import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getLayers } from './api'
import { offlineDb } from './offline-db'
import {
  createLocalPoint,
  deleteCachedLayerData,
  deleteCachedWorkspace,
  deleteLocalPoint,
  initializeWorkspace,
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

function makePoint(overrides: Partial<FieldPoint> = {}): FieldPoint {
  return {
    id: 'point-1',
    mapId: 'map-1',
    layerId: 'layer-1',
    lat: 51.5,
    lng: -0.12,
    title: 'Field note',
    description: '',
    capturedAt: '2026-11-13T10:00:00.000Z',
    clientCreatedAt: '2026-11-13T10:00:00.000Z',
    accuracyM: null,
    author: 'local-user',
    version: null,
    syncStatus: 'pending',
    photos: [],
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
      file: new Blob(['image bytes'], { type: 'image/jpeg' }),
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

  it('removes an unsynced point and its files without sending a delete', async () => {
    const point = makePoint()
    const photo: StoredPhoto = {
      id: 'photo-local-2',
      pointId: point.id,
      file: new Blob(['image bytes'], { type: 'image/jpeg' }),
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
      file: new Blob(['image bytes'], { type: 'image/jpeg' }),
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
      file: new Blob(['image bytes'], { type: 'image/jpeg' }),
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
