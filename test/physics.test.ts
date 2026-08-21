import { describe, expect, it } from 'vitest'
import { interpProfile, pressureAt, snowFraction, windTerrainFactor } from '../src/physics'
import type { TerrainSlope } from '../src/physics'

describe('interpProfile', () => {
  const heights = new Float64Array([0, 1000, 2000, 3000])
  const temps = new Float64Array([20, 13.5, 7, 0.5])

  it('clamps below the lowest level', () => {
    expect(interpProfile(temps, heights, -500)).toBe(20)
  })

  it('clamps above the highest level', () => {
    expect(interpProfile(temps, heights, 5000)).toBe(0.5)
  })

  it('interpolates linearly between two levels', () => {
    // Halfway between 1000m (13.5) and 2000m (7): 10.25
    expect(interpProfile(temps, heights, 1500)).toBeCloseTo(10.25, 6)
  })

  it('returns the exact value at a level boundary', () => {
    expect(interpProfile(temps, heights, 2000)).toBe(7)
  })
})

describe('pressureAt', () => {
  // A standard-atmosphere-ish profile: pressure drops roughly log-linearly.
  const heights = new Float64Array([0, 1000, 2000])
  const levels = [1013, 900, 795]

  it('matches a level exactly at its own height', () => {
    expect(pressureAt(heights, levels, 1000)).toBeCloseTo(900, 6)
  })

  it('is log-linear, not linear, between levels', () => {
    const mid = pressureAt(heights, levels, 500)
    const linearMid = (1013 + 900) / 2
    // log-linear interpolation of a concave (pressure-vs-height) curve sits
    // below the straight-line average between the same two endpoints.
    expect(mid).toBeLessThan(linearMid)
    expect(mid).toBeGreaterThan(900)
  })

  it('extrapolates below the lowest level rather than clamping', () => {
    // Under the surface, pressure should keep rising above the lowest
    // level's own value -- clamping would report sea-level air as if it
    // sat at 0m even below that.
    const below = pressureAt(heights, levels, -200)
    expect(below).toBeGreaterThan(1013)
  })

  it('clamps above the highest level', () => {
    expect(pressureAt(heights, levels, 5000)).toBe(795)
  })
})

describe('snowFraction (Jennings et al. 2018)', () => {
  it('is essentially all snow well below freezing with high humidity', () => {
    expect(snowFraction(-5, 90, 850)).toBeCloseTo(1, 2)
  })

  it('is essentially all rain well above freezing with low humidity', () => {
    expect(snowFraction(8, 40, 850)).toBeCloseTo(0, 2)
  })

  it('is monotonically decreasing in temperature at fixed humidity/pressure', () => {
    // The logistic model's actual shape claim: colder is never less snowy,
    // at the same humidity and pressure, checked across the transition
    // rather than at one hand-picked crossover point.
    const byTemp = [-4, -2, 0, 2, 4].map(t => snowFraction(t, 85, 900))
    for (let i = 1; i < byTemp.length; i++) {
      expect(byTemp[i]!).toBeLessThanOrEqual(byTemp[i - 1]!)
    }
  })

  it('falls back to the bivariate form without pressure', () => {
    const withPressure = snowFraction(-5, 90, 900)
    const withoutPressure = snowFraction(-5, 90, NaN)
    // Different formulas, not necessarily equal, but both should still be
    // valid probabilities and both should call a cold, humid point snowy.
    expect(withPressure).toBeGreaterThan(0.5)
    expect(withoutPressure).toBeGreaterThan(0.5)
  })

  it('falls back to a linear temperature ramp with no humidity at all', () => {
    expect(snowFraction(0.5, NaN, NaN)).toBe(1)
    expect(snowFraction(2.5, NaN, NaN)).toBe(0)
    expect(snowFraction(1.5, NaN, NaN)).toBeCloseTo(0.5, 6)
  })
})

describe('windTerrainFactor', () => {
  const flat: TerrainSlope = { ex: 0, ey: 0, zxx: 0, zxy: 0, zyy: 0 }

  it('is neutral (1x) on flat ground with no curvature', () => {
    expect(windTerrainFactor(flat, 5, 0)).toBeCloseTo(1, 6)
  })

  it('is neutral for calm wind regardless of terrain', () => {
    const steep: TerrainSlope = { ex: 0.4, ey: 0.4, zxx: 0.002, zxy: 0, zyy: -0.002 }
    expect(windTerrainFactor(steep, 0.01, 0)).toBe(1)
  })

  it('accelerates a mountain pass instead of cancelling to zero', () => {
    // The scenario the crest/channel split exists for: curvature along the
    // flow and across it are equal and opposite (a real Laplacian would sum
    // to exactly zero here), yet a pass should still show real exposure.
    const pass: TerrainSlope = { ex: 0, ey: 0, zxx: -0.00122, zxy: 0, zyy: 0.00122 }
    const factor = windTerrainFactor(pass, 10, 0)
    expect(factor).toBeGreaterThan(1.05)
  })

  it('stays within its documented clamp range', () => {
    const extreme: TerrainSlope = { ex: 1, ey: 1, zxx: 10, zxy: 10, zyy: -10 }
    const factor = windTerrainFactor(extreme, 20, 20)
    expect(factor).toBeGreaterThanOrEqual(0.3)
    expect(factor).toBeLessThanOrEqual(1.8)
  })
})
