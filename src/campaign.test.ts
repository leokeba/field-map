import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildCampaignPoster, type CampaignCapture } from './campaign'
import { offlineDb } from './offline-db'
import { createLocalPoint, updateLocalPoint } from './offline-sync'
import type { FieldPoint, StoredPhoto } from './types'

function makeCapture(overrides: Partial<CampaignCapture> = {}): CampaignCapture {
  return {
    mapId: 'map-1',
    layerId: 'layer-1',
    lat: 51.5072,
    lng: -0.1276,
    accuracyM: 8,
    capturedAt: '2026-11-14T09:30:00.000Z',
    author: 'local-user',
    file: new File(['jpeg bytes'], 'poster-2026-11-14-09-30-00-000Z.jpg', { type: 'image/jpeg' }),
    ...overrides,
  }
}

describe('buildCampaignPoster', () => {
  it('builds an active poster point with a placed event and no title or campaign', () => {
    const { point } = buildCampaignPoster(makeCapture())

    expect(point).toMatchObject({
      mapId: 'map-1',
      layerId: 'layer-1',
      lat: 51.5072,
      lng: -0.1276,
      recordType: 'poster',
      campaign: '',
      quantity: 1,
      status: 'active',
      title: '',
      description: '',
      capturedAt: '2026-11-14T09:30:00.000Z',
      lastObservedAt: '2026-11-14T09:30:00.000Z',
      removedAt: null,
      removalReason: null,
      removalConfidence: null,
      removalNote: '',
      accuracyM: 8,
      author: 'local-user',
      version: null,
      syncStatus: 'pending',
    })
    expect(point.id).toEqual(expect.any(String))
    expect(point.events).toHaveLength(1)
    expect(point.events[0]).toMatchObject({
      point_id: point.id,
      event_type: 'placed',
      occurred_at: point.capturedAt,
      actor_id: 'local-user',
      removal_reason: null,
      removal_confidence: null,
      note: null,
    })
  })

  it('keeps a null accuracy when the GPS fix has no reported precision', () => {
    const { point } = buildCampaignPoster(makeCapture({ accuracyM: null }))

    expect(point.accuracyM).toBeNull()
  })

  it('links the stored photo to the point as a pending upload', () => {
    const capture = makeCapture()
    const { point, photo } = buildCampaignPoster(capture)

    expect(point.photos).toEqual([
      { id: photo.id, filename: capture.file.name, status: 'pending', capturedAt: capture.capturedAt },
    ])
    expect(photo).toMatchObject({
      pointId: point.id,
      file: capture.file,
      filename: capture.file.name,
      mimeType: 'image/jpeg',
      capturedAt: capture.capturedAt,
      status: 'pending',
    })
  })
})

describe('campaign poster offline queue', () => {
  beforeEach(async () => {
    await offlineDb.delete()
    await offlineDb.open()
  })

  it('persists a campaign point and photo with an idempotent create operation', async () => {
    const { point, photo } = buildCampaignPoster(makeCapture())

    await createLocalPoint(point, [photo])

    expect(await offlineDb.points.get(point.id)).toMatchObject({
      mapId: point.mapId,
      layerId: point.layerId,
      recordType: 'poster',
      status: 'active',
      syncStatus: 'pending',
      version: null,
    })
    expect(await offlineDb.photos.get(photo.id)).toMatchObject({
      pointId: point.id,
      status: 'pending',
      mimeType: 'image/jpeg',
    })
    expect(await offlineDb.operations.where('pointId').equals(point.id).toArray()).toMatchObject([
      { type: 'create', status: 'pending', expectedVersion: null },
    ])
  })

  it('leaves the queued poster editable through the normal offline update flow', async () => {
    const { point } = buildCampaignPoster(makeCapture())
    await createLocalPoint(point, [])

    const updated: FieldPoint = { ...point, title: 'Main street pole', syncStatus: 'pending' }
    await updateLocalPoint(updated, [], [])

    expect(await offlineDb.points.get(point.id)).toMatchObject({ title: 'Main street pole' })
    expect(await offlineDb.operations.where('pointId').equals(point.id).toArray()).toMatchObject([
      { type: 'create', status: 'pending' },
    ])
  })

  it('exposes the captured file for the photo sync pipeline', async () => {
    const capture = makeCapture()
    const { point, photo }: { point: FieldPoint; photo: StoredPhoto } = buildCampaignPoster(capture)
    await createLocalPoint(point, [photo])

    const stored = await offlineDb.photos.get(photo.id)
    // IndexedDB round-trips a File as a Blob; assert on the content, not identity.
    expect(stored?.file).toBeInstanceOf(Blob)
    expect(stored?.file).toMatchObject({ size: capture.file.size, type: capture.file.type })
  })
})
