/**
 * Wiring the cube into MapLibre.
 *
 * A raster *tile* source, rendered on demand through `addProtocol`, so the
 * same code answers a world view and a single peak at z14 -- there's no
 * bbox to define ahead of time and no resolution tier to pick.
 *
 * Adapted from Lammer's own `frontend/src/lib/cube/protocol.ts`: the
 * config that file read from Vite's `import.meta.env` (`VITE_CDN_URL`,
 * `VITE_CUBE_ROOT`) is now explicit function parameters instead, since a
 * consumer of this package isn't necessarily on Vite, or configured the
 * same way Lammer's own app is.
 */

import type maplibregl from 'maplibre-gl'
import { clearCubeCache } from './format'
import type { CubeManifest } from './pyramid'
import { parseManifest } from './pyramid'
import { clearPlaneSets, cubeSupports, renderCubeTile, transparent } from './render'
import type { OverlayType } from './types'

export const CUBE_SOURCE_ID = 'cube-overlay'
export const CUBE_LAYER_ID = 'cube-overlay'

export type ResolveCubePathOptions = {
  /** Where the cube bucket is served from. Empty (the default) means
   *  same-origin -- correct when a Worker or CDN proxies it under the
   *  page's own domain, same as `data.lammer.io`'s own docs recommend. */
  cdnBase?: string
  /** The path segment `{cdnBase}/{cubeRoot}/{modelId}/latest.json` reads
   *  from. Defaults to `cube/v1`, matching the format's own convention
   *  (see the methodology docs) -- override only if a deployment
   *  publishes somewhere else. */
  cubeRoot?: string
  /** How long a resolved `latest.json` pointer is trusted before the next
   *  call re-fetches it (ms). Long enough that switching overlays or
   *  steps within one session hits the cache instead of re-fetching;
   *  short enough that a newly-published run is picked up well within one
   *  interaction. */
  cacheMs?: number
}

const DEFAULT_CUBE_ROOT = 'cube/v1'
const DEFAULT_CACHE_MS = 60_000

type CachedPath = { path: string | null; at: number }
const pathCache = new Map<string, CachedPath>()

/**
 * Which run to read, resolved at runtime, for one model/region id.
 *
 * An explicit `?cubePath=` query param wins outright -- useful for
 * pointing a session at an exact run while debugging -- otherwise the
 * pointer the generator publishes for `modelId`, cached in memory per
 * `options.cacheMs`.
 */
export async function resolveCubePath(
  modelId: string,
  options: ResolveCubePathOptions = {},
): Promise<string | null> {
  const cdnBase = options.cdnBase ?? ''
  const cubeRoot = options.cubeRoot ?? DEFAULT_CUBE_ROOT
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS

  if (typeof window !== 'undefined') {
    const override = new URLSearchParams(window.location.search).get('cubePath')
    if (override) return override
  }

  const cacheKey = `${cdnBase}|${cubeRoot}|${modelId}`
  const cached = pathCache.get(cacheKey)
  if (cached && Date.now() - cached.at < cacheMs) return cached.path

  const url = `${cdnBase}/${cubeRoot}/${modelId}/latest.json`.replace(/([^:])\/{2,}/g, '$1/')
  try {
    const response = await fetch(url, { cache: 'no-cache' })
    if (!response.ok) {
      console.warn(`[cube] no run pointer at ${url} (${response.status})`)
      pathCache.set(cacheKey, { path: null, at: Date.now() })
      return null
    }
    const latest = await response.json()
    const path = typeof latest.path === 'string' ? latest.path : null
    pathCache.set(cacheKey, { path, at: Date.now() })
    return path
  } catch (err) {
    console.warn(`[cube] could not read ${url}:`, err)
    // Not cached: a network hiccup shouldn't lock a session out of every
    // retry for a full cache window the way a real "no run published"
    // answer does.
    return null
  }
}

// Keyed by path, not a single slot: a caller resolving two models at once
// (blended mode, say) needs both to stay cached, not have the second
// fetch evict the first.
const manifestCache = new Map<string, Promise<CubeManifest | null>>()

