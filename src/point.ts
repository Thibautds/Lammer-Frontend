/**
 * A forecast for one coordinate, every step, from the cube.
 *
 * The map and this want opposite things from the same objects. A map tile
 * needs one plane across several blocks; a point needs every plane of one
 * block, for every step. As Range requests that is 37 planes x 65 steps =
 * 2405 round trips for a single click. The same bytes arrive in six whole
 * objects -- measured at 0.84 MB per twelve-step object, 67 kB per step -- so
 * this path asks for objects and the map keeps asking for planes.
 *
 * The near term arrives first and the rest streams in behind it, because the
 * hour someone clicked on is almost always the one they are looking at.
 */

import type { CubeValues, PlaneSet } from './physics'
import { evaluate, newColumn, newValues, sampleColumn } from './physics'
import type { CubeManifest } from './pyramid'
import { blockOf, bundleFor, inLevelDomain } from './pyramid'
import type { TerrainSlope } from './physics'
import type { LayerSpec } from './render'
import { DEM_MAX_ZOOM, demSampler, planesFor, terrainSampler, TILE, tile2lat, tile2lon } from './render'

/**
 * Everything, because a point readout shows everything. This is the one
 * caller for which fetching the whole object is cheaper than choosing.
 */
const POINT_SPEC: LayerSpec = {
  needs: ['tp', 'tcc', 'sd', 'gust', 't2m', 'r2', 'fzl'],
  profileNeeds: ['t', 'r', 'u', 'v'],
  // One: `tp` is cumulative since run start, so a point reading needs the
  // *previous* step subtracted out to get what actually fell in this one --
  // the same "eff_rain_h = rain_a - prev_rain" step worker.py's own
  // forecast-tile writer already does before it ever calls a value
  // `rain_mm`. Window 0 here once shipped the raw cumulative total instead:
  // harmless-looking on its own, but a point series feeds
  // buildForecastDays/mergeModelSeries downstream, which sums and
  // divides-by-interval on the assumption every entry is "this step's
  // amount" -- summing already-cumulative numbers, or dividing one by its
  // own interval, produces nonsense that only gets worse deeper into the
  // run. Matches `precipitation_type`'s own `window: 1` in render.ts, the
  // map overlay already doing this correctly for the same reason.
  window: 1,
  whole: true,
}

/**
 * The DEM at the finest zoom there is, not at whatever the map is showing.
 * A summit is a summit regardless of how far out you happen to be zoomed, and
 * the elevation is what the whole downscaling turns on.
 */
