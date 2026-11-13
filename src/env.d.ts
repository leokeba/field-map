/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TILE_URL?: string
  readonly VITE_API_URL?: string
  readonly VITE_DEV_USER?: string
  readonly VITE_PRESERVE_ORIGINALS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
