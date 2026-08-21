/**
 * What the cube can answer for. Kept intentionally narrow -- this is
 * exactly the set `render.ts`'s `LAYERS` table knows how to compute, not a
 * general "any weather variable" type. A consuming app's own overlay
 * picker (which may have other, cube-unrelated layers -- a terrain slope
 * shader, say) should use its own, wider union and narrow to this one at
 * the boundary, the way lammer.io's own `isWeatherOverlay` guard does.
 */
export type OverlayType =
  | 'temperature'
  | 'precipitation_type'
  | 'rain_accumulated'
  | 'snow_accumulated'
  | 'snow_depth'
  | 'wind_speed'
  | 'wind_gust'
  | 'cloud_cover'
  | 'freezing_level'
  | 'visibility'
