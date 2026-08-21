# @lammer/cube

Open a [Lammer](https://lammer.io) weather cube and render or sample it —
elevation-corrected temperature, wind, precipitation phase, cloud cover,
freezing level and visibility, client-side, at any resolution. This is
the same module that renders lammer.io's own map and every peak/hut
forecast, extracted into a standalone package.

Full docs, the API reference, and the physics behind every value: **[data.lammer.io](https://data.lammer.io)**.

> **Status:** not published to npm yet -- install it as a git dependency
> (`"@lammer/cube": "github:thibautds/lammer-frontend"`) until then; the
> `prepare` script builds `dist/` on install. The core and MapLibre
> adapter are exactly what lammer.io runs today (see
> [Provenance](#provenance)). The Leaflet adapter (below) is real and
> tested, but hasn't run in a production map the way the MapLibre one has
> -- lammer.io's own map is MapLibre-based, so Leaflet's first real-world
> exercise will be whoever adopts it first.

## Why

Most weather data ships as pre-rendered map tiles — fine for a picture,
useless for a number. `@lammer/cube` reads the actual coarse model fields
(temperature, humidity, wind, geopotential height, at a handful of
pressure levels) and downscales them against *real* terrain at read
time, client-side. The same code paints a raster layer at any zoom and
answers a single-point forecast — see
[data.lammer.io/architecture](https://data.lammer.io/architecture/) for
the full design.

## Install

```sh
npm install @lammer/cube
```

(Once published — see the status note above. Until then, this repo's
`src/` is the package.)

## Quick start

### Core — framework-agnostic

```ts
import { cubePointSeries } from '@lammer/cube'

const manifest = /* parsed from a run's manifest.json -- see below */
const { values, elevation } = await cubePointSeries(manifest, lon, lat)

values[0]?.tempC      // °C, elevation-corrected
values[0]?.windMs      // m/s, terrain-exposure corrected
values[0]?.rainMm      // mm, this step
```

### MapLibre

```ts
import maplibregl from 'maplibre-gl'
import {
  registerCubeProtocol, addCubeLayer, resolveCubePath, loadCubeManifest,
} from '@lammer/cube/maplibre'

const path = await resolveCubePath('icon-eu', { cdnBase: 'https://your-cdn.example' })
const manifest = path && await loadCubeManifest(path, 'https://your-cdn.example')

registerCubeProtocol(maplibregl, () => ({ manifest, overlay: 'temperature', stepH: 0 }))
addCubeLayer(map, 'temperature', 'temperature-0')
```

Every tile MapLibre requests calls `renderCubeTile` under the hood: fetch
only the planes that overlay needs, interpolate against real elevation,
hand back an `ImageBitmap` directly — no PNG round trip.

### Leaflet

```ts
import L from 'leaflet'
import { cubeLayer } from '@lammer/cube/leaflet'

const layer = cubeLayer({ manifest, overlay: 'temperature', stepH: 0 }).addTo(map)

// Later -- a step change, a new overlay, a fresh run:
layer.setStepH(12)
layer.setOverlay('wind_speed')
layer.setManifest(newManifest)
```

`cubeLayer` is a thin `L.GridLayer` (see [Leaflet](#leaflet) below) --
`addTo`/`remove`, `setOpacity`, everything else a normal Leaflet layer
supports works unchanged.

See [data.lammer.io/cube-library](https://data.lammer.io/cube-library/)
for the full API reference, and
[data.lammer.io/getting-started](https://data.lammer.io/getting-started/)
for where a manifest and its bytes actually come from (the
[Lammer Cube API](https://data.lammer.io) Worker).

## What's in `src/`

| File | What |
|---|---|
| `format.ts` | CUB2: one probe request for a header+index, one Range request per plane after that. |
| `physics.ts` | The downscaling itself -- vertical interpolation, hypsometric pressure, Jennings 2018 precipitation phase, Liston & Elder wind terrain exposure. |
| `pyramid.ts` | The 3-level resolution pyramid and manifest parsing. |
| `render.ts` | One 256×256 raster tile, per-pixel, as an `ImageBitmap`. |
| `ramps.ts` | The colour ramp for every overlay -- identical to lammer.io's own, so a rendering difference always means the *data* differs. |
| `point.ts` | `cubePointSeries` -- every step at one coordinate, near-term-first streaming. |
| `maplibre.ts` | The MapLibre adapter (`@lammer/cube/maplibre`). |
| `leaflet.ts` | The Leaflet adapter (`@lammer/cube/leaflet`). |

Every formula in `physics.ts` is documented with its real citation at
[data.lammer.io/methodology](https://data.lammer.io/methodology/).

## Leaflet

A `Leaflet.GridLayer` subclass (`CubeLayer`, `src/leaflet.ts`) overriding
`createTile`, Leaflet's own extension point for an async, non-plain-image
tile source: allocate a `<canvas>` synchronously, paint into it once
`renderCubeTile` resolves, call `done(error, tile)`.

The cache-buster question the MapLibre adapter's own `addCubeLayer` had to
solve explicitly (see its comment on why a full
`removeLayer`+`addSource`+`addLayer` used to blank the map on every step
change) doesn't come up here the same way: `L.GridLayer` doesn't key tiles
by a URL template in `createTile` mode, so `redraw()` -- called by
`setOverlay`/`setStepH`/`setManifest` -- goes straight back through
`createTile` for every tile on screen, and Leaflet's own tile-replacement
handling (the old tile stays up until the new one's `done()` fires) gives
the same non-blanking behaviour for free.

Tested with `@vitest-environment jsdom` against a mocked `renderCubeTile`
(the render pipeline itself is proven separately, in bytes, by
`test/format.test.ts`) -- `createTile`'s synchronous return, the
done-callback contract on success and on a rejected render, and that
`setOverlay`/`setStepH`/`setManifest` actually change what the next tile
asks for.

## Development

```sh
npm install
npm run typecheck
npm test          # vitest -- physics, pyramid, a real CUB2 byte round-trip, the Leaflet adapter (jsdom)
npm run build      # tsup -- dist/{index,maplibre,leaflet}.{js,d.ts}
```

## Provenance

Extracted from Lammer's own `frontend/src/lib/cube/*`
(`github.com/thibautds/lammer`), which runs lammer.io's map and every
peak/hut forecast today. Copied, not reimplemented — the physics and
format-reading code here is the actual production code, adapted only
where the original relied on Lammer's own build setup (`import.meta.env`
config, an app-internal `ModelId` type) rather than the format itself;
see each adapted file's own header comment for exactly what changed and
why.

## License

MIT — see [LICENSE](./LICENSE).
