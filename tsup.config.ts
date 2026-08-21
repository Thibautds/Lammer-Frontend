import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts', maplibre: 'src/maplibre.ts' },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  // maplibre-gl is a peer dependency (see package.json) -- a consumer who
  // only imports the core (map-library-agnostic point/tile API) shouldn't
  // have it pulled into their bundle at all.
  external: ['maplibre-gl'],
})
