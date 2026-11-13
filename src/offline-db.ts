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
  }
}

export const offlineDb = new FieldMapDatabase()
