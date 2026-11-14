import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildCampaignPoster,
  CHECK_MATCH_RADIUS_M,
  haversineM,
  rankCheckCandidates,
  type CampaignCapture,
} from './campaign'
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

describe('rankCheckCandidates', () => {
  let pointCounter = 0

  // A point `offsetM` metres north of the check position (1 degree of
  // latitude ≈ 111320 m, close enough for threshold tests).
  function makePointAt(offsetM: number, overrides: Partial<FieldPoint> = {}): FieldPoint {
    pointCounter += 1
    return {
      id: `point-${pointCounter}`,
      mapId: 'map-1',
      layerId: 'layer-1',
      lat: 51.5072 + offsetM / 111320,
      lng: -0.1276,
      title: `Poster ${pointCounter}`,
      description: '',
      recordType: 'poster',
      campaign: '',
      quantity: 1,
      status: 'active',
      lastObservedAt: null,
      removedAt: null,
      removalReason: null,
      removalConfidence: null,
      removalNote: '',
      events: [],
      capturedAt: '2026-11-14T09:00:00.000Z',
      clientCreatedAt: '2026-11-14T09:00:00.000Z',
      accuracyM: 8,
      author: 'local-user',
      version: 1,
      syncStatus: 'synced',
      photos: [],
      ...overrides,
    }
  }

  const position = { lat: 51.5072, lng: -0.1276, accuracyM: 0 }

  it('measures great-circle distances in metres', () => {
    expect(haversineM(51.5072, -0.1276, 51.5072 + 100 / 111320, -0.1276)).toBeGreaterThan(98)
    expect(haversineM(51.5072, -0.1276, 51.5072 + 100 / 111320, -0.1276)).toBeLessThan(102)
    expect(haversineM(51.5072, -0.1276, 51.5072, -0.1276)).toBe(0)
  })

  it('auto-selects the single active poster inside the match radius', () => {
    const near = makePointAt(15)
    const far = makePointAt(120)

    const selection = rankCheckCandidates([far, near], position)

    expect(selection.auto?.point.id).toBe(near.id)
    expect(selection.matches).toHaveLength(1)
    expect(selection.candidates.map((candidate) => candidate.point.id)).toEqual([near.id, far.id])
  })

  it('leaves the choice to the map when two posters are inside the match radius', () => {
    const first = makePointAt(10)
    const second = makePointAt(20)

    const selection = rankCheckCandidates([first, second], position)

    expect(selection.auto).toBeNull()
    expect(selection.matches.map((candidate) => candidate.point.id)).toEqual([first.id, second.id])
  })

  it('reports no matches when the nearest poster is outside the radius', () => {
    const selection = rankCheckCandidates([makePointAt(80)], position)

    expect(selection.auto).toBeNull()
    expect(selection.matches).toEqual([])
    expect(selection.candidates).toHaveLength(1)
  })

  it('adds the GPS accuracy to the match radius', () => {
    const loosePosition = { lat: 51.5072, lng: -0.1276, accuracyM: 20 }
    const wobbly = makePointAt(30)

    expect(rankCheckCandidates([wobbly], loosePosition).matches).toHaveLength(1)
    expect(rankCheckCandidates([wobbly], position).matches).toEqual([])
  })

  it('ignores observations, removed posters, and delete-pending points', () => {
    const excluded = [
      makePointAt(5, { recordType: 'observation' }),
      makePointAt(5, { status: 'removed' }),
      makePointAt(5, { syncStatus: 'delete-pending' }),
    ]

    const selection = rankCheckCandidates(excluded, position)

    expect(selection.candidates).toEqual([])
    expect(selection.auto).toBeNull()
  })

  it('treats a null GPS accuracy as zero extra radius', () => {
    const noAccuracy = { lat: 51.5072, lng: -0.1276, accuracyM: null }
    const outside = makePointAt(40)

    const selection = rankCheckCandidates([outside], noAccuracy)

    expect(selection.matches).toEqual([])
    expect(selection.auto).toBeNull()
    expect(selection.candidates[0].distanceM).toBeGreaterThan(CHECK_MATCH_RADIUS_M)
  })
})
