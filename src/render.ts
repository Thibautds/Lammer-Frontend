/**
 * One map tile, rendered from the cube.
 *
 * Every pixel gets its own column. An earlier version of this in the demo
 * viewer sampled the coarse grid once per 8x8 pixel block, on the reasoning
 * that a 28 km field cannot vary faster than that. True of the field, false of
 * the *rendering*: at low zoom an 8-pixel block spans nearly three source
 * cells, so the bilinear interpolation was thrown away and replaced with a
 * staircase. What makes per-pixel affordable is that the loop allocates
 * nothing -- one scratch column and one scratch result, reused 65,536 times.
 */

import type { OverlayType } from './types'
import { renderPrecipitationTypeOverlay, renderSinglePlaneOverlay } from './ramps'
import type { Cube } from './format'
import { openCube, plane, prefetchAll } from './format'
import type { CubeColumn, CubeValues, PlaneSet, TerrainSlope } from './physics'
import { evaluate, newColumn, newValues, sampleColumn, TERRAIN_SCALE_M } from './physics'
import type { CubeLevel, CubeManifest } from './pyramid'
import {
  blockOf, blockUrl, bundleFor, hasProfile, isCovered, levelBounds, levelForZoom, pad3, staticUrl, windowStart,
} from './pyramid'

const TILE = 256

// A default, not a Lammer-specific dependency: AWS's own public
// elevation-tiles-prod dataset, Terrarium-encoded. Fine for development;
// see the methodology docs on why fronting a copy behind a nearby edge is
// worth doing for production traffic. A plain module-level variable
// rather than a parameter threaded through every call in the render path
// (`renderCubeTile` -> `demSampler` -> `demTile`) -- this is
// "configure once at startup," not something that varies per call, so a
// setter is simpler for a caller than an options object at every layer.
let TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

/** Point DEM/terrain sampling at a different Terrarium-encoded tile
 *  source (same `{z}/{x}/{y}.png` template convention). */
export function setTerrainTileUrl(template: string) {
  TERRARIUM_URL = template
}

/**
 * Terrarium's pyramid stops here. Past it the tiles 404, the elevation comes
 * back NaN and the render falls back to the model orography -- so past z15 the
 * map would quietly show the *uncorrected* 28 km field, which reads as the
 * downscaling breaking rather than as running out of DEM. Overzooming an
 * ancestor is honest about what it is: no new detail, but the correction keeps
 * working.
 */
export const DEM_MAX_ZOOM = 15

type SurfaceField = 'tp' | 'tcc' | 'sd' | 'gust' | 't2m' | 'r2' | 'fzl'
type ProfileField = 't' | 'r' | 'u' | 'v'

/**
 * What each overlay reads, and nothing else is fetched, decoded or refined.
 * `profileNeeds` are loaded only where the block actually carries a profile;
 * `gh` comes along automatically, since without heights there is nothing to
 * interpolate against.
 *
 * `window` is how many steps back the accumulation runs, and it is chosen to
 * match what the old server-rendered grids meant: the accumulated layers ramp
 * to 200 mm and were accumulated since run start, precipitation_type ramps to
 * 50 mm and was per step.
 */
type LayerSpec = {
  needs: SurfaceField[]
  profileNeeds?: ProfileField[]
  window: number
  /** Absent for precipitation_type, which paints from rain and snow together. */
  pick?: (v: CubeValues) => number
  /** Fetch the whole object rather than ranging into it. See prefetchAll. */
  whole?: boolean
}

const LAYERS: Record<OverlayType, LayerSpec | null> = {
  temperature: { needs: ['t2m'], profileNeeds: ['t'], window: 0, pick: v => v.tempC },
  precipitation_type: { needs: ['tp', 't2m', 'r2'], profileNeeds: ['t', 'r'], window: 1 },
  rain_accumulated: { needs: ['tp', 't2m', 'r2'], profileNeeds: ['t', 'r'], window: 0, pick: v => v.rainMm },
  snow_accumulated: { needs: ['tp', 't2m', 'r2'], profileNeeds: ['t', 'r'], window: 0, pick: v => v.snowMm },
  snow_depth: { needs: ['sd'], window: 0, pick: v => v.snowDepthCm },
  wind_speed: { needs: [], profileNeeds: ['u', 'v'], window: 0, pick: v => v.windMs },
  wind_gust: { needs: ['gust'], window: 0, pick: v => v.gustMs },
  cloud_cover: { needs: ['tcc'], window: 0, pick: v => v.cloudPct },
  freezing_level: { needs: ['fzl'], window: 0, pick: v => v.freezeMargin },
  // Production does not ship a model visibility field either -- it derives one
  // from cloud, precipitation, wind and humidity, and the cube has all four.
  // The wind term needs u/v, the fog term needs the humidity profile to find
  // the cloud base, so this is the one layer that reads nearly everything.
  visibility: {
    needs: ['tcc', 'tp', 't2m', 'r2'],
    profileNeeds: ['t', 'r', 'u', 'v'],
    window: 1,
    pick: v => v.visibilityKm,
  },
}

