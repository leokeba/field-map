import Dexie, { type Table } from 'dexie'
import type {
  FieldLayer,
  FieldMap,
  FieldPoint,
  PendingOperation,
  StoredPhoto,
  SyncCursor,
} from './types'

class FieldMapDatabase extends Dexie {
  maps!: Table<FieldMap, string>
  layers!: Table<FieldLayer, string>
  points!: Table<FieldPoint, string>
  photos!: Table<StoredPhoto, string>
  operations!: Table<PendingOperation, string>
  cursors!: Table<SyncCursor, string>

  constructor() {
    super('field-map')
    this.version(1).stores({
      maps: 'id, updated_at',
      layers: 'id, map_id',
      points: 'id, mapId, syncStatus',
      photos: 'id, pointId, status',
      operations: 'id, mapId, pointId, createdAt, status, nextAttemptAt',
      cursors: 'mapId',
    })
    this.version(2)
      .stores({
        maps: 'id, updated_at',
        layers: 'id, map_id',
        points: 'id, mapId, syncStatus',
        photos: 'id, pointId, status',
        operations: 'id, mapId, pointId, createdAt, status, nextAttemptAt',
        cursors: 'mapId',
      })
      .upgrade(async (transaction) => {
        await transaction.table('points').toCollection().modify((point) => {
          point.recordType ??= 'observation'
          point.campaign ??= ''
          point.quantity ??= 1
          point.status ??= null
          point.lastObservedAt ??= null
          point.removedAt ??= null
          point.removalReason ??= null
          point.removalConfidence ??= null
          point.removalNote ??= ''
          point.events ??= []
        })
      })
    // v2 persisted photo bytes as Blobs, which iOS Safari intermittently
    // refuses to store. Legacy rows are re-encoded at startup by
    // healPhotoStore() instead of in a versionchange transaction: reading a
    // Blob crosses an event-loop turn with no pending IDB requests, and
    // WebKit commits idle transactions early (Dexie error 801), which would
    // abort the whole upgrade.
    this.version(3).stores({
      maps: 'id, updated_at',
      layers: 'id, map_id',
      points: 'id, mapId, syncStatus',
      photos: 'id, pointId, status',
      operations: 'id, mapId, pointId, createdAt, status, nextAttemptAt',
      cursors: 'mapId',
    })
  }
}

export const offlineDb = new FieldMapDatabase()
