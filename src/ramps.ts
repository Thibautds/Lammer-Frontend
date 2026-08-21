import type { OverlayType } from './types'

/**
 * The colour of the weather, in one place.
 *
 * Transcribed verbatim from Lammer's own `frontend/src/lib/weatherRamps.ts`
 * -- not one threshold or channel touched, because there's no reason for a
 * value this library renders to look different from the same value on
 * lammer.io's own map. One case is deliberately missing: the original file
 * also handles `slope_angle`, a DEM-only terrain overlay with nothing to
 * do with the weather cube. `OverlayType` here doesn't include it, so
 * there's nothing for that branch to ever receive.
 */

type RGB = readonly [number, number, number]

/** A flat, decoded grid ready to paint -- what `render.ts` builds after
 *  sampling and downscaling, in exactly the shape these functions expect. */
export type OverlayGrid = {
  west: number
  south: number
  east: number
  north: number
  rows: number
  cols: number
  planeCount: number
  data: Float32Array
}

const TEMP_INTERP_X = [-25, -20, -15, -10, -5, 0, 5, 10, 15, 20, 25, 30, 35]
const TEMP_INTERP_R = [90, 123, 40, 30, 0, 0, 45, 160, 255, 255, 255, 205, 139]
const TEMP_INTERP_G = [0, 47, 80, 144, 205, 180, 200, 216, 215, 140, 69, 0, 0]
const TEMP_INTERP_B = [160, 190, 200, 255, 205, 80, 45, 45, 0, 0, 0, 0, 0]

const RAIN_HOURLY_THRESHOLDS = [0.1, 0.5, 1, 3, 5, 10, 15, 25, 50]
const RAIN_HOURLY_COLORS: readonly RGB[] = [
  [0, 0, 0],
  [170, 220, 255],
  [120, 185, 255],
  [75, 145, 255],
  [30, 100, 235],
  [15, 60, 210],
  [10, 35, 180],
  [60, 20, 170],
  [100, 0, 150],
  [80, 0, 100],
]

const RAIN_ACCUMULATED_THRESHOLDS = [0.1, 5, 10, 15, 20, 25, 50, 75, 100, 150, 200]
const RAIN_ACCUMULATED_COLORS: readonly RGB[] = [
  [0, 0, 0],
  [178, 220, 255],
  [125, 188, 255],
  [80, 150, 255],
  [48, 116, 243],
  [24, 88, 228],
  [12, 63, 211],
  [8, 47, 194],
  [5, 36, 180],
  [3, 28, 168],
  [2, 22, 158],
  [0, 18, 148],
]

const SNOW_HOURLY_THRESHOLDS = [0.1, 1, 5, 10, 15, 20, 25, 50, 75]
const SNOW_HOURLY_COLORS: readonly RGB[] = [
  [0, 0, 0],
  [180, 240, 120],
  [100, 200, 50],
  [200, 220, 30],
  [255, 215, 0],
  [255, 150, 0],
  [230, 60, 30],
  [200, 30, 80],
  [180, 0, 150],
  [120, 0, 100],
]

const SNOW_ACCUMULATED_THRESHOLDS = [0.1, 5, 10, 15, 20, 25, 50, 75, 100, 150, 200]
const SNOW_ACCUMULATED_COLORS: readonly RGB[] = [
  [0, 0, 0],
  [152, 198, 26],
  [214, 229, 28],
  [255, 236, 0],
  [255, 183, 0],
  [255, 118, 0],
  [255, 28, 0],
  [182, 0, 0],
  [236, 146, 255],
  [192, 0, 212],
  [146, 0, 180],
  [110, 0, 145],
]

const WIND_SPEED_INTERP_X = [0, 2, 5, 10, 15, 25, 40]
const WIND_SPEED_INTERP_R = [200, 130, 50, 255, 255, 255, 140]
const WIND_SPEED_INTERP_G = [220, 190, 180, 220, 130, 50, 20]
const WIND_SPEED_INTERP_B = [255, 255, 240, 50, 0, 50, 160]

const WIND_GUST_INTERP_X = [0, 5, 10, 15, 20, 30, 45]
const WIND_GUST_INTERP_R = [200, 130, 255, 255, 255, 255, 180]
const WIND_GUST_INTERP_G = [220, 190, 220, 180, 100, 30, 0]
const WIND_GUST_INTERP_B = [255, 255, 50, 0, 0, 30, 80]

const CLOUD_COVER_INTERP_X = [0, 20, 40, 60, 80, 100]
const CLOUD_COVER_INTERP_RGB = [255, 245, 228, 210, 192, 176]