export function cubeSupports(overlay: OverlayType): boolean {
  return LAYERS[overlay] !== null
}

// ── Elevation ────────────────────────────────────────────────────────

const demCache = new Map<string, Promise<Float32Array | null>>()

function tile2lon(x: number, z: number) { return (x / Math.pow(2, z)) * 360 - 180 }
function tile2lat(y: number, z: number) {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z)
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
}

function demTile(z: number, x: number, y: number): Promise<Float32Array | null> {
  const key = `${z}/${x}/${y}`
  let pending = demCache.get(key)
  if (!pending) {
    const url = TERRARIUM_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
    pending = fetch(url)
      .then(async response => {
        if (!response.ok) return null
        const bitmap = await createImageBitmap(await response.blob())
        const canvas = new OffscreenCanvas(TILE, TILE)
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return null
        ctx.drawImage(bitmap, 0, 0, TILE, TILE)
        const px = ctx.getImageData(0, 0, TILE, TILE).data
        const out = new Float32Array(TILE * TILE)
        for (let i = 0; i < out.length; i++) {
          out[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768
        }
        return out
      })
      .catch(() => null)
    demCache.set(key, pending)
  }
  return pending
}

async function demSampler(z: number, x: number, y: number): Promise<((px: number, py: number) => number) | null> {
  const over = Math.max(0, z - DEM_MAX_ZOOM)
  const data = await demTile(z - over, x >> over, y >> over)
  if (!data) return null
  if (over === 0) return (px, py) => data[py * TILE + px]

  const n = 1 << over
  const ox = ((x - ((x >> over) << over)) * TILE) / n
  const oy = ((y - ((y >> over) << over)) * TILE) / n
  return (px, py) => data[(((oy + py / n) | 0) * TILE) + (((ox + px / n) | 0))]
}

/**
 * Terrain derivatives at a fixed *physical* scale, from the DEM tile already
 * in hand. No bytes shipped: slope, aspect and curvature are finite
 * differences on elevation, and the renderer has the elevation.
 *
 * The stride is the point. Differencing adjacent pixels measures a slope whose
 * scale changes with zoom -- 5 m at z15, 600 m at z8 -- so the wind pattern
 * would shift as you zoomed, which reads as a bug rather than as detail. The
 * derivative is taken over a fixed 250 m instead, and that stride doubles as
 * the low-pass: a difference over 50 pixels has no pixel noise left to smooth
 * away, so no gaussian is needed and no halo from the neighbouring tiles
 * either.
 *
 * Second derivatives come out as the three components of the Hessian rather
 * than as their sum. See `windTerrainFactor`: the sum is a Laplacian, and a
 * Laplacian is exactly zero at a mountain pass.
 */

export async function terrainSampler(
  z: number, x: number, y: number,
): Promise<((px: number, py: number) => TerrainSlope) | null> {
  const over = Math.max(0, z - DEM_MAX_ZOOM)
  const zz = z - over
  const data = await demTile(zz, x >> over, y >> over)
  if (!data) return null

  const lat = tile2lat((y >> over) + 0.5, zz)
  const metresPerPixel = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zz) 
  const stride = Math.max(1, Math.round(TERRAIN_SCALE_M / Math.max(metresPerPixel, 1e-6)))
  const span = stride * metresPerPixel

  const n = 1 << over
  const ox = ((x - ((x >> over) << over)) * TILE) / n
  const oy = ((y - ((y >> over) << over)) * TILE) / n
  const at = (cx: number, cy: number) => {
    const ix = Math.max(0, Math.min(TILE - 1, cx))
    const iy = Math.max(0, Math.min(TILE - 1, cy))
    return data[iy * TILE + ix]
  }

  const out: TerrainSlope = { ex: 0, ey: 0, zxx: 0, zxy: 0, zyy: 0 }
  const span2 = span * span
  return (px, py) => {
    const cx = ((ox + px / n) | 0)
    const cy = ((oy + py / n) | 0)
    const zc = at(cx, cy)
    const zE = at(cx + stride, cy)
    const zW = at(cx - stride, cy)
    // Rows run north to south, so a step down the array is a step south.
    const zS = at(cx, cy + stride)
    const zN = at(cx, cy - stride)
    const zNE = at(cx + stride, cy - stride)
    const zNW = at(cx - stride, cy - stride)
    const zSE = at(cx + stride, cy + stride)
    const zSW = at(cx - stride, cy + stride)

    const dzdx = (zE - zW) / (2 * span)
    const dzdy = (zN - zS) / (2 * span)
    // cos(slope) turns the gradient into the horizontal part of the unit
    // uphill vector, which is what the exposure dot product wants.
    const cosSlope = 1 / Math.hypot(1, Math.hypot(dzdx, dzdy))
    out.ex = dzdx * cosSlope
    out.ey = dzdy * cosSlope
    out.zxx = (zE + zW - 2 * zc) / span2
    out.zyy = (zN + zS - 2 * zc) / span2
    out.zxy = (zNE - zNW - zSE + zSW) / (4 * span2)
    return out
  }
}

