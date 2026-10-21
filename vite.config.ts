import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { isAuthenticatedWriteProxyRequest } from './src/vite-proxy-runtime.mjs'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const writeToken = env.MISSION_CONTROL_API_TOKEN

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:8788',
          changeOrigin: true,
          configure(proxy) {
            proxy.on('proxyReq', (proxyRequest, request) => {
              if (isAuthenticatedWriteProxyRequest(request.method, request.url)) {
                proxyRequest.setHeader('origin', 'http://127.0.0.1:8788')
                if (writeToken) proxyRequest.setHeader('authorization', `Bearer ${writeToken}`)
              }
            })
          },
        },
      },
    },
  }
})