// Freezing level as terrain-relative: value = terrain height minus the freeze line (m).
// >0 = terrain is frozen (blue, deeper = stronger), <0 = above 0°C (red), ~0 = red snow line.
const FREEZE_BLUE_X = [60, 300, 800, 1800, 3500]
const FREEZE_BLUE_R = [150, 100, 60, 30, 18]
const FREEZE_BLUE_G = [190, 150, 110, 80, 60]
const FREEZE_BLUE_B = [235, 220, 205, 185, 160]
const FREEZE_BLUE_A = [110, 145, 175, 195, 205]
const FREEZE_RED_X = [60, 400, 1200, 3000]
const FREEZE_RED_R = [235, 225, 210, 200]
const FREEZE_RED_G = [140, 90, 55, 40]
const FREEZE_RED_B = [140, 90, 55, 40]
const FREEZE_RED_A = [80, 110, 130, 150]

// Horizontal visibility (km): good = green (fades to transparent when clear),
// worse = orange, fog/white-out = dark red.
const VIS_INTERP_X = [0.1, 0.3, 0.8, 2, 5, 10, 13]
const VIS_INTERP_R = [130, 205, 235, 240, 150, 70, 70]
const VIS_INTERP_G = [0, 30, 120, 200, 200, 180, 180]
const VIS_INTERP_B = [0, 20, 30, 40, 60, 80, 80]
const VIS_INTERP_A = [220, 205, 185, 155, 110, 45, 0]

export function interpolateChannel(value: number, domain: readonly number[], range: readonly number[]): number {
  if (value <= domain[0]) return range[0]

  for (let i = 1; i < domain.length; i++) {
    if (value <= domain[i]) {
      const lowerX = domain[i - 1]
      const upperX = domain[i]
      const t = (value - lowerX) / (upperX - lowerX)
      return range[i - 1] + t * (range[i] - range[i - 1])
    }
  }

  return range[range.length - 1]
}

export function setTransparent(rgba: Uint8ClampedArray, base: number) {
  rgba[base] = 0
  rgba[base + 1] = 0
  rgba[base + 2] = 0
  rgba[base + 3] = 0
}

export function applyContinuousColor(
  rgba: Uint8ClampedArray,
  base: number,
  value: number,
  domain: readonly number[],
  rRange: readonly number[],
  gRange: readonly number[],
  bRange: readonly number[],
  alpha: number,
) {
  if (!Number.isFinite(value)) {
    setTransparent(rgba, base)
    return
  }

  rgba[base] = interpolateChannel(value, domain, rRange)
  rgba[base + 1] = interpolateChannel(value, domain, gRange)
  rgba[base + 2] = interpolateChannel(value, domain, bRange)
  rgba[base + 3] = alpha
}

export function applySteppedColor(
  rgba: Uint8ClampedArray,
  base: number,
  value: number,
  thresholds: readonly number[],
  colors: readonly RGB[],
  alpha: number,
) {
  if (!Number.isFinite(value) || value < thresholds[0]) {
    setTransparent(rgba, base)
    return
  }

  let idx = 0
  while (idx < thresholds.length && value >= thresholds[idx]) idx += 1

  const color = colors[idx]
  rgba[base] = color[0]
  rgba[base + 1] = color[1]
  rgba[base + 2] = color[2]
  rgba[base + 3] = alpha
}