// ── Planes for one block ─────────────────────────────────────────────

const planeSets = new Map<string, Promise<PlaneSet | null>>()

export function clearPlaneSets() {
  planeSets.clear()
}

/**
 * Keyed by overlay as well as by block, because the overlay decides what gets
 * fetched at all. Cloud cover is one plane out of the ~800 in a bundle; a
 * version that built the full profile regardless decoded and refined thirty it
 * never touched.
 */
export function planesFor(
  m: CubeManifest,
  level: CubeLevel,
  bx: number,
  by: number,
  stepH: number,
  key: string,
  spec: LayerSpec | null = LAYERS[key as OverlayType],
): Promise<PlaneSet | null> {
  if (!spec || !isCovered(level, bx, by)) return Promise.resolve(null)

  const cacheKey = [level.name, bx, by, stepH, key].join('/')
  const cached = planeSets.get(cacheKey)
  if (cached) return cached

  const load = (async (): Promise<PlaneSet | null> => {
    const cube = await openCube(blockUrl(m, level, bx, by, bundleFor(m, stepH)), level.upsample, m.probeBytes)
    if (!cube) return null
    // A caller that wants nearly every plane of this object is better served
    // by one request than by dozens of ranges into it.
    if (spec.whole) await prefetchAll(cube)

    const tag = `@h${pad3(stepH)}`
    const set: PlaneSet = { cube, stat: null, stepH, hsurf: null, lsm: null, hasProfile: false }

    // Always: the model's own orography, and the mask that says whether a
    // pixel's DEM elevation should be believed.
    const stat = await openCube(staticUrl(m, level, bx, by), level.upsample, m.probeBytes)
    if (stat) {
      set.stat = stat
      const [hsurf, lsm] = await Promise.all([plane(stat, 'hsurf'), plane(stat, 'lsm')])
      set.hsurf = hsurf
      set.lsm = lsm
    }

    const jobs: Promise<unknown>[] = []
    for (const field of spec.needs) {
      jobs.push(plane(cube, field + tag).then(p => { (set as Record<string, unknown>)[field] = p }))
    }

    if (spec.profileNeeds && hasProfile(level, bx, by)) {
      set.hasProfile = true
      for (const field of new Set<string>([...spec.profileNeeds, 'gh'])) {
        jobs.push(
          Promise.all(m.levels.map(l => plane(cube, `${field}@${l}${tag}`)))
            .then(ps => { (set as Record<string, unknown>)[field] = ps }),
        )
      }
    }

    if (spec.needs.includes('tp')) {
      const prevH = windowStart(m, stepH, spec.window)
      if (prevH !== null) {
        jobs.push((async () => {
          const prev = await openCube(blockUrl(m, level, bx, by, bundleFor(m, prevH)), level.upsample, m.probeBytes)
          if (!prev) return
          set.prevCube = prev
          set.tpPrev = await plane(prev, `tp@h${pad3(prevH)}`)
        })())
      }
    }

    await Promise.all(jobs)
    return set
  })()

  planeSets.set(cacheKey, load)
  return load
}

// ── The tile ─────────────────────────────────────────────────────────

let transparentImageData: ImageData | null = null

/**
 * "Nothing here" has to be a real image -- a raster source handed a
 * zero-length buffer errors and then retries the tile forever. An
 * `ImageData` of all zeros *is* fully transparent 256x256 pixels already, so
 * there is nothing to draw or decode: `createImageBitmap` just needs asking,
 * cheaply, and repeatably -- see `renderCubeTile`'s own return for why a
 * bitmap and not a PNG buffer is the thing handed back at all.
 */
export async function transparent(): Promise<ImageBitmap> {
  if (!transparentImageData) transparentImageData = new ImageData(TILE, TILE)
  return createImageBitmap(transparentImageData)
}

