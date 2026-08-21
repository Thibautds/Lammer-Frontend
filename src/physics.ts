/**
 * The downscaling, transcribed from the Python it has to agree with.
 *
 * `app.atmosphere.interpolate_profile_grid`'s clamped piecewise-linear lookup
 * and `app.terrain.classify_precipitation_type_hires`'s Jennings 2018
 * trivariate. Written to look like the originals so a reviewer can diff them
 * by eye.
 *
 * The split between here and `sampleColumn` is the factorisation the whole
 * format exists for, showing up in the render loop: reading the coarse grid is
 * horizontal work that cannot change over a few hundred metres of screen, and
 * this is the vertical work, which is where elevation enters and which
 * genuinely varies pixel to pixel.
 */

import type { Cube } from './format'
import { sample } from './format'

/**
 * Standard sea-level pressure, used where there is no profile to derive one
 * from. Real sea-level pressure spans about 96-105 kPa and in Jennings the
 * pressure term is 0.03 * p_kPa, so the whole range of weather moves the logit
 * by 0.27 against ±14 from temperature alone. A constant is below the noise of
 * the thing it feeds.
 */
const SEA_LEVEL_HPA = 1013.25

// worker.py's _diagnose_cloud_visibility_grid: the lowest saturated level above
// the terrain is the cloud base, and terrain standing above it is inside cloud.
const CLOUD_VIS_RH_THRESHOLD = 92.0
const CLOUD_VIS_CLOUD_MASK = 25.0

export type CubeColumn = {
  lon: number
  lat: number
  stepH: number
  hsurf: number
  lsm: number
  hasProfile: boolean
  heights: Float64Array
  temps: Float64Array
  rhs: Float64Array
  us: Float64Array
  vs: Float64Array
  t2mC: number
  r2: number
  fzl: number
  cloudPct: number
  snowDepthCm: number
  gustMs: number
  precipMm: number
}

/**
 * The terrain around a point, as the two things wind responds to.
 *
 * `ex`/`ey` are the horizontal part of the unit uphill vector -- the gradient
 * scaled by cos(slope) -- which is what makes the windward term a dot product.
 *
 * `zxx`/`zxy`/`zyy` are the second-derivative tensor. Not the Laplacian: their
 * *sum* is the Laplacian, and at a saddle the two principal curvatures cancel
 * to exactly zero, which is why a mountain pass got no treatment at all. Kept
 * separate, they can be projected onto the wind direction and the cancellation
 * becomes the two effects it was hiding.
 */
export type TerrainSlope = {
  ex: number; ey: number
  zxx: number; zxy: number; zyy: number
}

export type CubeValues = {
  lon: number
  lat: number
  stepH: number
  elevation: number
  hsurf: number
  lsm: number
  deltaH: number
  tempC: number
  relhumPct: number
  cloudPct: number
  snowDepthCm: number
  pressureHpa: number
  gustMs: number
  windMs: number
  windDirDeg: number
  freezingM: number
  freezeMargin: number
  precipMm: number
  rainMm: number
  snowMm: number
  snowFrac: number
  visibilityKm: number
}

/** The planes one block contributes to a column, for one step and one layer. */
export type PlaneSet = {
  cube: Cube
  stat: Cube | null
  stepH: number
  hsurf: Float32Array | null
  lsm: Float32Array | null
  hasProfile: boolean
  gh?: (Float32Array | null)[]
  t?: (Float32Array | null)[]
  r?: (Float32Array | null)[]
  u?: (Float32Array | null)[]
  v?: (Float32Array | null)[]
  t2m?: Float32Array | null
  r2?: Float32Array | null
  fzl?: Float32Array | null
  tcc?: Float32Array | null
  sd?: Float32Array | null
  gust?: Float32Array | null
  tp?: Float32Array | null
  tpPrev?: Float32Array | null
  prevCube?: Cube | null
}

/**
 * The scratch column exists because this runs once per pixel: 65,536 of them a
 * tile, and allocating five arrays for each would spend more time in the
 * collector than in the physics.
 */
