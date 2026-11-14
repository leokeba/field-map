import { existsSync, readFileSync } from 'node:fs'
import { defineConfig, mergeConfig } from 'vite'
import baseConfig from './vite.config'

// Demo-only dev-server config (not used by `npm run dev` or `npm run build`):
//  - binds to 0.0.0.0 so the app is reachable as http://debian-nvidia:<port>
//  - proxies /api to the in-memory mock API (demo/mock_api.py) on 127.0.0.1:8001
//  - enables HTTPS with a self-signed cert when FM_DEMO_HTTPS=1, because
//    getUserMedia/getCurrentPosition only work in secure contexts
const certPath = '/tmp/opencode/fm-demo/cert.pem'
const keyPath = '/tmp/opencode/fm-demo/key.pem'
const httpsEnabled =
  process.env.FM_DEMO_HTTPS === '1' && existsSync(certPath) && existsSync(keyPath)

export default mergeConfig(
  baseConfig,
  defineConfig({
    server: {
      host: '0.0.0.0',
      port: Number(process.env.FM_DEMO_PORT ?? 5173),
      strictPort: true,
      // Demo-only: accept requests by LAN hostname/IP (e.g. http://debian-nvidia:5173)
      allowedHosts: true,
      proxy: {
        '/api': 'http://127.0.0.1:8001',
      },
      ...(httpsEnabled
        ? { https: { key: readFileSync(keyPath), cert: readFileSync(certPath) } }
        : {}),
    },
  }),
)