/**
 * The step the cube can actually answer.
 *
 * The timeline is driven by the production run, which has 65 steps; a trial
 * cube written with `--steps 2` has h000 and h003. Asking it for h042 finds
 * every plane missing, and the tile comes out uniformly NaN -- which the ramps
 * paint as fully transparent, so the map looks like the cube is not wired up
 * at all rather than like it is missing that hour.
 *
 * Snapping to the nearest step it does have keeps a partial run visible, and
 * saying so once keeps it honest about what is being drawn.
 */
const snapped = new Set<string>()
const emptyWarned = new Set<string>()

export function resolveStep(m: CubeManifest, stepH: number): number {
  if (m.steps.includes(stepH)) return stepH
  let best = m.steps[0] ?? stepH
  for (const s of m.steps) {
    if (Math.abs(s - stepH) < Math.abs(best - stepH)) best = s
  }
  const note = `${stepH}->${best}`
  if (!snapped.has(note)) {
    snapped.add(note)
    console.warn(`[cube] run has no +${stepH} h (it has ${m.steps.length} steps: ` +
                 `${m.steps.slice(0, 8).join(', ')}${m.steps.length > 8 ? ', …' : ''}); ` +
                 `drawing +${best} h instead`)
  }
  return best
}

export async function renderCubeTile(
  m: CubeManifest,
  z: number,
  x: number,
  y: number,
  overlay: OverlayType,
  requestedStep: number,
): Promise<ImageBitmap> {
  const spec = LAYERS[overlay]
  if (!spec) return transparent()
  const stepH = resolveStep(m, requestedStep)

  const level = levelForZoom(m, z)
  const west = tile2lon(x, z)
  const east = tile2lon(x + 1, z)
  const north = tile2lat(y, z)
  const south = tile2lat(y + 1, z)

  // A regional model's east/west/south edges are where its own coverage
  // ends, not the world's -- a tile entirely past them has no forecast at
  // all, not the nearest edge block's data. (A global grid never fails this:
  // its longitude wraps and its latitude bound is +/-90, past which no real
  // tile ever asks.) Checked before fetching anything, so panning outside a
  // regional model's domain costs nothing.
  const bounds = levelBounds(level)
  if (north < bounds.south || south > bounds.north
      || (!level.globalLon && (east < bounds.west || west > bounds.east))) {
    return transparent()
  }

  // Longitude is linear across a tile; latitude is not. Interpolating it
  // linearly between the tile's north and south edges misplaces the field by
  // degrees at low zoom, because the tile is uniform in Mercator y.
  const lonOf = new Float64Array(TILE)
  const latOf = new Float64Array(TILE)
  for (let i = 0; i < TILE; i++) {
    lonOf[i] = west + (east - west) * ((i + 0.5) / TILE)
    latOf[i] = tile2lat(y + (i + 0.5) / TILE, z)
  }

  // Which blocks the tile touches, derived from its corners rather than
  // sampled on a lattice: a 9x9 probe steps 11.25 degrees at z2 across
  // 10-degree blocks, so whole blocks fall between probes and render as
  // transparent stripes.
  const [bx0, by0] = blockOf(level, west, north)
  const [bx1, by1] = blockOf(level, east, south)
  const wanted: [number, number][] = []
  for (let by = by0; by <= by1; by++) {
    for (let bx = bx0; bx <= bx1; bx++) wanted.push([bx, by])
  }

  // In parallel. Awaiting inside the loop would make a world view 648 round
  // trips end to end.
  //
  // The DEM/terrain fetch is fired alongside the block fetch rather than
  // after it, for the same reason: it is a request to a different origin
  // (Terrarium, not R2) with nothing in common with a cube block, so waiting
  // for the blocks to land first before even starting it was a whole extra
  // network+decode round trip of pure latency on every uncached tile --
  // exactly the case a first load hits hardest, before either cache is warm.
  // No DEM where there is no profile to correct with it: at level 0 a pixel
  // is 27 km, the model orography *is* the terrain at that scale, and
  // fetching and decoding Terrarium tiles for it is pure cost. Only the
  // layers that read wind pay for the terrain derivatives on top of that.
  const needsTerrain = overlay === 'wind_speed' || overlay === 'visibility'
  const demPromise = level.profile ? demSampler(z, x, y) : Promise.resolve(null)
  const terrainPromise = needsTerrain && level.profile ? terrainSampler(z, x, y) : Promise.resolve(null)

  const sets = new Map<string, PlaneSet | null>()
  const blocksPromise = Promise.all(wanted.map(async ([bx, by]) => {
    sets.set(`${bx},${by}`, await planesFor(m, level, bx, by, stepH, overlay))
  }))

  const [, demAt, terrainAt] = await Promise.all([blocksPromise, demPromise, terrainPromise])

  const usable = [...sets.values()].filter(Boolean) as PlaneSet[]
  if (!usable.length) return transparent()

  // A block can be found and still answer nothing: the object exists but does
  // not carry this step, or this field. That renders as a uniformly NaN tile,
  // which the ramps paint fully transparent -- indistinguishable from the
  // overlay not being wired up at all. Say it once instead.
  if (spec.needs.length && usable.every(set => spec.needs.every(f => !set[f]))) {
    const note = `${overlay}@${stepH}`
    if (!emptyWarned.has(note)) {
      emptyWarned.add(note)
      console.warn(`[cube] ${overlay} at +${stepH} h: blocks found, but none of ` +
                   `[${spec.needs.join(', ')}] is in them — nothing to draw`)
    }
  }

  const cells = TILE * TILE
  const isPrecipType = overlay === 'precipitation_type'
  const column: CubeColumn = newColumn(m.levels.length)
  const values: CubeValues = newValues()

  // The ramps paint from a flat grid, the same shape the old LOG1 renderer
  // handed them -- which is what makes an old-versus-new comparison a
  // comparison of the data rather than of two colour tables.
  const field = new Float32Array(isPrecipType ? cells * 2 : cells)

  for (let py = 0; py < TILE; py++) {
    const lat = latOf[py]
    const latOutside = lat > bounds.north || lat < bounds.south
    // Same formula as pyramid.ts's blockOf, inlined for the per-pixel cost --
    // must read the level's own corner rather than assume -180/90, or every
    // pixel looks up the wrong block on any grid that is not ECMWF's global
    // one. Fetching the right blocks above and then mis-indexing into them
    // here is exactly the bug this once was: no exception anywhere, every
    // lookup below just misses and the tile renders fully transparent.
    const by = Math.max(0, Math.min(level.ny - 1, Math.floor((level.northDeg - lat) / level.blockDeg)))
    for (let px = 0; px < TILE; px++) {
      const i = py * TILE + px
      const lon = lonOf[px]
      // The whole-tile check above only rules out a tile with *no* overlap
      // at all; one straddling a regional model's edge still reaches here,
      // and the pixels past the edge must not clamp onto the block next to
      // them -- that block is real, its data just does not extend this far.
      const lonOutside = !level.globalLon && (lon < bounds.west || lon > bounds.east)
      if (latOutside || lonOutside) {
        field[i] = NaN
        if (isPrecipType) field[cells + i] = NaN
        continue
      }
      const bx = Math.max(0, Math.min(level.nx - 1, Math.floor((lon - level.westDeg) / level.blockDeg)))
      const set = sets.get(`${bx},${by}`)
      if (!set) {
        field[i] = NaN
        if (isPrecipType) field[cells + i] = NaN
        continue
      }
      sampleColumn(set, lon, lat, column)
      evaluate(column, demAt ? demAt(px, py) : NaN, m.levels, values,
               terrainAt ? terrainAt(px, py) : null)
      if (isPrecipType) {
        field[i] = values.rainMm
        field[cells + i] = values.snowMm
      } else {
        field[i] = spec.pick!(values)
      }
    }
  }

  const grid = {
    west, south, east, north,
    rows: TILE, cols: TILE,
    planeCount: isPrecipType ? 2 : 1,
    data: field,
  }
  const rgba = isPrecipType
    ? renderPrecipitationTypeOverlay(grid)
    : renderSinglePlaneOverlay(grid, overlay)
  if (!rgba) return transparent()

  // Straight to a bitmap, no canvas and no PNG in between: MapLibre's own
  // image-loading path accepts an `ImageBitmap` back from `addProtocol`
  // as-is (its own source says so -- "User using addProtocol can directly
  // return HTMLImageElement/ImageBitmap type"), and otherwise takes
  // whatever ArrayBuffer it gets back and runs it straight through
  // `createImageBitmap` itself. Encoding to PNG here bought nothing but a
  // compress-then-immediately-decompress round trip on every tile, paid
  // in full on every cold first load -- exactly the moment this is slowest.
  //
  // Copied into a fresh buffer because ImageData will not take a view whose
  // backing store TypeScript cannot prove is a plain ArrayBuffer.
  const pixels = new Uint8ClampedArray(rgba.length)
  pixels.set(rgba)
  return createImageBitmap(new ImageData(pixels, TILE, TILE))
}

export type { Cube, LayerSpec }
export { LAYERS, demSampler, demTile, tile2lat, tile2lon, TILE }