function tileOf(lon: number, lat: number, z: number) {
  const n = Math.pow(2, z)
  const tx = Math.floor(((lon + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const ty = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)
  const west = tile2lon(tx, z)
  const east = tile2lon(tx + 1, z)
  const north = tile2lat(ty, z)
  const south = tile2lat(ty + 1, z)
  const px = Math.min(TILE - 1, Math.max(0, Math.floor(((lon - west) / (east - west)) * TILE)))
  const py = Math.min(TILE - 1, Math.max(0, Math.floor(((north - lat) / (north - south)) * TILE)))
  return { tx, ty, px, py }
}

export async function cubeElevationAt(lon: number, lat: number): Promise<number> {
  const { tx, ty, px, py } = tileOf(lon, lat, DEM_MAX_ZOOM)
  const at = await demSampler(DEM_MAX_ZOOM, tx, ty)
  return at ? at(px, py) : NaN
}

/** The same terrain factor the wind layer draws, so a point and the pixel
 *  under it do not disagree about how sheltered it is. */
async function terrainAtPoint(lon: number, lat: number): Promise<TerrainSlope | null> {
  const { tx, ty, px, py } = tileOf(lon, lat, DEM_MAX_ZOOM)
  const at = await terrainSampler(DEM_MAX_ZOOM, tx, ty)
  if (!at) return null
  const { ex, ey, zxx, zxy, zyy } = at(px, py)
  return { ex, ey, zxx, zxy, zyy }
}

export type CubePointSeries = {
  /** One entry per manifest step, aligned by index. Null where the run has none. */
  values: (CubeValues | null)[]
  elevation: number
}

/**
 * Steps grouped by the object that holds them, nearest to `aroundStep` first.
 *
 * One object is one fetch, so the order objects are visited in is the order
 * the forecast fills in. Starting at the hour someone is looking at means the
 * first response is the useful one.
 */
function bundleOrder(m: CubeManifest, aroundStep: number): string[] {
  const seen = new Set<string>()
  const byDistance = [...m.steps].sort(
    (a, b) => Math.abs(a - aroundStep) - Math.abs(b - aroundStep))
  const order: string[] = []
  for (const step of byDistance) {
    const name = bundleFor(m, step)
    if (name && !seen.has(name)) {
      seen.add(name)
      order.push(name)
    }
  }
  return order
}

/**
 * Every step at one coordinate.
 *
 * `onProgress`, when given, is called after each bundle object lands, so a
 * caller can paint the near term while the rest is still arriving -- the map's
 * own point-click popup (`usePointForecastData.ts`), which wants exactly that
 * ordering. Without it, every bundle is requested at once instead: a caller
 * that has nothing listening for partial results (a detail page awaiting the
 * whole series before it draws anything, see `cubeLocationForecast.ts`) pays
 * for the "near term first, rest streams in behind it" ordering without ever
 * seeing the benefit -- measured on a real detail-page load, the sequential
 * version spent about 2.3s of wall clock moving roughly 40ms worth of actual
 * bytes, entirely idle between bundles waiting for the previous one's full
 * fetch-decode-evaluate to finish before the next one's *fetch* was even
 * allowed to start. The finest level always, because a point forecast should
 * not get coarser because the map is zoomed out.
 */
export async function cubePointSeries(
  m: CubeManifest,
  lon: number,
  lat: number,
  options: {
    elevation?: number
    aroundStep?: number
    signal?: AbortSignal
    onProgress?: (partial: CubePointSeries) => void
  } = {},
): Promise<CubePointSeries> {
  const level = m.pyramid[m.pyramid.length - 1]
  const elevation = options.elevation ?? await cubeElevationAt(lon, lat)
  const values: (CubeValues | null)[] = m.steps.map(() => null)

  // A regional model's edge is where its coverage ends, not the world's --
  // see pyramid.ts's inLevelDomain. Answering with the nearest edge block's
  // data for a click outside a regional model's domain would be worse than
  // answering with nothing: it looks like a real forecast for a place the
  // model never touched.
  if (!inLevelDomain(level, lon, lat)) return { values, elevation }

  const [bx, by] = blockOf(level, lon, lat)
  const terrain = await terrainAtPoint(lon, lat)

  // Shared scratch space, reused across every step regardless of how the
  // bundles below are ordered or interleaved. Safe to share even when
  // bundles run concurrently: `sampleColumn` overwrites it completely and
  // `evaluate` reads it back in the same synchronous turn, with no `await`
  // between them -- JS only yields at the `await planesFor(...)` in
  // `fillStep`, never in the middle of a sample-then-evaluate pair, so no
  // other step's turn can ever observe `column` half-written.
  const column = newColumn(m.levels.length)
  const around = options.aroundStep ?? m.steps[0] ?? 0
  const bundles = bundleOrder(m, around)

  // The first step's fetch pulls the whole object down; the rest of this
  // bundle then costs nothing but arithmetic.
  const fillStep = async (step: number) => {
    if (options.signal?.aborted) return
    const set: PlaneSet | null = await planesFor(m, level, bx, by, step, 'point', POINT_SPEC)
    if (!set) return
    sampleColumn(set, lon, lat, column)
    values[m.steps.indexOf(step)] = evaluate(column, elevation, m.levels, newValues(), terrain)
  }

  if (options.onProgress) {
    for (const bundle of bundles) {
      if (options.signal?.aborted) break
      const steps = m.steps.filter(step => bundleFor(m, step) === bundle)
      for (const step of steps) {
        if (options.signal?.aborted) break
        await fillStep(step)
      }
      options.onProgress({ values: [...values], elevation })
    }
  } else {
    await Promise.all(bundles.map(async bundle => {
      const steps = m.steps.filter(step => bundleFor(m, step) === bundle)
      for (const step of steps) {
        if (options.signal?.aborted) return
        await fillStep(step)
      }
    }))
  }

  return { values, elevation }
}
