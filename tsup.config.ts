import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts', maplibre: 'src/maplibre.ts', leaflet: 'src/leaflet.ts' },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  // Both are peer dependencies (see package.json) -- a consumer who only
  // imports one adapter, or neither (the core alone), shouldn't have the
  // other map library pulled into their bundle at all.
  external: ['maplibre-gl', 'leaflet'],
})