export function newColumn(nLevels: number): CubeColumn {
  return {
    lon: 0, lat: 0, stepH: 0, hsurf: NaN, lsm: 1, hasProfile: false,
    heights: new Float64Array(nLevels),
    temps: new Float64Array(nLevels),
    rhs: new Float64Array(nLevels),
    us: new Float64Array(nLevels),
    vs: new Float64Array(nLevels),
    t2mC: NaN, r2: NaN, fzl: NaN,
    cloudPct: NaN, snowDepthCm: NaN, gustMs: NaN, precipMm: NaN,
  }
}

/** app.atmosphere.interpolate_profile_grid: clamp below the lowest level and
 *  above the highest, piecewise linear in between. Heights ascend. */
export function interpProfile(values: Float64Array, heights: Float64Array, h: number): number {
  const n = values.length
  if (!n) return NaN
  if (h <= heights[0]) return values[0]
  if (h >= heights[n - 1]) return values[n - 1]
  for (let i = 0; i < n - 1; i++) {
    const z0 = heights[i]
    const z1 = heights[i + 1]
    if (h >= Math.min(z0, z1) && h <= Math.max(z0, z1)) {
      const d = z1 - z0
      if (Math.abs(d) < 1e-6) return values[i]
      return values[i] + ((h - z0) / d) * (values[i + 1] - values[i])
    }
  }
  return values[n - 1]
}

/**
 * Pressure at an arbitrary height, from the levels themselves.
 *
 * No surface-pressure field ships, because the profile already determines
 * this exactly: pressure falls off log-linearly with height, so interpolating
 * log(p) against geopotential height is the hypsometric relation rather than
 * an approximation of it. Below the lowest level it extrapolates instead of
 * clamping -- under the 1000 hPa surface the pressure keeps rising, and
 * clamping would report sea-level air as if it sat at 110 m.
 */
export function pressureAt(heights: Float64Array, levels: number[], h: number): number {
  const n = levels.length
  const logp = new Float64Array(n)
  for (let i = 0; i < n; i++) logp[i] = Math.log(levels[i])
  if (h <= heights[0]) {
    const d = heights[1] - heights[0]
    if (Math.abs(d) < 1e-6) return levels[0]
    return Math.exp(logp[0] + ((h - heights[0]) / d) * (logp[1] - logp[0]))
  }
  if (h >= heights[n - 1]) return levels[n - 1]
  return Math.exp(interpProfile(logp, heights, h))
}

/**
 * How much the terrain speeds the wind up or shelters it, after Liston & Elder
 * (2006), the wind parameterisation in MicroMet -- windward slopes and ridge
 * crests accelerate, lee slopes and valley floors decelerate:
 *
 *     W = 1 + gamma_s * Omega_s + gamma_c * Omega_c
 *
 * The slope term factorises into a dot product, which is why this needs no
 * trigonometry and no shipped bytes. Writing out cos(theta - xi) * sin(slope)
 * and substituting the wind's own components leaves
 *
 *     Omega_s = (ex * u + ey * v) / |w|
 *
 * a *static* vector field dotted with the *coarse* wind -- the same
 * static(x) . coarse(t) factorisation the cube itself is built on, applied to
 * terrain instead of to height.
 *
 * Liston & Elder use a single isotropic curvature. This splits it, because
 * the sum is what fails: at a mountain pass the curvature across the gap and
 * the curvature along it are equal and opposite -- measured +1.22e-03 and
 * -1.22e-03, a Laplacian of exactly zero. A pass got neither speed-up nor
 * shelter, and passes are among the windiest ground there is.
 *
 * Split, the same geometry says the opposite twice over: you cross a col
 * (convex along the flow) *and* the walls converge (concave across it), so
 * both terms call for acceleration. That is the Venturi the sum was cancelling.
 *
 * The sign is deliberately not production's. `apply_terrain_wind_exposure`
 * takes aspect in the uphill convention and computes cos(wind_from - aspect),
 * which peaks when the wind arrives *from* uphill -- the lee. Measured on a
 * ridge in a southerly: production gives -0.287 on the windward face and
 * +0.287 in the lee. It shelters the slope the air piles up against and
 * accelerates the one it descends. This is the other way round.
 */
const WIND_GAMMA_SLOPE = 0.3
const WIND_GAMMA_CREST = 0.25
const WIND_GAMMA_CHANNEL = 0.25

