import { describe, expect, it } from 'vitest'
import {
  blockOf, hasProfile, inLevelDomain, isCovered, levelBounds, levelForZoom, parseManifest,
} from '../src/pyramid'

// A minimal two-level manifest mirroring the real pyramid.ts table (l0/l1),
// plus a regional (non-global-lon) level for the domain-edge tests.
const raw = {
  format: 'CUB2',
  run_time: '2026-08-19T06:00:00Z',
  model_id: 'ecmwf-ifs',
  steps: [0, 3, 6],
  levels: [1000, 850],
  probe_bytes: 49152,
  static_key: 'abc123',
  bundles: [{ start: 0, end: 6, name: 'h000_h006' }],
  pyramid: [
    {
      name: 'l0', step_deg: 1.0, block_deg: 60, x: 6, y: 3,
      profile: false, min_zoom: 0, max_zoom: 3,
      blocks: [[0, 0], [1, 1]],
    },
    {
      name: 'l1', step_deg: 0.5, block_deg: 30, x: 12, y: 6,
      profile: true, min_zoom: 4, max_zoom: 5,
      blocks: [[0, 0]],
      profile_blocks: [[0, 0]],
    },
    {
      name: 'regional', step_deg: 0.25, block_deg: 10, x: 4, y: 3,
      profile: true, min_zoom: 6, max_zoom: 10,
      west_deg: -10, north_deg: 55, global_lon: false,
    },
  ],
}

const manifest = parseManifest(raw, 'base/path', 'base/static')

describe('parseManifest', () => {
  it('carries the run metadata through unchanged', () => {
    expect(manifest.modelId).toBe('ecmwf-ifs')
    expect(manifest.runTime).toBe('2026-08-19T06:00:00Z')
    expect(manifest.steps).toEqual([0, 3, 6])
  })

  it('defaults westDeg/northDeg/globalLon for a level that predates them', () => {
    const l0 = manifest.pyramid[0]!
    expect(l0.westDeg).toBe(-180)
    expect(l0.northDeg).toBe(90)
    expect(l0.globalLon).toBe(true)
  })

  it('keeps an explicit regional corner instead of the global default', () => {
    const regional = manifest.pyramid[2]!
    expect(regional.westDeg).toBe(-10)
    expect(regional.northDeg).toBe(55)
    expect(regional.globalLon).toBe(false)
  })
})

describe('levelForZoom', () => {
  it('picks the coarsest level that still covers the zoom', () => {
    expect(levelForZoom(manifest, 0).name).toBe('l0')
    expect(levelForZoom(manifest, 3).name).toBe('l0')
    expect(levelForZoom(manifest, 4).name).toBe('l1')
  })

  it('falls back to the finest level past every max zoom', () => {
    expect(levelForZoom(manifest, 20).name).toBe('regional')
  })
})

describe('blockOf / isCovered', () => {
  const l0 = manifest.pyramid[0]!

  it('resolves a coordinate to the right block indices', () => {
    // 60 deg blocks from -180/90: (0,0) is a coordinate in the top-left.
    expect(blockOf(l0, -170, 80)).toEqual([0, 0])
  })

  it('reports a listed block as covered and an unlisted one as not', () => {
    expect(isCovered(l0, 0, 0)).toBe(true)
    expect(isCovered(l0, 5, 2)).toBe(false)
  })

  it('treats an empty blocks list as "everything covered"', () => {
    // The regional level above lists no `blocks` at all.
    const regional = manifest.pyramid[2]!
    expect(isCovered(regional, 99, 99)).toBe(true)
  })
})

describe('hasProfile', () => {
  it('is false for a level with no vertical profile at all', () => {
    expect(hasProfile(manifest.pyramid[0]!, 0, 0)).toBe(false)
  })

  it('is true only for a block explicitly listed as profile-carrying', () => {
    const l1 = manifest.pyramid[1]!
    expect(hasProfile(l1, 0, 0)).toBe(true)
    expect(hasProfile(l1, 3, 3)).toBe(false)
  })
})

describe('levelBounds / inLevelDomain', () => {
  const regional = manifest.pyramid[2]!

  it('derives east/south from the corner plus the addressing space', () => {
    const bounds = levelBounds(regional)
    expect(bounds.west).toBe(-10)
    expect(bounds.north).toBe(55)
    expect(bounds.east).toBeCloseTo(-10 + 4 * 10, 6)
    expect(bounds.south).toBeCloseTo(55 - 3 * 10, 6)
  })

  it('is inside the domain within the regional bounds', () => {
    expect(inLevelDomain(regional, -5, 30)).toBe(true)
  })

  it('is outside the domain past the regional east/west edge, not clamped', () => {
    // This is the exact bug inLevelDomain exists to prevent: a coordinate
    // past a regional model's real edge must not silently read as "inside".
    expect(inLevelDomain(regional, 40, 30)).toBe(false)
  })

  it('never falls outside a global-lon level on longitude', () => {
    const l0 = manifest.pyramid[0]!
    expect(inLevelDomain(l0, 179.9, 0)).toBe(true)
    expect(inLevelDomain(l0, -179.9, 0)).toBe(true)
  })
})
