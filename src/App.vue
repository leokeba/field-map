<script setup lang="ts">
import L, { type Map as LeafletMap, type Marker } from 'leaflet'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import {
  createMap,
  createLayer,
  deleteMap,
  deleteLayer,
  forgetMapShareToken,
  getMapShareToken,
  getPointEvents,
  getRememberedMapShareToken,
  mapShareUrl,
  rememberMapShareToken,
  rotateShareLink,
  setMapShareToken,
} from './api'
import { getSyncSummary } from './offline-sync'
import {
  createLocalPoint,
  deleteCachedLayerData,
  deleteCachedWorkspace,
  deleteLocalPoint,
  fetchPointsInBounds,
  getCachedPoints,
  initializeWorkspace,
  keepLocalVersion,
  recordPosterEventLocally,
  retryFailedPhoto,
  retryPointOperation,
  syncMap,
  updateLocalPoint,
  useServerVersion,
} from './offline-sync'
import { offlineDb } from './offline-db'
import type {
  FieldLayer,
  FieldMap,
  FieldPoint,
  MapRole,
  PhotoReference,
  PosterEvent,
  PosterEventInput,
  RemovalConfidence,
  RemovalReason,
  StoredPhoto,
  SyncStatus,
} from './types'

interface DraftPhoto extends PhotoReference {
  file?: Blob
  mimeType?: string
  previewUrl?: string
  remoteId?: string
  isNew?: boolean
}

interface PointDraft {
  lat: number
  lng: number
  recordType: 'poster' | 'observation'
  campaign: string
  quantity: number
  title: string
  description: string
  layerId: string
  capturedAt: string
  accuracyM: number | null
  photos: DraftPhoto[]
  removedPhotoIds: string[]
}

interface RemovalDraft {
  occurredAt: string
  reason: RemovalReason
  confidence: RemovalConfidence
  note: string
}

const layers = ref<FieldLayer[]>([])
const maps = ref<FieldMap[]>([])
const currentMap = ref<FieldMap | null>(null)
const points = ref<FieldPoint[]>([])
const mapId = ref<string | null>(null)
const currentRole = ref<MapRole>('viewer')
const activeLayerId = ref('')
const visibleLayerIds = ref<string[]>([])
const layerFormOpen = ref(false)
const layerBusy = ref(false)
const mapDialogOpen = ref(false)
const mapBusy = ref(false)
const newMapName = ref('')
const newMapDescription = ref('')
const newLayerName = ref('')
const newLayerColor = ref('#318b69')
const placementMode = ref(false)
const form = ref<PointDraft | null>(null)
const editingPointId = ref<string | null>(null)
const selectedPoint = ref<FieldPoint | null>(null)
const pointEvents = ref<PosterEvent[]>([])
const eventHistoryLoading = ref(false)
const removalDraft = ref<RemovalDraft | null>(null)
const statusMessage = ref('')
const syncLabel = ref('Connecting…')
const photoUrls = ref<Record<string, string>>({})
const cameraInput = ref<HTMLInputElement | null>(null)
const galleryInput = ref<HTMLInputElement | null>(null)
const shareRoles: MapRole[] = ['owner', 'editor', 'viewer']
const shareDialogOpen = ref(false)
const shareBusy = ref(false)
const shareLinks = ref<Record<MapRole, string | null>>({
  owner: null,
  editor: null,
  viewer: null,
})
const removalReasons: RemovalReason[] = [
  'suspected_opposition',
  'weather',
  'property_owner',
  'other',
  'unknown',
]
const removalConfidenceOptions: RemovalConfidence[] = ['suspected', 'confirmed', 'unknown']
const capturedAtLocal = computed({
  get: () => (form.value ? toLocalDateTimeInput(form.value.capturedAt) : ''),
  set: (value: string) => {
    if (form.value && value) form.value.capturedAt = new Date(value).toISOString()
  },
})
const removalOccurredAtLocal = computed({
  get: () =>
    removalDraft.value ? toLocalDateTimeInput(removalDraft.value.occurredAt) : '',
  set: (value: string) => {
    if (removalDraft.value && value) {
      removalDraft.value.occurredAt = new Date(value).toISOString()
    }
  },
})

const canEdit = computed(() => currentRole.value === 'owner' || currentRole.value === 'editor')
const activeLayer = computed(
  () =>
    layers.value.find((layer) => layer.id === activeLayerId.value) ??
    layers.value[0] ??
    { id: '', name: 'Layers', color: '#318b69' },
)
const formLayer = computed(
  () =>
    layers.value.find((layer) => layer.id === form.value?.layerId) ??
    layers.value[0] ??
    { id: '', name: 'Layers', color: '#318b69' },
)
const isEditing = computed(() => editingPointId.value !== null)
const tileUrl =
  import.meta.env.VITE_TILE_URL ??
  'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const currentUserId = import.meta.env.DEV
  ? import.meta.env.VITE_DEV_USER ?? 'local-user'
  : 'unknown'

let map: LeafletMap | undefined
let draftMarker: Marker | undefined
let currentLocationMarker: L.CircleMarker | undefined
const pointMarkers = new Map<string, Marker>()
let statusTimer: number | undefined
let pollingTimer: number | undefined
let boundsTimer: number | undefined

function layerFor(id: string): FieldLayer | undefined {
  return layers.value.find((layer) => layer.id === id)
}

function markerIcon(
  color: string,
  draft = false,
  syncStatus?: SyncStatus,
  posterStatus?: FieldPoint['status'],
): L.DivIcon {
  const markerClass = draft
    ? 'draft-pin'
    : `map-pin ${syncStatus ?? ''} ${posterStatus === 'removed' ? 'removed' : ''}`
  return L.divIcon({
    className: '',
    html: `<span class="${markerClass}" style="--pin-color:${color}"></span>`,
    iconSize: [28, 36],
    iconAnchor: [14, 33],
  })
}

function renderMarkers(): void {
  if (!map) return

  pointMarkers.forEach((marker) => marker.remove())
  pointMarkers.clear()

  for (const point of points.value) {
    if (
      point.syncStatus === 'delete-pending' ||
      !visibleLayerIds.value.includes(point.layerId)
    ) {
      continue
    }
    const marker = L.marker([point.lat, point.lng], {
      icon: markerIcon(
        layerFor(point.layerId)?.color ?? '#318b69',
        false,
        point.syncStatus,
        point.status,
      ),
      keyboard: true,
      title: point.title || (point.recordType === 'poster' ? 'Poster placement' : 'Field point'),
    }).addTo(map)
    marker.on('click', () => void openPointDetails(point))
    pointMarkers.set(point.id, marker)
  }
}

function showStatus(message: string): void {
  statusMessage.value = message
  window.clearTimeout(statusTimer)
  statusTimer = window.setTimeout(() => {
    statusMessage.value = ''
  }, 4000)
}

function photoUrl(photo: Pick<PhotoReference, 'id'> & { previewUrl?: string }): string {
  return photo.previewUrl ?? photoUrls.value[photo.id] ?? ''
}

