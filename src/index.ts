/**
 * @lammer/cube -- the map-library-agnostic core.
 *
 * Open a cube, read a plane, downscale it against real elevation, at a
 * single point or across a whole raster tile. Nothing in this entry point
 * touches MapLibre, Leaflet, or the DOM beyond what `OffscreenCanvas`/
 * `createImageBitmap` need -- see `@lammer/cube/maplibre` for the adapter
 * that wires this into a specific map library.
 */

export type { OverlayType } from './types'

export type { Cube } from './format'
export { clearCubeCache, openCube, plane, prefetchAll, sample, upsample } from './format'

export type { CubeColumn, CubeValues, PlaneSet, TerrainSlope } from './physics'
export {
  cloudDepth, evaluate, interpProfile, newColumn, newValues, pressureAt,
  sampleColumn, snowFraction, TERRAIN_SCALE_M, visibilityKm, windTerrainFactor,
} from './physics'

export type { CubeLevel, CubeManifest } from './pyramid'
export {
  blockOf, blockUrl, bundleFor, hasProfile, inLevelDomain, isCovered,
  levelBounds, levelForZoom, parseManifest, staticUrl, windowStart,
} from './pyramid'

export type { LayerSpec } from './render'
export {
  clearPlaneSets, cubeSupports, DEM_MAX_ZOOM, demSampler, demTile, LAYERS,
  renderCubeTile, resolveStep, setTerrainTileUrl, TILE, tile2lat, tile2lon,
  transparent,
} from './render'

export type { CubePointSeries } from './point'
export { cubeElevationAt, cubePointSeries } from './point'

export type { OverlayGrid } from './ramps'
export {
  applyContinuousColor, applySteppedColor, interpolateChannel,
  renderPrecipitationTypeOverlay, renderSinglePlaneOverlay, setTransparent,
} from './ramps'