/**
 * Length over which the terrain derivatives are taken, in metres. Curvature is
 * 1/m, so curvature * length is dimensionless -- measured at 0.38 on an alpine
 * crest and 0.15 on its flank, which is what makes this a scale rather than a
 * calibration.
 */
export const TERRAIN_SCALE_M = 250
// A crest at 0.38 lands at 0.76 of the range: strong, and still with room
// above it. The old fixed 5e-5 was 31x smaller than the terrain it was
// measuring, so every pixel pinned to the clip and the whole term collapsed
// into a direction-independent ridge/valley mask.
const CURVATURE_GAIN = 0.5

export function windTerrainFactor(terrain: TerrainSlope, u: number, v: number): number {
  const speed = Math.hypot(u, v)
  if (!(speed > 0.05) || !isFinite(terrain.ex) || !isFinite(terrain.ey)) return 1

  // Windward faces accelerate, lee faces shelter.
  const omegaS = (terrain.ex * u + terrain.ey * v) / speed

  // The Hessian projected onto the flow. `dx`/`dy` point downwind, `nx`/`ny`
  // across it.
  const dx = u / speed, dy = v / speed
  const nx = -dy, ny = dx
  const along = terrain.zxx * dx * dx + 2 * terrain.zxy * dx * dy + terrain.zyy * dy * dy
  const across = terrain.zxx * nx * nx + 2 * terrain.zxy * nx * ny + terrain.zyy * ny * ny

  const clip = (x: number) => Math.max(-1, Math.min(1, x))
  // Convex along the flow means going over a crest: the air is squeezed
  // against the terrain above it and speeds up. Negative curvature, positive
  // effect, hence the sign.
  const omegaCrest = isFinite(along)
    ? clip((-along * TERRAIN_SCALE_M) / CURVATURE_GAIN) : 0
  // Concave across the flow means walls rising on both sides: the same air
  // through a narrower gap. This is the term a Laplacian cannot express, and
  // the only one that speaks at a pass.
  const omegaChannel = isFinite(across)
    ? clip((across * TERRAIN_SCALE_M) / CURVATURE_GAIN) : 0

  return Math.max(0.3, Math.min(1.8,
    1 + WIND_GAMMA_SLOPE * omegaS
      + WIND_GAMMA_CREST * omegaCrest
      + WIND_GAMMA_CHANNEL * omegaChannel))
}

/** app.terrain.classify_precipitation_type_hires, trivariate branch. */
export function snowFraction(tC: number, rh: number, pHpa: number): number {
  if (!isFinite(tC)) return NaN
  if (!isFinite(rh)) return tC <= 0.5 ? 1 : tC >= 2.5 ? 0 : (2.5 - tC) / 2.0
  const rhc = Math.max(0, Math.min(100, rh))
  let linear = -10.04 - 1.41 * tC + 0.09 * rhc
  if (isFinite(pHpa)) linear = -12.8 - 1.41 * tC + 0.09 * rhc + 0.03 * (pHpa / 10)
  let p = 1 / (1 + Math.exp(-linear))
  if (p <= 0.01) p = 0
  if (p >= 0.99) p = 1
  return p
}

/**
 * Metres the terrain stands up inside cloud, or NaN when it does not.
 *
 * Transcribed from worker.py's `_diagnose_cloud_visibility_grid`: find the
 * lowest saturated level at or above the terrain, interpolate the RH crossing
 * for a smoother base than the raw level height, and compare. Model-agnostic
 * by construction -- it reads the humidity profile rather than a cloud-base
 * field no open-data stream publishes.
 */
export function cloudDepth(col: CubeColumn, h: number): number {
  if (!col.hasProfile) return NaN
  if (isFinite(col.cloudPct) && col.cloudPct < CLOUD_VIS_CLOUD_MASK) return NaN

  const n = col.heights.length
  for (let i = 0; i < n; i++) {
    if (col.heights[i] < h) continue
    if (!(col.rhs[i] >= CLOUD_VIS_RH_THRESHOLD)) continue

    let base = col.heights[i]
    if (i > 0) {
      const denom = col.rhs[i] - col.rhs[i - 1]
      if (Math.abs(denom) > 1e-3) {
        const frac = Math.min(1, Math.max(0, (CLOUD_VIS_RH_THRESHOLD - col.rhs[i - 1]) / denom))
        base = col.heights[i - 1] + frac * (col.heights[i] - col.heights[i - 1])
      }
    }
    const depth = h - base
    return depth > 0 ? depth : NaN
  }
  return NaN
}