async function refreshPhotoUrls(): Promise<void> {
  const photos = [
    ...points.value.flatMap((point) => point.photos),
    ...(form.value?.photos ?? []),
  ]
  const activeIds = new Set(photos.map((photo) => photo.id))
  for (const [id, url] of Object.entries(photoUrls.value)) {
    if (!activeIds.has(id)) {
      URL.revokeObjectURL(url)
      delete photoUrls.value[id]
    }
  }
  for (const photo of photos) {
    if (photoUrls.value[photo.id]) continue
    const stored = await offlineDb.photos.get(photo.id)
    if (stored) photoUrls.value[photo.id] = URL.createObjectURL(stored.file)
  }
}

async function refreshPointsFromStore(): Promise<void> {
  if (!mapId.value) return
  const cached = await getCachedPoints(mapId.value)
  const loaded = await Promise.all(
    cached.map(async (point) => ({
      ...point,
      photos: await Promise.all(
        point.photos.map(async (photo) => {
          const stored = await offlineDb.photos.get(photo.id)
          return stored ? { ...photo, status: stored.status } : photo
        }),
      ),
    })),
  )
  const selectedId = selectedPoint.value?.id
  points.value = loaded
  await refreshPhotoUrls()
  if (selectedId) {
    selectedPoint.value = loaded.find((point) => point.id === selectedId) ?? null
  }
}

async function openPointDetails(point: FieldPoint): Promise<void> {
  selectedPoint.value = point
  pointEvents.value = point.events ?? []
  removalDraft.value = null
  form.value = null
  if (
    point.recordType !== 'poster' ||
    point.syncStatus !== 'synced' ||
    !navigator.onLine
  ) {
    return
  }

  eventHistoryLoading.value = true
  try {
    const events = await getPointEvents(point.id)
    if (selectedPoint.value?.id !== point.id) return
    pointEvents.value = events
    const cached = await offlineDb.points.get(point.id)
    if (cached) await offlineDb.points.put({ ...cached, events })
  } catch (error) {
    showStatus(error instanceof Error ? error.message : 'Could not load poster history')
  } finally {
    eventHistoryLoading.value = false
  }
}

async function recordPosterEvent(event: PosterEventInput): Promise<void> {
  const point = selectedPoint.value
  if (!point || !canEdit.value) return
  try {
    const updated = await recordPosterEventLocally(point, event)
    selectedPoint.value = updated
    pointEvents.value = updated.events
    removalDraft.value = null
    await refreshPointsFromStore()
    await updateSyncLabel()
    showStatus(
      navigator.onLine
        ? 'Poster activity saved · syncing…'
        : 'Poster activity saved on this device · will sync when online',
    )
    void runSync()
  } catch (error) {
    showStatus(error instanceof Error ? error.message : 'Could not record poster activity')
  }
}

function confirmPosterPresent(): void {
  void recordPosterEvent({
    event_type: 'observed',
    occurred_at: new Date().toISOString(),
  })
}

function startRemoval(): void {
  removalDraft.value = {
    occurredAt: new Date().toISOString(),
    reason: 'unknown',
    confidence: 'unknown',
    note: '',
  }
}

function saveRemoval(): void {
  if (!removalDraft.value) return
  void recordPosterEvent({
    event_type: 'removed',
    occurred_at: removalDraft.value.occurredAt,
    removal_reason: removalDraft.value.reason,
    removal_confidence: removalDraft.value.confidence,
    note: removalDraft.value.note.trim() || null,
  })
}

async function updateSyncLabel(): Promise<void> {
  if (!navigator.onLine) {
    syncLabel.value = 'Offline · saved on device'
    return
  }
  if (!mapId.value) {
    syncLabel.value = 'Waiting for map'
    return
  }
  const summary = await getSyncSummary(mapId.value)
  if (summary.conflicts) syncLabel.value = 'Changes need review'
  else if (summary.failed) syncLabel.value = 'Upload needs retry'
  else if (summary.pending) syncLabel.value = 'Syncing changes…'
  else syncLabel.value = 'All changes synced'
}

async function runSync(): Promise<void> {
  if (!mapId.value) return
  if (!navigator.onLine) {
    await updateSyncLabel()
    return
  }
  syncLabel.value = 'Syncing changes…'
  try {
    await syncMap(mapId.value)
    await refreshPointsFromStore()
    await updateSyncLabel()
  } catch (error) {
    syncLabel.value = 'Sync paused'
    showStatus(error instanceof Error ? error.message : 'Synchronization failed')
  }
}

async function refreshVisibleBounds(): Promise<void> {
  if (!map || !mapId.value || !navigator.onLine) return
  const bounds = map.getBounds().pad(0.08)
  await fetchPointsInBounds(mapId.value, {
    west: Math.max(-180, bounds.getWest()),
    south: Math.max(-90, bounds.getSouth()),
    east: Math.min(180, bounds.getEast()),
    north: Math.min(90, bounds.getNorth()),
  })
  await refreshPointsFromStore()
}

function scheduleBoundsRefresh(): void {
  window.clearTimeout(boundsTimer)
  boundsTimer = window.setTimeout(() => {
    void refreshVisibleBounds().catch((error: unknown) => {
      showStatus(error instanceof Error ? error.message : 'Could not refresh map points')
    })
  }, 250)
}

function mergeMaps(...groups: FieldMap[][]): FieldMap[] {
  const merged = new Map<string, FieldMap>()
  for (const candidate of groups.flat()) merged.set(candidate.id, candidate)
  return [...merged.values()].sort((left, right) =>
    right.updated_at.localeCompare(left.updated_at),
  )
}

async function initialize(selectedMapId?: string): Promise<boolean> {
  try {
    const workspace = await initializeWorkspace(selectedMapId)
    maps.value = mergeMaps(maps.value, workspace.maps)
    currentMap.value = workspace.map
    mapId.value = workspace.map.id
    currentRole.value = workspace.map.current_role ?? 'viewer'
    const token = getMapShareToken()
    if (token) rememberMapShareToken(workspace.map.id, token)
    shareLinks.value = {
      owner: currentRole.value === 'owner' && token ? mapShareUrl(token) : null,
      editor: null,
      viewer: null,
    }
    layers.value = workspace.layers
    selectedPoint.value = null
    form.value = null
    editingPointId.value = null
    placementMode.value = false
    if (!activeLayerId.value || !layerFor(activeLayerId.value)) {
      activeLayerId.value = workspace.layers[0].id
    }
    visibleLayerIds.value = workspace.layers
      .filter((layer) => layer.is_visible_by_default)
      .map((layer) => layer.id)
    await refreshPointsFromStore()
    if (navigator.onLine) {
      try {
        await refreshVisibleBounds()
        await runSync()
      } catch (error) {
        showStatus(error instanceof Error ? error.message : 'Showing cached map data')
      }
    } else {
      await updateSyncLabel()
    }
    return true
  } catch (error) {
    syncLabel.value = 'Map unavailable'
    showStatus(error instanceof Error ? error.message : 'Could not load a map')
    return false
  }
}

function openMapManager(): void {
  if (!closeSheet()) return
  mapDialogOpen.value = true
}

