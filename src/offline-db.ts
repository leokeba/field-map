import Dexie, { type Table } from 'dexie'
import { blobToBase64 } from './photo-bytes'
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
    // refuses to store; re-encode any legacy rows as base64 strings.
    this.version(3)
      .stores({
        maps: 'id, updated_at',
        layers: 'id, map_id',
        points: 'id, mapId, syncStatus',
        photos: 'id, pointId, status',
        operations: 'id, mapId, pointId, createdAt, status, nextAttemptAt',
        cursors: 'mapId',
      })
      .upgrade(async (transaction) => {
        const rows = await transaction.table('photos').toArray()
        for (const row of rows) {
          const legacy = row as StoredPhoto & { file?: unknown }
          if (!(legacy.file instanceof Blob)) continue
          const migrated: StoredPhoto = {
            id: legacy.id,
            pointId: legacy.pointId,
            fileData: await blobToBase64(legacy.file),
            filename: legacy.filename,
            mimeType: legacy.mimeType,
            capturedAt: legacy.capturedAt,
            status: legacy.status,
            remoteId: legacy.remoteId,
          }
          await transaction.table('photos').put(migrated)
        }
      })
  }
}

export const offlineDb = new FieldMapDatabase()