/**
 * Horizontal visibility in km, transcribed from worker.py's
 * `_estimate_visibility_grid`, which mirrors the detail pages.
 *
 * ECMWF open data publishes no visibility field, so the cube carries none --
 * but it never needed to: production does not ship a model field either, it
 * derives this from cloud, precipitation, wind and humidity, and the cube has
 * all four. Defined everywhere rather than NaN; the ramp fades it out above
 * the clear threshold.
 */
export function visibilityKm(
  cloudPct: number, rainMm: number, snowMm: number, windMs: number,
  rhPct: number, inCloudDepth: number,
): number {
  let vis = 22.0
  if (isFinite(cloudPct)) vis -= cloudPct * 0.16
  let precip = 0
  if (isFinite(rainMm)) precip += rainMm * 1.8
  if (isFinite(snowMm)) precip += snowMm * 2.0
  vis -= Math.min(14.0, precip)
  if (isFinite(windMs)) {
    const kmh = windMs * 3.6
    if (kmh > 40.0) vis -= (kmh - 40.0) * 0.05
  }
  if (isFinite(rhPct) && rhPct >= 97.0) vis = Math.min(vis, 0.4)
  if (isFinite(inCloudDepth)) vis = Math.min(vis, 0.08)
  return Math.min(50.0, Math.max(0.05, vis))
}

/** Read the coarse grid at one coordinate. Arrays the layer did not ask for
 *  are filled with NaN rather than left stale, so the vertical lookup over
 *  them returns NaN and a readout says "not computed" instead of "zero". */
export function sampleColumn(set: PlaneSet, lon: number, lat: number, out: CubeColumn): CubeColumn {
  const c = set.cube
  const n = out.heights.length
  out.lon = lon
  out.lat = lat
  out.stepH = set.stepH
  out.hsurf = set.hsurf && set.stat ? sample(set.stat, set.hsurf, lon, lat) : NaN
  out.lsm = set.lsm && set.stat ? sample(set.stat, set.lsm, lon, lat) : 1

  out.hasProfile = set.hasProfile
  for (let i = 0; i < n; i++) {
    out.heights[i] = set.gh ? sample(c, set.gh[i], lon, lat) : NaN
    out.temps[i] = set.t ? sample(c, set.t[i], lon, lat) - 273.15 : NaN
    out.rhs[i] = set.r ? sample(c, set.r[i], lon, lat) : NaN
    out.us[i] = set.u ? sample(c, set.u[i], lon, lat) : NaN
    out.vs[i] = set.v ? sample(c, set.v[i], lon, lat) : NaN
  }
  if (out.hasProfile) {
    out.hasProfile = isFinite(out.heights[0]) && isFinite(out.heights[n - 1])
  }

  out.t2mC = set.t2m ? sample(c, set.t2m, lon, lat) - 273.15 : NaN
  out.r2 = set.r2 ? sample(c, set.r2, lon, lat) : NaN
  out.fzl = set.fzl ? sample(c, set.fzl, lon, lat) : NaN
  out.cloudPct = set.tcc ? sample(c, set.tcc, lon, lat) : NaN
  out.snowDepthCm = set.sd ? sample(c, set.sd, lon, lat) : NaN
  out.gustMs = set.gust ? sample(c, set.gust, lon, lat) : NaN

  // Cumulative in, so any window is one subtraction -- and the quantisation
  // error stays at one step no matter how wide the window.
  if (set.tp) {
    const now = sample(c, set.tp, lon, lat)
    const prev = set.tpPrev && set.prevCube ? sample(set.prevCube, set.tpPrev, lon, lat) : 0
    out.precipMm = Math.max(0, (now || 0) - (prev || 0))
  } else {
    out.precipMm = NaN
  }
  return out
}

