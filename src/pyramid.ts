/**
 * Where a coordinate lives in the cube, at the resolution the zoom deserves.
 *
 * The backend writes the same forecast at three resolutions, each four times
 * coarser with four times wider blocks. That is not a size optimisation, it is
 * what keeps the number of objects a viewport needs at a handful *at every
 * zoom*: drawing a world view from the finest level means 648 blocks and
 * ~125 MB to fill 1024 pixels from a 1440-column grid.
 *
 *   level  cell    block   blocks   zoom    profile
 *   l0     1.0°    60°     18       0-3     no
 *   l1     0.5°    30°     72       4-5     yes
 *   l2     0.25°   10°     648      6+      yes
 *
 * Level 0 carries no vertical profile: at 27 km per pixel there is no terrain
 * to correct for, so the surface fields answer everything it can draw.
 *
 * The table above is ECMWF's -- a global grid anchored at -180/90. A regional
 * model's own grid is not a crop of that one, it has its own corner, which is
 * why `westDeg`/`northDeg` ride along per level instead of being assumed.
 */

export type CubeLevel = {
  name: string
  stepDeg: number
  blockDeg: number
  nx: number
  ny: number
  profile: boolean
  minZoom: number
  maxZoom: number
  upsample: number
  covered: Set<string>
  hasProfile: Set<string>
  /** Where block (0, 0) starts. -180/90 for every level the world cube has
   *  ever written; a regional model's own corner otherwise. */
  westDeg: number
  northDeg: number
  /** True for a global grid (ECMWF): longitude wraps at the dateline, so a
   *  coordinate is never "outside" it. False for a regional grid (ICON-EU):
   *  east/west are a real edge of the model's own coverage, not the world's,
   *  and a coordinate past them has no forecast -- see `inLevelDomain`. */
  globalLon: boolean
}

export type CubeManifest = {
  format: string
  runTime: string
  modelId: string
  steps: number[]
  levels: number[]
  probeBytes: number
  staticKey: string
  bundles: { start: number; end: number; name: string }[]
  pyramid: CubeLevel[]
  base: string
  staticBase: string
}

type RawLevel = {
  name: string
  step_deg: number
  block_deg: number
  x: number
  y: number
  profile: boolean
  min_zoom: number
  max_zoom: number
  upsample?: number
  blocks?: [number, number][]
  profile_blocks?: [number, number][]
  west_deg?: number
  north_deg?: number
  global_lon?: boolean
}

const key = (bx: number, by: number) => `${bx},${by}`

export function parseManifest(raw: any, base: string, staticBase: string): CubeManifest {
  const pyramid: CubeLevel[] = (raw.pyramid ?? []).map((l: RawLevel) => ({
    name: l.name,
    stepDeg: l.step_deg,
    blockDeg: l.block_deg,
    nx: l.x,
    ny: l.y,
    profile: l.profile,
    minZoom: l.min_zoom,
    maxZoom: l.max_zoom,
    upsample: l.upsample ?? 4,
    covered: new Set((l.blocks ?? []).map(([bx, by]) => key(bx, by))),
    hasProfile: new Set((l.profile_blocks ?? []).map(([bx, by]) => key(bx, by))),
    // Absent on any manifest written before a level carried its own corner --
    // every one of those was the global ECMWF grid, so -180/90 and "wraps"
    // are the right backfill rather than a guess.
    westDeg: l.west_deg ?? -180,
    northDeg: l.north_deg ?? 90,
    globalLon: l.global_lon ?? true,
  }))

  return {
    format: raw.format,
    runTime: raw.run_time,
    modelId: raw.model_id,
    steps: raw.steps ?? [],
    levels: raw.levels ?? [],
    probeBytes: raw.probe_bytes ?? 49152,
    staticKey: raw.static_key ?? '',
    bundles: raw.bundles ?? [],
    pyramid,
    base,
    staticBase,
  }
}

/**
 * Coarse first, so a run written with only some levels still resolves:
 * nothing claims the low zooms and the finest level takes them.
 */