export function renderSinglePlaneOverlay(
  grid: OverlayGrid,
  overlayType: Exclude<OverlayType, 'precipitation_type'>,
): Uint8ClampedArray | null {
  if (grid.planeCount < 1) return null

  const rgba = new Uint8ClampedArray(grid.rows * grid.cols * 4)
  const cells = grid.rows * grid.cols

  for (let i = 0; i < cells; i++) {
    const base = i * 4
    const value = grid.data[i]

    switch (overlayType) {
      case 'temperature':
        applyContinuousColor(rgba, base, value, TEMP_INTERP_X, TEMP_INTERP_R, TEMP_INTERP_G, TEMP_INTERP_B, 230)
        break
      case 'rain_accumulated':
        applySteppedColor(rgba, base, value, RAIN_ACCUMULATED_THRESHOLDS, RAIN_ACCUMULATED_COLORS, 195)
        break
      case 'snow_accumulated':
        applySteppedColor(rgba, base, value, SNOW_ACCUMULATED_THRESHOLDS, SNOW_ACCUMULATED_COLORS, 205)
        break
      case 'snow_depth':
        applySteppedColor(rgba, base, value, SNOW_ACCUMULATED_THRESHOLDS, SNOW_ACCUMULATED_COLORS, 200)
        break
      case 'wind_speed':
        applyContinuousColor(
          rgba,
          base,
          value,
          WIND_SPEED_INTERP_X,
          WIND_SPEED_INTERP_R,
          WIND_SPEED_INTERP_G,
          WIND_SPEED_INTERP_B,
          180,
        )
        break
      case 'wind_gust':
        applyContinuousColor(
          rgba,
          base,
          value,
          WIND_GUST_INTERP_X,
          WIND_GUST_INTERP_R,
          WIND_GUST_INTERP_G,
          WIND_GUST_INTERP_B,
          180,
        )
        break
      case 'cloud_cover': {
        if (!Number.isFinite(value) || value < 5) {
          setTransparent(rgba, base)
          break
        }
        const shade = interpolateChannel(value, CLOUD_COVER_INTERP_X, CLOUD_COVER_INTERP_RGB)
        rgba[base] = shade
        rgba[base + 1] = shade
        rgba[base + 2] = shade
        rgba[base + 3] = Math.round(interpolateChannel(value, CLOUD_COVER_INTERP_X, [0, 70, 110, 145, 175, 210]))
        break
      }
      case 'freezing_level': {
        // value = terrain height minus the freeze line (m).
        if (!Number.isFinite(value)) {
          setTransparent(rgba, base)
          break
        }
        if (value >= -60 && value <= 60) {
          // Red 0°C boundary (snow line).
          rgba[base] = 214
          rgba[base + 1] = 28
          rgba[base + 2] = 28
          rgba[base + 3] = 220
        } else if (value > 60) {
          // Frozen → blue.
          rgba[base] = interpolateChannel(value, FREEZE_BLUE_X, FREEZE_BLUE_R)
          rgba[base + 1] = interpolateChannel(value, FREEZE_BLUE_X, FREEZE_BLUE_G)
          rgba[base + 2] = interpolateChannel(value, FREEZE_BLUE_X, FREEZE_BLUE_B)
          rgba[base + 3] = Math.round(interpolateChannel(value, FREEZE_BLUE_X, FREEZE_BLUE_A))
        } else {
          // Above 0°C / not freezing → red, translucent.
          const av = -value
          rgba[base] = interpolateChannel(av, FREEZE_RED_X, FREEZE_RED_R)
          rgba[base + 1] = interpolateChannel(av, FREEZE_RED_X, FREEZE_RED_G)
          rgba[base + 2] = interpolateChannel(av, FREEZE_RED_X, FREEZE_RED_B)
          rgba[base + 3] = Math.round(interpolateChannel(av, FREEZE_RED_X, FREEZE_RED_A))
        }
        break
      }
      case 'visibility': {
        // value = km. Clear (>=13 km) fades to transparent; worse = orange → dark red.
        if (!Number.isFinite(value) || value >= 13) {
          setTransparent(rgba, base)
          break
        }
        rgba[base] = interpolateChannel(value, VIS_INTERP_X, VIS_INTERP_R)
        rgba[base + 1] = interpolateChannel(value, VIS_INTERP_X, VIS_INTERP_G)
        rgba[base + 2] = interpolateChannel(value, VIS_INTERP_X, VIS_INTERP_B)
        rgba[base + 3] = Math.round(interpolateChannel(value, VIS_INTERP_X, VIS_INTERP_A))
        break
      }
    }
  }

  return rgba
}

export function renderPrecipitationTypeOverlay(grid: OverlayGrid): Uint8ClampedArray | null {
  if (grid.planeCount < 2) return null

  const rgba = new Uint8ClampedArray(grid.rows * grid.cols * 4)
  const cells = grid.rows * grid.cols
  const snowOffset = cells

  for (let i = 0; i < cells; i++) {
    const base = i * 4
    const rain = Number.isFinite(grid.data[i]) ? grid.data[i] : 0
    const snow = Number.isFinite(grid.data[snowOffset + i]) ? grid.data[snowOffset + i] : 0
    const total = rain + snow

    if (total < 0.1) {
      setTransparent(rgba, base)
      continue
    }

    if (snow > rain) {
      applySteppedColor(rgba, base, snow, SNOW_HOURLY_THRESHOLDS, SNOW_HOURLY_COLORS, 210)
    } else {
      applySteppedColor(rgba, base, rain, RAIN_HOURLY_THRESHOLDS, RAIN_HOURLY_COLORS, 200)
    }
  }

  return rgba
}