async function selectMap(selectedMap: FieldMap): Promise<void> {
  if (selectedMap.id === mapId.value || mapBusy.value) {
    mapDialogOpen.value = false
    return
  }
  const previousToken = getMapShareToken()
  setMapShareToken(getRememberedMapShareToken(selectedMap.id), true)
  mapBusy.value = true
  try {
    if (await initialize(selectedMap.id)) {
      mapDialogOpen.value = false
      return
    }
    setMapShareToken(previousToken, true)
  } finally {
    mapBusy.value = false
  }
}

async function addMap(): Promise<void> {
  const name = newMapName.value.trim()
  if (!name || mapBusy.value) return
  const existingMaps = maps.value
  const previousToken = getMapShareToken()
  mapBusy.value = true
  try {
    const created = await createMap(name, newMapDescription.value.trim())
    rememberMapShareToken(created.map.id, created.owner_share_token)
    setMapShareToken(created.owner_share_token, true)
    maps.value = mergeMaps(existingMaps, [created.map])
    newMapName.value = ''
    newMapDescription.value = ''
    if (await initialize(created.map.id)) {
      mapDialogOpen.value = false
      showStatus(`Map "${created.map.name}" created`)
    } else {
      setMapShareToken(previousToken, true)
      showStatus(`Map "${created.map.name}" was created, but could not be opened`)
    }
  } catch (error) {
    setMapShareToken(previousToken, true)
    showStatus(error instanceof Error ? error.message : 'Could not create map')
  } finally {
    mapBusy.value = false
  }
}

function clearActiveMap(): void {
  mapId.value = null
  currentMap.value = null
  layers.value = []
  points.value = []
  selectedPoint.value = null
  form.value = null
  editingPointId.value = null
  activeLayerId.value = ''
  visibleLayerIds.value = []
  shareLinks.value = { owner: null, editor: null, viewer: null }
  currentRole.value = 'viewer'
  placementMode.value = false
  Object.values(photoUrls.value).forEach((url) => URL.revokeObjectURL(url))
  photoUrls.value = {}
}

async function removeMap(): Promise<void> {
  const mapToDelete = currentMap.value
  if (!mapToDelete || currentRole.value !== 'owner' || mapBusy.value) return
  const confirmed = window.confirm(
    `Permanently delete "${mapToDelete.name}" and all its layers, points, photos, and private links? This cannot be undone.`,
  )
  if (!confirmed) return

  mapBusy.value = true
  try {
    await deleteMap(mapToDelete.id)
    maps.value = maps.value.filter((candidate) => candidate.id !== mapToDelete.id)
    forgetMapShareToken(mapToDelete.id)
    let cacheError: unknown
    try {
      await deleteCachedWorkspace(mapToDelete.id)
    } catch (error) {
      cacheError = error
    }
    clearActiveMap()
    setMapShareToken(null, true)
    if (maps.value.length) {
      const nextMap = maps.value[0]
      const previousToken = getMapShareToken()
      setMapShareToken(getRememberedMapShareToken(nextMap.id), true)
      if (await initialize(nextMap.id)) {
        mapDialogOpen.value = false
      } else {
        setMapShareToken(previousToken, true)
      }
    } else {
      mapDialogOpen.value = false
      syncLabel.value = 'No map selected'
    }
    if (cacheError) {
      showStatus(
        `Map deleted, but offline data could not be cleared: ${
          cacheError instanceof Error ? cacheError.message : 'storage error'
        }`,
      )
    } else {
      showStatus(`Map "${mapToDelete.name}" deleted`)
    }
  } catch (error) {
    showStatus(error instanceof Error ? error.message : 'Could not delete map')
  } finally {
    mapBusy.value = false
  }
}

function openShareDialog(): void {
  const token = getMapShareToken()
  if (token) shareLinks.value.owner = mapShareUrl(token)
  shareDialogOpen.value = true
}

async function generateShareLink(role: MapRole): Promise<void> {
  if (!mapId.value || currentRole.value !== 'owner' || shareBusy.value) return
  shareBusy.value = true
  try {
    const result = await rotateShareLink(mapId.value, role)
    const url = mapShareUrl(result.token)
    shareLinks.value[role] = url
    if (role === 'owner') {
      rememberMapShareToken(mapId.value, result.token)
      setMapShareToken(result.token, true)
    }
    showStatus(`${role[0].toUpperCase()}${role.slice(1)} link generated; the previous link is revoked`)
  } catch (error) {
    showStatus(error instanceof Error ? error.message : 'Could not generate a private link')
  } finally {
    shareBusy.value = false
  }
}

async function copyShareLink(role: MapRole): Promise<void> {
  if (!shareLinks.value[role]) await generateShareLink(role)
  const url = shareLinks.value[role]
  if (!url) return
  try {
    await navigator.clipboard.writeText(url)
    showStatus(`${role[0].toUpperCase()}${role.slice(1)} link copied`)
  } catch (error) {
    showStatus(error instanceof Error ? error.message : 'Could not copy the private link')
  }
}

function setDraftLocation(lat: number, lng: number, accuracyM: number | null = null): void {
  if (!form.value || !map) return
  form.value.lat = lat
  form.value.lng = lng
  form.value.accuracyM = accuracyM
  map.setView([lat, lng], Math.max(map.getZoom(), 15), { animate: true })
  draftMarker?.remove()
  draftMarker = L.marker([lat, lng], {
    icon: markerIcon(formLayer.value?.color ?? '#318b69', true),
    draggable: true,
    title: 'Drag to adjust point location',
  }).addTo(map)
  draftMarker.on('dragend', () => {
    const position = draftMarker?.getLatLng()
    if (position && form.value) {
      form.value.lat = position.lat
      form.value.lng = position.lng
      form.value.accuracyM = null
    }
  })
}

function beginPoint(lat: number, lng: number, accuracyM: number | null = null): void {
  if (!canEdit.value) {
    showStatus('This private link is view-only')
    return
  }
  if (!mapId.value) {
    showStatus('Connect once to load or create a map')
    return
  }
  selectedPoint.value = null
  editingPointId.value = null
  placementMode.value = false
  form.value = {
    lat,
    lng,
    recordType: 'poster',
    campaign: '',
    quantity: 1,
    title: '',
    description: '',
    layerId: activeLayerId.value,
    capturedAt: new Date().toISOString(),
    accuracyM,
    photos: [],
    removedPhotoIds: [],
  }
  setDraftLocation(lat, lng, accuracyM)
}

function closeSheet(force = false): boolean {
  if (form.value && !force && !window.confirm('Discard this unsaved point?')) return false
  if (form.value) {
    for (const photo of form.value.photos) {
      if (photo.isNew && photo.previewUrl) {
        URL.revokeObjectURL(photo.previewUrl)
        delete photoUrls.value[photo.id]
      }
    }
  }
  form.value = null
  selectedPoint.value = null
  pointEvents.value = []
  removalDraft.value = null
  eventHistoryLoading.value = false
  editingPointId.value = null
  draftMarker?.remove()
  draftMarker = undefined
  void refreshPhotoUrls()
  return true
}

