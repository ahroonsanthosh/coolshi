import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8080', '/healthz': 'http://localhost:8080' },
  },
  // MapLibre loads its worker relative to its own module URL; pre-bundling
  // would move the module away from the worker file.
  optimizeDeps: { exclude: ['maplibre-gl'] },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    // MapLibre is most of the weight and changes far less often than the
    // app: its own file stays cached across deploys.
    rollupOptions: { output: { manualChunks: (id: string) => (id.includes('node_modules/maplibre-gl') ? 'maplibre' : undefined) } },
  },
});
