import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { offlineDb } from './offline-db'
import { createLocalPoint, deleteLocalPoint, updateLocalPoint } from './offline-sync'
import type { FieldPoint, StoredPhoto } from './types'

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
})