function startPlacement(): void {
  if (!closeSheet()) return
  placementMode.value = true
  statusMessage.value = ''
}

function useCurrentLocation(): void {
  if (!navigator.geolocation) {
    showStatus('Location is not available in this browser')
    return
  }
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      if (placementMode.value && !form.value) {
        beginPoint(coords.latitude, coords.longitude, coords.accuracy)
      } else if (form.value) {
        setDraftLocation(coords.latitude, coords.longitude, coords.accuracy)
      } else if (map) {
        map.setView([coords.latitude, coords.longitude], 16, { animate: true })
        currentLocationMarker?.remove()
        currentLocationMarker = L.circleMarker([coords.latitude, coords.longitude], {
          radius: 8,
          color: '#fff',
          weight: 3,
          fillColor: '#4388e8',
          fillOpacity: 1,
        })
          .addTo(map)
          .bindTooltip('Your location')
      }
      showStatus('Showing your current location')
    },
    (error) => {
      const message =
        error.code === error.PERMISSION_DENIED
          ? 'Location permission was denied'
          : 'Could not get your location; tap the map to place a point'
      showStatus(message)
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
  )
}

async function editPoint(point: FieldPoint): Promise<void> {
  if (!canEdit.value) return
  selectedPoint.value = null
  editingPointId.value = point.id
  const photos: DraftPhoto[] = await Promise.all(
    point.photos.map(async (photo) => {
      const stored = await offlineDb.photos.get(photo.id)
      return {
        ...photo,
        file: stored?.file,
        mimeType: stored?.mimeType,
        remoteId: stored?.remoteId,
        isNew: false,
      }
    }),
  )
  form.value = {
    lat: point.lat,
    lng: point.lng,
    recordType: point.recordType,
    campaign: point.campaign,
    quantity: point.quantity,
    title: point.title,
    description: point.description,
    layerId: point.layerId,
    capturedAt: point.capturedAt,
    accuracyM: point.accuracyM,
    photos,
    removedPhotoIds: [],
  }
  setDraftLocation(point.lat, point.lng, point.accuracyM)
}

async function savePoint(): Promise<void> {
  if (!canEdit.value || !form.value || !mapId.value) return
  const draft = form.value
  const pointId = editingPointId.value ?? crypto.randomUUID()
  const photoReferences: PhotoReference[] = draft.photos.map(
    ({ id, filename, status, capturedAt }) => ({ id, filename, status, capturedAt }),
  )
  const addedPhotos: StoredPhoto[] = draft.photos
    .filter(
      (photo): photo is DraftPhoto & { file: Blob } => photo.isNew === true && photo.file !== undefined,
    )
    .map((photo) => ({
      id: photo.id,
      pointId,
      file: photo.file,
      filename: photo.filename,
      mimeType: photo.mimeType ?? photo.file?.type ?? 'image/jpeg',
      capturedAt: photo.capturedAt,
      status: 'pending',
    }))

  try {
    if (editingPointId.value) {
      const existing = points.value.find((point) => point.id === editingPointId.value)
      if (!existing) throw new Error('The point being edited is no longer available')
      const updated: FieldPoint = {
        ...existing,
        lat: draft.lat,
        lng: draft.lng,
        campaign: draft.campaign.trim(),
        quantity: draft.quantity,
        title: draft.title,
        description: draft.description,
        layerId: draft.layerId,
        capturedAt: draft.capturedAt,
        accuracyM: draft.accuracyM,
        photos: photoReferences,
        syncStatus: 'pending',
      }
      await updateLocalPoint(updated, addedPhotos, draft.removedPhotoIds)
    } else {
      const point: FieldPoint = {
        id: pointId,
        mapId: mapId.value,
        layerId: draft.layerId,
        lat: draft.lat,
        lng: draft.lng,
        recordType: draft.recordType,
        campaign: draft.campaign.trim(),
        quantity: draft.quantity,
        status: draft.recordType === 'poster' ? 'active' : null,
        lastObservedAt: draft.recordType === 'poster' ? draft.capturedAt : null,
        removedAt: null,
        removalReason: null,
        removalConfidence: null,
        removalNote: '',
        title: draft.title,
        description: draft.description,
        capturedAt: draft.capturedAt,
        clientCreatedAt: new Date().toISOString(),
        accuracyM: draft.accuracyM,
        author: currentUserId,
        version: null,
        syncStatus: 'pending',
        photos: photoReferences,
        events:
          draft.recordType === 'poster'
            ? [
                {
                  id: crypto.randomUUID(),
                  point_id: pointId,
                  event_type: 'placed',
                  occurred_at: draft.capturedAt,
                  recorded_at: new Date().toISOString(),
                  actor_id: currentUserId,
                  removal_reason: null,
                  removal_confidence: null,
                  note: null,
                },
              ]
            : [],
      }
      await createLocalPoint(point, addedPhotos)
    }
    closeSheet(true)
    await refreshPointsFromStore()
    await updateSyncLabel()
    showStatus(navigator.onLine ? 'Saved on this device · syncing…' : 'Saved on this device · will sync when online')
    void runSync()
  } catch (error) {
    showStatus(error instanceof Error ? error.message : 'Could not save point locally')
  }
}

async function deletePoint(point: FieldPoint): Promise<void> {
  if (!canEdit.value) return
  if (!window.confirm('Delete this point?')) return
  try {
    await deleteLocalPoint(point)
    closeSheet(true)
    await refreshPointsFromStore()
    await updateSyncLabel()
    void runSync()
  } catch (error) {
    showStatus(error instanceof Error ? error.message : 'Could not queue point deletion')
  }
}

async function preparePhoto(file: File): Promise<{ blob: Blob; filename: string }> {
  const preserveOriginal = import.meta.env.VITE_PRESERVE_ORIGINALS === 'true'
  if (preserveOriginal || file.size <= 2_000_000) {
    return { blob: file, filename: file.name }
  }
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not prepare this photo for upload')
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error('Could not compress this photo'))),
      'image/jpeg',
      0.82,
    )
  })
  return { blob, filename: file.name.replace(/\.[^.]+$/, '') + '.jpg' }
}

async function handlePhotoSelection(event: Event): Promise<void> {
  const input = event.target
  if (!(input instanceof HTMLInputElement) || !input.files || !form.value) return
  try {
    for (const file of Array.from(input.files)) {
      const prepared = await preparePhoto(file)
      const photo: DraftPhoto = {
        id: crypto.randomUUID(),
        filename: prepared.filename,
        mimeType: prepared.blob.type || file.type,
        capturedAt: null,
        status: 'pending',
        file: prepared.blob,
        isNew: true,
      }
      photo.previewUrl = URL.createObjectURL(prepared.blob)
      photoUrls.value[photo.id] = photo.previewUrl
      form.value.photos.push(photo)
    }
  } catch (error) {
    showStatus(error instanceof Error ? error.message : 'Could not load selected photos')
  } finally {
    input.value = ''
  }
}