export function levelForZoom(manifest: CubeManifest, zoom: number): CubeLevel {
  for (const level of manifest.pyramid) {
    if (zoom <= level.maxZoom) return level
  }
  return manifest.pyramid[manifest.pyramid.length - 1]
}

export function blockOf(level: CubeLevel, lon: number, lat: number): [number, number] {
  return [
    Math.max(0, Math.min(level.nx - 1, Math.floor((lon - level.westDeg) / level.blockDeg))),
    Math.max(0, Math.min(level.ny - 1, Math.floor((level.northDeg - lat) / level.blockDeg))),
  ]
}

/**
 * The level's own geographic extent -- east/south derived the same way
 * `cubegrid.py`'s `Grid` does, from the corner plus the addressing space's
 * own span, not read off any single block.
 */
export function levelBounds(level: CubeLevel): { west: number; east: number; south: number; north: number } {
  return {
    west: level.westDeg,
    east: level.westDeg + level.nx * level.blockDeg,
    north: level.northDeg,
    south: level.northDeg - level.ny * level.blockDeg,
  }
}

/**
 * Whether a coordinate actually has a forecast on this level, as opposed to
 * merely resolving to *some* block index.
 *
 * `blockOf` clamps, on purpose -- for a global grid that is correct at the
 * poles, where there really is no more world to hand back a different
 * answer for. It is wrong for a regional grid's east/west/south edges: those
 * are where the model's own coverage happens to end, not the world's, and a
 * coordinate past them clamping onto the nearest real block would silently
 * paint that edge block's data over everywhere outside the model's domain --
 * which is the bug this function exists to stop callers from reintroducing.
 * Callers must check this *before* trusting a `blockOf`/`isCovered` result
 * for anything user-facing (a tile pixel, a map click).
 */
export function inLevelDomain(level: CubeLevel, lon: number, lat: number): boolean {
  const bounds = levelBounds(level)
  if (lat > bounds.north || lat < bounds.south) return false
  if (level.globalLon) return true
  return lon >= bounds.west && lon <= bounds.east
}

/**
 * A run restricted to a bbox writes only some blocks, and panning asks for any
 * of them. The manifest lists what exists, so uncovered ground renders empty
 * rather than turning into a wall of 404s.
 */
export function isCovered(level: CubeLevel, bx: number, by: number): boolean {
  return level.covered.size === 0 || level.covered.has(key(bx, by))
}

export function hasProfile(level: CubeLevel, bx: number, by: number): boolean {
  return level.profile && level.hasProfile.has(key(bx, by))
}

const pad2 = (n: number) => String(n).padStart(2, '0')
export const pad3 = (n: number) => String(n).padStart(3, '0')

export function blockUrl(m: CubeManifest, level: CubeLevel, bx: number, by: number, name: string): string {
  return `${m.base}/${level.name}/b${pad2(bx)}-${pad2(by)}/${name}`
}

/**
 * Static planes are model constants -- orography and the land-sea mask move
 * when ECMWF upgrades a cycle, a few times a year -- so they live beside the
 * run directories, keyed by content, and the browser cache carries them from
 * run to run.
 */
export function staticUrl(m: CubeManifest, level: CubeLevel, bx: number, by: number): string {
  return `${m.staticBase}/${level.name}/b${pad2(bx)}-${pad2(by)}/static.cub`
}

export function bundleFor(m: CubeManifest, stepH: number): string {
  for (const b of m.bundles) {
    if (stepH >= b.start && stepH <= b.end) return b.name
  }
  return m.bundles[m.bundles.length - 1]?.name ?? ''
}

/** The step at or before `stepH` that a window of `windowSteps` starts from. */
export function windowStart(m: CubeManifest, stepH: number, windowSteps: number): number | null {
  if (windowSteps <= 0) return null
  const idx = m.steps.indexOf(stepH)
  if (idx < 0) return null
  const prev = m.steps[Math.max(0, idx - windowSteps)]
  return prev === stepH ? null : prev
}