/** Apply the column at one elevation. This is the only part that varies from
 *  pixel to pixel within a source cell, which is the whole point. */
export function evaluate(
  col: CubeColumn,
  elevation: number,
  levels: number[],
  out: CubeValues,
  terrain: TerrainSlope | null = null,
): CubeValues {
  const raw = isFinite(elevation) ? elevation : col.hsurf
  // Terrarium encodes bathymetry, so open water comes back at -4000 m and the
  // profile would obligingly report the temperature of the sea floor. At sea
  // the altitude is zero -- that is the whole reason the profile is land-only.
  // Clamped by the mask rather than everywhere, so the Dead Sea shore stays at
  // -430 m.
  const h = col.lsm < 0.5 ? Math.max(0, raw) : raw
  const p = col.hasProfile

  // With a profile, everything is interpolated to h. Without one -- open
  // ocean, or the world view where terrain is smaller than a pixel -- the
  // surface fields answer directly, and at zero elevation the 2 m diagnostic
  // *is* the answer rather than an approximation of it.
  const tC = p ? interpProfile(col.temps, col.heights, h) : col.t2mC
  const rh = p ? interpProfile(col.rhs, col.heights, h) : col.r2
  const pressure = p ? pressureAt(col.heights, levels, h) : SEA_LEVEL_HPA
  const snowFrac = snowFraction(tC, rh, pressure)

  out.lon = col.lon
  out.lat = col.lat
  out.stepH = col.stepH
  out.elevation = h
  out.hsurf = col.hsurf
  out.lsm = col.lsm
  out.deltaH = h - col.hsurf
  out.tempC = tC
  out.relhumPct = rh
  out.cloudPct = col.cloudPct
  out.snowDepthCm = col.snowDepthCm
  out.pressureHpa = pressure
  out.gustMs = col.gustMs

  if (p) {
    const u = interpProfile(col.us, col.heights, h)
    const v = interpProfile(col.vs, col.heights, h)
    // The profile gives free-atmosphere wind at this altitude, which is right
    // on an exposed summit and too strong on a valley floor. The terrain
    // factor is what tells those apart.
    out.windMs = Math.hypot(u, v) * (terrain ? windTerrainFactor(terrain, u, v) : 1)
    out.windDirDeg = (Math.atan2(u, v) * 180) / Math.PI
    if (out.windDirDeg < 0) out.windDirDeg += 360
  } else {
    out.windMs = NaN
    out.windDirDeg = NaN
  }

  // Shipped, not derived: the 0 C isotherm is a property of the air column and
  // does not move with the ground under it, so one number per cell answers it
  // for every pixel at any elevation. That is what makes it worth two bytes on
  // the server instead of twelve plane fetches and a crossing search per pixel
  // here -- and it is why this works over the sea.
  out.freezingM = col.fzl
  // How far the ground stands above the 0 C line. Positive = frozen terrain.
  // This is what production calls `freezing_level`, and what it actually
  // computes there is `dem - (dem + T*150)`, in which the DEM cancels and what
  // is left is -150*T: a temperature wearing the units of a height. Here the
  // isotherm comes from the profile, so the DEM survives the subtraction.
  out.freezeMargin = h - col.fzl

  out.precipMm = col.precipMm
  out.rainMm = col.precipMm * (1 - snowFrac)
  out.snowMm = col.precipMm * snowFrac
  out.snowFrac = snowFrac
  out.visibilityKm = visibilityKm(
    col.cloudPct, out.rainMm, out.snowMm, out.windMs, rh, cloudDepth(col, h))
  return out
}

export function newValues(): CubeValues {
  return {
    lon: 0, lat: 0, stepH: 0, elevation: NaN, hsurf: NaN, lsm: 1, deltaH: NaN,
    tempC: NaN, relhumPct: NaN, cloudPct: NaN, snowDepthCm: NaN, pressureHpa: NaN,
    gustMs: NaN, windMs: NaN, windDirDeg: NaN, freezingM: NaN, freezeMargin: NaN,
    precipMm: NaN, rainMm: NaN, snowMm: NaN, snowFrac: NaN, visibilityKm: NaN,
  }
}
