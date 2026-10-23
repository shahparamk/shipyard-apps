import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Locally, /api goes to the API on :8080 (docker compose).
// In the cluster, the load balancer does the same routing.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
})