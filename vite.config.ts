import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8080', '/healthz': 'http://localhost:8080' },
  },
  // MapLibre loads its worker relative to its own module URL; pre-bundling
  // would move the module away from the worker file.
  optimizeDeps: { exclude: ['maplibre-gl'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