function removePhoto(index: number): void {
  const photo = form.value?.photos[index]
  if (!photo || !form.value) return
  if (photo.isNew && photo.previewUrl) {
    URL.revokeObjectURL(photo.previewUrl)
    delete photoUrls.value[photo.id]
  } else {
    form.value.removedPhotoIds.push(photo.id)
  }
  form.value.photos.splice(index, 1)
}

function toggleLayer(layerId: string): void {
  visibleLayerIds.value = visibleLayerIds.value.includes(layerId)
    ? visibleLayerIds.value.filter((id) => id !== layerId)
    : [...visibleLayerIds.value, layerId]
}

function cancelLayerCreation(): void {
  layerFormOpen.value = false
  newLayerName.value = ''
  newLayerColor.value = '#318b69'
}

async function addLayer(): Promise<void> {
  const name = newLayerName.value.trim()
  if (!mapId.value || currentRole.value !== 'owner' || !name || layerBusy.value) return

  layerBusy.value = true
  try {
    const sortOrder = Math.max(-1, ...layers.value.map((layer) => layer.sort_order)) + 1
    const layer = await createLayer(mapId.value, name, newLayerColor.value, sortOrder)
    layers.value = [...layers.value, layer].sort(
      (left, right) =>
        left.sort_order - right.sort_order ||
        left.created_at.localeCompare(right.created_at),
    )
    activeLayerId.value = layer.id
    visibleLayerIds.value = [...new Set([...visibleLayerIds.value, layer.id])]
    cancelLayerCreation()

    try {
      await offlineDb.layers.put(layer)
    } catch (error) {
      showStatus(
        `Layer created, but could not cache it for offline use: ${
          error instanceof Error ? error.message : 'storage error'
        }`,
      )
      return
    }

    showStatus(`Layer "${layer.name}" added`)
  } catch (error) {
    showStatus(error instanceof Error ? error.message : 'Could not add layer')
  } finally {
    layerBusy.value = false
  }
}

async function removeLayer(layer: FieldLayer): Promise<void> {
  if (!mapId.value || currentRole.value !== 'owner' || layerBusy.value) return
  if (layers.value.length <= 1) {
    showStatus('A map must keep at least one layer')
    return
  }
  if (
    !window.confirm(
      `Delete "${layer.name}" and all its points and photos? This cannot be undone.`,
    )
  ) {
    return
  }

  layerBusy.value = true
  try {
    await deleteLayer(layer.id)
    const remainingLayers = layers.value.filter((candidate) => candidate.id !== layer.id)
    layers.value = remainingLayers
    points.value = points.value.filter((point) => point.layerId !== layer.id)
    visibleLayerIds.value = visibleLayerIds.value.filter((id) => id !== layer.id)
    if (activeLayerId.value === layer.id) activeLayerId.value = remainingLayers[0].id
    if (form.value?.layerId === layer.id) form.value.layerId = remainingLayers[0].id

    try {
      await deleteCachedLayerData(mapId.value, layer.id)
    } catch (error) {
      showStatus(
        `Layer and points deleted on the server, but cached data could not be cleared: ${
          error instanceof Error ? error.message : 'storage error'
        }`,
      )
      return
    }

    await refreshPointsFromStore()
    showStatus(`Layer "${layer.name}" deleted`)
  } catch (error) {
    showStatus(error instanceof Error ? error.message : 'Could not delete layer')
  } finally {
    layerBusy.value = false
  }
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function toLocalDateTimeInput(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 16)
}

function posterEventLabel(event: PosterEvent): string {
  if (event.event_type === 'placed') return 'Poster placed'
  if (event.event_type === 'observed') return 'Still present'
  return 'Poster removed'
}

function removalReasonLabel(reason: RemovalReason | null | undefined): string {
  switch (reason) {
    case 'suspected_opposition':
      return 'Suspected opposition'
    case 'weather':
      return 'Weather or damage'
    case 'property_owner':
      return 'Property owner'
    case 'other':
      return 'Other'
    default:
      return 'Unknown'
  }
}

function removalConfidenceLabel(
  confidence: RemovalConfidence | null | undefined,
): string {
  switch (confidence) {
    case 'confirmed':
      return 'Confirmed'
    case 'suspected':
      return 'Suspected'
    default:
      return 'Uncertain'
  }
}

function formatCoordinate(value: number): string {
  return value.toFixed(5)
}

function syncDescription(status: SyncStatus): string {
  if (status === 'pending') return 'Waiting to sync'
  if (status === 'delete-pending') return 'Deletion waiting to sync'
  if (status === 'conflict') return 'This point changed on another device'
  if (status === 'failed') return 'Sync failed; your local copy is preserved'
  return 'Synced'
}

async function resolveWithLocal(): Promise<void> {
  if (!selectedPoint.value) return
  const id = selectedPoint.value.id
  try {
    await keepLocalVersion(id)
    await refreshPointsFromStore()
    selectedPoint.value = points.value.find((point) => point.id === id) ?? null
    void runSync()
  } catch (error) {
    showStatus(error instanceof Error ? error.message : 'Could not keep local changes')
  }
}

async function resolveWithServer(): Promise<void> {
  if (!selectedPoint.value) return
  const id = selectedPoint.value.id
  try {
    await useServerVersion(id)
    await refreshPointsFromStore()
    selectedPoint.value = points.value.find((point) => point.id === id) ?? null
    if (!selectedPoint.value) closeSheet(true)
  } catch (error) {
    showStatus(error instanceof Error ? error.message : 'Could not use server version')
  }
}

async function retryPhoto(photoId: string): Promise<void> {
  await retryFailedPhoto(photoId)
  await runSync()
}

async function retryPoint(pointId: string): Promise<void> {
  await retryPointOperation(pointId)
  await runSync()
}

function updatePointReferences(): void {
  if (selectedPoint.value) {
    selectedPoint.value = points.value.find((point) => point.id === selectedPoint.value?.id) ?? null
  }
}

watch(
  [points, visibleLayerIds],
  () => {
    renderMarkers()
    updatePointReferences()
  },
  { deep: true },
)

watch(
  () => form.value?.layerId,
  () => {
    if (form.value && draftMarker) {
      draftMarker.setIcon(markerIcon(formLayer.value?.color ?? '#318b69', true))
    }
  },
)