export function loadCubeManifest(path: string, cdnBase = ''): Promise<CubeManifest | null> {
  const cached = manifestCache.get(path)
  if (cached) return cached

  const prefix = `${cdnBase}/${path}`.replace(/\/+$/, '')
  const promise = fetch(`${prefix}/manifest.json`, { cache: 'no-cache' })
    .then(async response => {
      if (!response.ok) throw new Error(`cube manifest ${response.status} at ${prefix}`)
      const raw = await response.json()
      // Static planes live beside the run directories, keyed by content, so
      // a second run finds them already in the browser cache.
      const root = prefix.replace(/\/[^/]+$/, '')
      const staticBase = `${root}/static/${raw.static_key ?? ''}`
      return parseManifest(raw, prefix, staticBase)
    })
    .catch(err => {
      console.error('[cube] manifest failed:', err)
      // Not cached: a failed fetch should be retried by the next caller
      // rather than permanently remembered as "this run has no manifest".
      manifestCache.delete(path)
      return null
    })
  manifestCache.set(path, promise)
  return promise
}

/**
 * Registered once for the page. MapLibre keys protocol handlers by scheme,
 * so re-registering on every render would swap the closure out from under
 * in-flight tiles instead of just updating what the next one reads.
 */
let registered = false

export function registerCubeProtocol(
  maplibre: typeof maplibregl,
  getState: () => { manifest: CubeManifest | null; overlay: OverlayType | null; stepH: number },
) {
  if (registered) return
  registered = true

  maplibre.addProtocol('cube', async params => {
    // Every early return hands back a real transparent bitmap: a
    // zero-length buffer makes MapLibre error on the tile and retry it
    // forever.
    const match = params.url.match(/cube:\/\/(\d+)\/(\d+)\/(\d+)/)
    if (!match) return { data: await transparent() }
    const [z, x, y] = [Number(match[1]), Number(match[2]), Number(match[3])]

    const { manifest, overlay, stepH } = getState()
    if (!manifest || !overlay || !cubeSupports(overlay)) {
      return { data: await transparent() }
    }
    try {
      return { data: await renderCubeTile(manifest, z, x, y, overlay, stepH) }
    } catch (err) {
      console.error('[cube] tile failed:', err)
      return { data: await transparent() }
    }
  })
}

const DEFAULT_OPACITY: Record<OverlayType, number> = {
  temperature: 0.65,
  precipitation_type: 0.65,
  rain_accumulated: 0.65,
  snow_accumulated: 0.65,
  snow_depth: 0.65,
  wind_speed: 0.65,
  wind_gust: 0.65,
  cloud_cover: 0.72,
  freezing_level: 0.7,
  visibility: 0.75,
}

export function addCubeLayer(
  map: maplibregl.Map,
  overlay: OverlayType,
  cacheBuster: string,
  options: { opacity?: number; beforeId?: string } = {},
) {
  const opacity = options.opacity ?? DEFAULT_OPACITY[overlay] ?? 0.65
  // The query string never reaches a server -- it exists so MapLibre treats
  // a new overlay or step as new tiles rather than serving its cache.
  const tiles = [`cube://{z}/{x}/{y}?v=${cacheBuster}`]

  const existing = map.getSource(CUBE_SOURCE_ID)
  if (existing && map.getLayer(CUBE_LAYER_ID)) {
    // Same layer, just pointed at new tiles (a step change from moving the
    // timeline, or a different overlay). `setTiles` swaps them in as they
    // arrive, tile by tile -- the old ones stay up until then, rather than
    // a full removeLayer+addSource+addLayer, which would briefly leave
    // *nothing* on the map on every call.
    if ('setTiles' in existing) {
      (existing as { setTiles: (tiles: string[]) => unknown }).setTiles(tiles)
    }
    map.setPaintProperty(CUBE_LAYER_ID, 'raster-opacity', opacity)
    return
  }

  removeCubeLayer(map)
  map.addSource(CUBE_SOURCE_ID, {
    type: 'raster',
    tiles,
    tileSize: 256,
  })
  map.addLayer({
    id: CUBE_LAYER_ID,
    type: 'raster',
    source: CUBE_SOURCE_ID,
    paint: {
      'raster-opacity': opacity,
      // Nearest would draw the 256-pixel tile as visible squares while the
      // map interpolates between zoom levels; the field is already smooth.
      'raster-resampling': 'linear',
      'raster-fade-duration': 0,
    },
  }, options.beforeId)
}

export function removeCubeLayer(map: maplibregl.Map) {
  if (map.getLayer(CUBE_LAYER_ID)) map.removeLayer(CUBE_LAYER_ID)
  if (map.getSource(CUBE_SOURCE_ID)) map.removeSource(CUBE_SOURCE_ID)
}

/** Dropping a run means its blocks are stale; the browser cache keeps the
 *  static planes, which is the point of keying them by content. */
export function resetCubeCaches() {
  clearCubeCache()
  clearPlaneSets()
  manifestCache.clear()
  pathCache.clear()
}

export { cubeSupports }
export type { CubeManifest }