onMounted(() => {
  map = L.map('map', { zoomControl: false }).setView([51.5072, -0.1276], 14)
  L.tileLayer(tileUrl, {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map)
  L.control.zoom({ position: 'bottomright' }).addTo(map)
  map.on('click', ({ latlng }) => {
    if (placementMode.value) beginPoint(latlng.lat, latlng.lng)
  })
  map.on('moveend', scheduleBoundsRefresh)
  void initialize()
  pollingTimer = window.setInterval(() => void runSync(), 15000)
  window.addEventListener('online', runSync)
  window.addEventListener('offline', updateSyncLabel)
})

onBeforeUnmount(() => {
  window.clearTimeout(statusTimer)
  window.clearTimeout(boundsTimer)
  window.clearInterval(pollingTimer)
  window.removeEventListener('online', runSync)
  window.removeEventListener('offline', updateSyncLabel)
  Object.values(photoUrls.value).forEach((url) => URL.revokeObjectURL(url))
  map?.remove()
})
</script>

<template>
  <main class="app-shell">
    <div id="map" class="map-canvas" :class="{ 'is-placing': placementMode }"></div>

    <header class="topbar">
      <button class="brand map-manager-trigger" type="button" aria-label="Manage maps" @click="openMapManager">
        <span class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M12 21s7-6.1 7-12a7 7 0 1 0-14 0c0 5.9 7 12 7 12Z" />
            <circle cx="12" cy="9" r="2.5" />
          </svg>
        </span>
        <span>
          <strong>{{ currentMap?.name ?? 'Field Map' }}</strong>
          <small>{{ syncLabel }}</small>
        </span>
        <svg class="map-manager-chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>

      <div class="topbar-actions">
        <details v-if="layers.length" class="layers-menu">
          <summary aria-label="Choose active layer and visibility">
            <span class="layer-dot" :style="{ backgroundColor: activeLayer.color }"></span>
            <span class="active-layer-name">{{ activeLayer.name }}</span>
            <svg class="chevron" viewBox="0 0 16 16" aria-hidden="true">
              <path d="m4 6 4 4 4-4" />
            </svg>
          </summary>
          <div class="layers-popover">
            <p class="menu-heading">Add points to</p>
            <div v-for="layer in layers" :key="layer.id" class="layer-choice-row">
              <button
                class="layer-choice"
                :class="{ selected: activeLayerId === layer.id }"
                type="button"
                @click="activeLayerId = layer.id"
              >
                <span class="layer-dot" :style="{ backgroundColor: layer.color }"></span>
                <span>{{ layer.name }}</span>
                <span v-if="activeLayerId === layer.id" class="active-check" aria-label="active">✓</span>
              </button>
              <button
                v-if="currentRole === 'owner'"
                class="layer-delete-button"
                type="button"
                :aria-label="`Delete layer ${layer.name}`"
                :title="`Delete ${layer.name}`"
                :disabled="layerBusy"
                @click.stop="removeLayer(layer)"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3 4.5h10M6 4.5V3h4v1.5m2 0-.5 8h-7l-.5-8m3 2v3.5m2-3.5V10" />
                </svg>
              </button>
            </div>
            <div v-if="currentRole === 'owner'" class="layer-create-section">
              <button
                v-if="!layerFormOpen"
                class="layer-create-trigger"
                type="button"
                @click="layerFormOpen = true"
              >
                + Add layer
              </button>
              <form v-else class="layer-create-form" @submit.prevent="addLayer">
                <input
                  v-model="newLayerName"
                  class="layer-name-input"
                  type="text"
                  maxlength="120"
                  placeholder="Layer name"
                  aria-label="Layer name"
                  required
                  autofocus
                />
                <div class="layer-create-actions">
                  <input
                    v-model="newLayerColor"
                    class="layer-color-input"
                    type="color"
                    aria-label="Layer color"
                  />
                  <button
                    class="layer-create-cancel"
                    type="button"
                    :disabled="layerBusy"
                    @click="cancelLayerCreation"
                  >
                    Cancel
                  </button>
                  <button
                    class="layer-create-submit"
                    type="submit"
                    :disabled="layerBusy || !newLayerName.trim()"
                  >
                    {{ layerBusy ? 'Adding…' : 'Create' }}
                  </button>
                </div>
              </form>
            </div>
            <div class="menu-divider"></div>
            <p class="menu-heading">Show on map</p>
            <label v-for="layer in layers" :key="`visible-${layer.id}`" class="visibility-choice">
              <input
                type="checkbox"
                :checked="visibleLayerIds.includes(layer.id)"
                @change="toggleLayer(layer.id)"
              />
              <span class="layer-dot" :style="{ backgroundColor: layer.color }"></span>
              <span>{{ layer.name }}</span>
            </label>
          </div>
        </details>
        <button
          v-if="currentRole === 'owner'"
          class="share-button"
          type="button"
          @click="openShareDialog"
        >
          Share
        </button>
      </div>
    </header>

    <div v-if="placementMode" class="placement-hint" role="status">
      <span class="hint-target" aria-hidden="true">⌖</span>
      Tap the map or location button to place a point
      <button type="button" aria-label="Cancel placement" @click="placementMode = false">×</button>
    </div>

    <div v-if="statusMessage" class="status-toast" role="status">{{ statusMessage }}</div>

    <div
      v-if="mapDialogOpen"
      class="share-backdrop"
      @click.self="mapDialogOpen = false"
    >
      <section
        class="share-dialog map-manager-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="maps-title"
      >
        <div class="sheet-header">
          <div>
            <p class="eyebrow">FIELD MAPS</p>
            <h1 id="maps-title">Manage maps</h1>
          </div>
          <button
            class="sheet-close"
            type="button"
            aria-label="Close map manager"
            @click="mapDialogOpen = false"
          >×</button>
        </div>
        <p class="share-warning">
          Select a map to open it. Deleting a map permanently removes all its layers, points, photos, and private links.
        </p>
        <div class="map-options" aria-label="Available maps">
          <button
            v-for="candidate in maps"
            :key="candidate.id"
            class="map-option"
            :class="{ selected: candidate.id === mapId }"
            type="button"
            :disabled="mapBusy"
            @click="selectMap(candidate)"
          >
            <span>
              <strong>{{ candidate.name }}</strong>
              <small>{{ candidate.description || 'No description' }}</small>
            </span>
            <span class="map-option-role">{{ candidate.current_role ?? 'offline' }}</span>
          </button>
          <p v-if="!maps.length" class="map-list-empty">No maps available yet.</p>
        </div>
        <form class="map-create-form" @submit.prevent="addMap">
          <h2>Create a map</h2>
          <input
            v-model="newMapName"
            class="map-form-input"
            type="text"
            maxlength="160"
            placeholder="Map name"
            aria-label="New map name"
            required
          />
          <textarea
            v-model="newMapDescription"
            class="map-form-input map-description-input"
            maxlength="4000"
            placeholder="Description (optional)"
            aria-label="New map description"
            rows="2"
          ></textarea>
          <button class="map-create-button" type="submit" :disabled="mapBusy || !newMapName.trim()">
            {{ mapBusy ? 'Working…' : 'Create map' }}
          </button>
        </form>
        <button
          v-if="currentRole === 'owner' && currentMap"
          class="map-delete-button"
          type="button"
          :disabled="mapBusy"
          @click="removeMap"
        >
          Delete “{{ currentMap.name }}”
        </button>
      </section>
    </div>

    <div
      v-if="shareDialogOpen"
      class="share-backdrop"
      @click.self="shareDialogOpen = false"
    >
      <section
        class="share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
      >
        <div class="sheet-header">
          <div>
            <p class="eyebrow">PRIVATE MAP</p>
            <h1 id="share-title">Share access</h1>
          </div>
          <button
            class="sheet-close"
            type="button"
            aria-label="Close sharing"
            @click="shareDialogOpen = false"
          >×</button>
        </div>
        <p class="share-warning">
          Anyone with a link can use its permissions. Keep owner links private; rotating a link revokes its previous URL.
        </p>
        <div class="share-link-list">
          <div v-for="role in shareRoles" :key="role" class="share-link-row">
            <div class="share-link-description">
              <strong>{{ role[0].toUpperCase() }}{{ role.slice(1) }}</strong>
              <span>
                {{ role === 'owner' ? 'Manage this map and its links' : role === 'editor' ? 'Add and change observations' : 'View observations only' }}
              </span>
              <input
                v-if="shareLinks[role]"
                class="share-link-input"
                type="text"
                readonly
                :value="shareLinks[role]"
                :aria-label="`${role} private URL`"
              />
            </div>
            <button
              class="share-link-generate"
              type="button"
              :disabled="shareBusy"
              @click="generateShareLink(role)"
            >
              {{ shareLinks[role] ? 'Rotate' : 'Generate' }}
            </button>
            <button
              v-if="shareLinks[role]"
              class="share-link-copy"
              type="button"
              @click="copyShareLink(role)"
            >
              Copy
            </button>
          </div>
        </div>
      </section>
    </div>

    <div class="map-actions">
      <button
        class="icon-button location-button"
        type="button"
        :aria-label="placementMode ? 'Use current location to add point' : 'Show my location'"
        @click="useCurrentLocation"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="7" />
          <circle cx="12" cy="12" r="2" />
          <path d="M12 2v3m0 14v3M2 12h3m14 0h3" />
        </svg>
      </button>
      <button class="add-point-button" type="button" :disabled="!mapId || !canEdit" @click="startPlacement">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span>Record poster</span>
      </button>
    </div>

    <Transition name="sheet">
      <section
        v-if="form"
        class="bottom-sheet editor-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="editor-title"
      >
        <div class="sheet-grabber" aria-hidden="true"></div>
        <div class="sheet-header">
          <div>
            <p class="eyebrow">
              {{
                form.recordType === 'poster'
                  ? isEditing
                    ? 'UPDATE PLACEMENT'
                    : 'NEW POSTER PLACEMENT'
                  : isEditing
                    ? 'UPDATE OBSERVATION'
                    : 'NEW OBSERVATION'
              }}
            </p>
            <h1 id="editor-title">
              {{
                form.recordType === 'poster'
                  ? isEditing
                    ? 'Edit placement'
                    : 'Record poster'
                  : isEditing
                    ? 'Edit observation'
                    : 'Add observation'
              }}
            </h1>
          </div>
          <button class="sheet-close" type="button" aria-label="Close editor" @click="closeSheet()">×</button>
        </div>

        <div class="sheet-content">
          <label class="field-label" for="point-title">
            {{ form.recordType === 'poster' ? 'Label' : 'Title' }} <span>Optional</span>
          </label>
          <input
            id="point-title"
            v-model="form.title"
            class="text-input"
            maxlength="120"
            :placeholder="form.recordType === 'poster' ? 'Optional short label' : 'What did you find?'"
          />

          <template v-if="form.recordType === 'poster'">
            <label class="field-label" for="poster-campaign">
              Campaign <span>Optional</span>
            </label>
            <input
              id="poster-campaign"
              v-model="form.campaign"
              class="text-input"
              maxlength="160"
              placeholder="Campaign or message"
            />
            <div class="field-row quantity-row">
              <label class="field-label" for="poster-quantity">Quantity</label>
              <input
                id="poster-quantity"
                v-model.number="form.quantity"
                class="text-input quantity-input"
                type="number"
                min="1"
                max="10000"
                step="1"
                required
              />
            </div>
          </template>

          <label class="field-label description-label" for="point-description">Note <span>Optional</span></label>
          <textarea
            id="point-description"
            v-model="form.description"
            class="text-input description-input"
            maxlength="10000"
            rows="2"
            placeholder="Add a little more detail"
          ></textarea>

          <div class="field-row">
            <label class="field-label" for="point-layer">Layer</label>
            <label class="layer-select-wrap">
              <span class="layer-dot" :style="{ backgroundColor: formLayer.color }"></span>
              <select id="point-layer" v-model="form.layerId" aria-label="Point layer">
                <option v-for="layer in layers" :key="layer.id" :value="layer.id">{{ layer.name }}</option>
              </select>
              <svg class="chevron" viewBox="0 0 16 16" aria-hidden="true">
                <path d="m4 6 4 4 4-4" />
              </svg>
            </label>
          </div>

          <div class="photo-row">
            <div>
              <p class="field-label">Photo evidence <span>Optional</span></p>
              <p class="field-help">Avoid including faces or identifying details.</p>
            </div>
            <div class="photo-actions">
              <button class="photo-button" type="button" @click="cameraInput?.click()">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 7h3l1.5-2h7L17 7h3v12H4z" />
                  <circle cx="12" cy="13" r="3.5" />
                </svg>
                Camera
              </button>
              <button class="photo-button" type="button" @click="galleryInput?.click()">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                  <circle cx="9" cy="9" r="1.5" />
                  <path d="m20 15-5-5L5 20" />
                </svg>
                Library
              </button>
              <input
                ref="cameraInput"
                class="visually-hidden"
                type="file"
                accept="image/*"
                capture="environment"
                @change="handlePhotoSelection"
              />
              <input
                ref="galleryInput"
                class="visually-hidden"
                type="file"
                accept="image/*"
                multiple
                @change="handlePhotoSelection"
              />
            </div>
          </div>

          <div v-if="form.photos.length" class="photo-previews">
            <div v-for="(photo, index) in form.photos" :key="photo.id" class="photo-preview">
              <img :src="photoUrl(photo)" alt="Selected photo preview" />
              <button type="button" :aria-label="`Remove photo ${index + 1}`" @click="removePhoto(index)">×</button>
              <span v-if="photo.status !== 'synced'" class="photo-status">{{ photo.status }}</span>
            </div>
          </div>

          <button class="location-summary" type="button" @click="useCurrentLocation">
            <span class="location-summary-icon" aria-hidden="true">⌖</span>
            <span class="location-summary-text">
              <strong>Location attached</strong>
              <small>{{ formatCoordinate(form.lat) }}, {{ formatCoordinate(form.lng) }} · drag pin to adjust</small>
            </span>
            <span class="accuracy-note">{{ form.accuracyM === null ? 'Map placement' : `±${Math.round(form.accuracyM)} m` }}</span>
          </button>
          <label class="field-label capture-time-label" for="point-captured-at">
            {{ form.recordType === 'poster' ? 'Placed at' : 'Observed at' }}
          </label>
          <input
            id="point-captured-at"
            v-model="capturedAtLocal"
            class="text-input datetime-input"
            type="datetime-local"
            required
            :disabled="isEditing"
          />
          <p class="field-help capture-time-help">
            This is when it happened; the app separately records when it synced.
          </p>
        </div>

        <div class="sheet-footer">
          <button class="save-button" type="button" @click="savePoint">
            {{ isEditing ? 'Save changes' : 'Save point' }}
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m5 12 4 4L19 6" />
            </svg>
          </button>
        </div>
      </section>
    </Transition>

    <Transition name="sheet">
      <section
        v-if="selectedPoint"
        class="bottom-sheet detail-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-title"
      >
        <div class="sheet-grabber" aria-hidden="true"></div>
        <div class="sheet-header detail-header">
          <div>
            <p class="eyebrow">
              <span class="layer-dot" :style="{ backgroundColor: layerFor(selectedPoint.layerId)?.color }"></span>
              {{ layerFor(selectedPoint.layerId)?.name }}
              <span
                v-if="selectedPoint.recordType === 'poster'"
                class="poster-state"
                :class="selectedPoint.status"
              >
                {{ selectedPoint.status === 'removed' ? 'Removed' : 'Active' }}
              </span>
              <span class="sync-state" :class="selectedPoint.syncStatus">{{ syncDescription(selectedPoint.syncStatus) }}</span>
            </p>
            <h1 id="detail-title">
              {{
                selectedPoint.title ||
                (selectedPoint.recordType === 'poster' ? 'Poster placement' : 'Untitled observation')
              }}
            </h1>
          </div>
          <button class="sheet-close" type="button" aria-label="Close details" @click="closeSheet(true)">×</button>
        </div>
        <div class="sheet-content detail-content">
          <p v-if="selectedPoint.description" class="detail-description">{{ selectedPoint.description }}</p>
          <div
            v-if="selectedPoint.recordType === 'poster'"
            class="poster-metadata"
          >
            <span v-if="selectedPoint.campaign">
              <strong>Campaign</strong>{{ selectedPoint.campaign }}
            </span>
            <span>
              <strong>Quantity</strong>{{ selectedPoint.quantity }}
            </span>
            <span v-if="selectedPoint.lastObservedAt">
              <strong>Last observed</strong>{{ formatDate(selectedPoint.lastObservedAt) }}
            </span>
          </div>
          <div v-if="selectedPoint.photos.length" class="detail-photos">
            <div v-for="photo in selectedPoint.photos" :key="photo.id" class="detail-photo">
              <img :src="photoUrl(photo)" alt="Point attachment" />
              <button
                v-if="photo.status === 'failed'"
                class="retry-photo"
                type="button"
                @click="retryPhoto(photo.id)"
              >
                Retry photo
              </button>
            </div>
          </div>
          <div class="detail-meta">
            <span class="avatar">{{ selectedPoint.author.slice(0, 1).toUpperCase() }}</span>
            <span class="author-time">
              <strong>{{ selectedPoint.author === currentUserId ? 'You' : selectedPoint.author }}</strong>
              <small>{{ formatDate(selectedPoint.capturedAt) }}</small>
            </span>
          </div>
          <p class="coordinates">
            {{ formatCoordinate(selectedPoint.lat) }}°,
            {{ formatCoordinate(selectedPoint.lng) }}°
            <span v-if="selectedPoint.accuracyM !== null"> · ±{{ Math.round(selectedPoint.accuracyM) }} m accuracy</span>
          </p>
          <div
            v-if="canEdit && selectedPoint.recordType === 'poster' && selectedPoint.status === 'active'"
            class="poster-actions"
          >
            <button type="button" class="poster-observe-button" @click="confirmPosterPresent">
              Still present
            </button>
            <button type="button" class="poster-remove-button" @click="startRemoval">
              Mark removed
            </button>
          </div>
          <form v-if="removalDraft" class="removal-form" @submit.prevent="saveRemoval">
            <h2>Record removal</h2>
            <label class="field-label" for="removal-time">When was it removed?</label>
            <input
              id="removal-time"
              v-model="removalOccurredAtLocal"
              class="text-input"
              type="datetime-local"
              required
            />
            <label class="field-label" for="removal-reason">What happened?</label>
            <select id="removal-reason" v-model="removalDraft.reason" class="text-input">
              <option v-for="reason in removalReasons" :key="reason" :value="reason">
                {{ removalReasonLabel(reason) }}
              </option>
            </select>
            <label class="field-label" for="removal-confidence">Confidence</label>
            <select
              id="removal-confidence"
              v-model="removalDraft.confidence"
              class="text-input"
            >
              <option v-for="confidence in removalConfidenceOptions" :key="confidence" :value="confidence">
                {{ removalConfidenceLabel(confidence) }}
              </option>
            </select>
            <label class="field-label" for="removal-note">Note <span>Optional</span></label>
            <textarea
              id="removal-note"
              v-model="removalDraft.note"
              class="text-input description-input"
              maxlength="2000"
              rows="2"
              placeholder="What did you observe?"
            ></textarea>
            <p class="field-help">Record observations, not identifying details about people.</p>
            <div class="removal-form-actions">
              <button type="button" @click="removalDraft = null">Cancel</button>
              <button type="submit">Save removal</button>
            </div>
          </form>
          <section v-if="selectedPoint.recordType === 'poster'" class="poster-history">
            <h2>Activity</h2>
            <p v-if="eventHistoryLoading" class="field-help">Loading activity…</p>
            <p v-else-if="!pointEvents.length" class="field-help">No activity recorded yet.</p>
            <article v-for="event in pointEvents" :key="event.id" class="poster-event">
              <div>
                <strong>{{ posterEventLabel(event) }}</strong>
                <time :datetime="event.occurred_at">{{ formatDate(event.occurred_at) }}</time>
              </div>
              <p v-if="event.event_type === 'removed'">
                {{ removalReasonLabel(event.removal_reason) }} ·
                {{ removalConfidenceLabel(event.removal_confidence) }}
              </p>
              <p v-if="event.note">{{ event.note }}</p>
            </article>
          </section>
          <div v-if="canEdit && selectedPoint.syncStatus === 'conflict'" class="conflict-panel">
            <strong>Conflicting changes</strong>
            <p v-if="selectedPoint.serverShadow">
              Server version: {{ selectedPoint.serverShadow.title || 'Untitled observation' }}
            </p>
            <p v-else>The point was deleted on the server. Keeping yours will create it as a new point.</p>
            <div class="conflict-actions">
              <button type="button" @click="resolveWithServer">Use server</button>
              <button type="button" @click="resolveWithLocal">Keep mine</button>
            </div>
          </div>
        </div>
        <div class="sheet-footer detail-footer">
          <button
            v-if="canEdit && selectedPoint.syncStatus === 'failed'"
            class="save-button"
            type="button"
            @click="retryPoint(selectedPoint.id)"
          >
            Retry sync
          </button>
          <button v-else-if="canEdit" class="save-button" type="button" @click="editPoint(selectedPoint)">
            Edit point
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m14 5 5 5M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z" />
            </svg>
          </button>
          <button
            v-if="canEdit && selectedPoint.syncStatus !== 'conflict'"
            class="delete-button"
            type="button"
            aria-label="Delete point"
            @click="deletePoint(selectedPoint)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h16M10 11v6m4-6v6M6 7l1 14h10l1-14M9 7V4h6v3" />
            </svg>
          </button>
        </div>
      </section>
    </Transition>
  </main>
</template>
