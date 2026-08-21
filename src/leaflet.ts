/**
 * Wiring the cube into Leaflet.
 *
 * MapLibre's `addProtocol` is a clean per-tile async hook -- request in,
 * `ImageBitmap` out. Leaflet's own extension point for the same job is
 * `L.GridLayer#createTile`: return a tile element synchronously, then call
 * `done(error, tile)` once it's actually drawn. A `<canvas>` fits that
 * shape exactly -- allocate it up front, hand it back immediately, paint
 * into it whenever `renderCubeTile` resolves.
 *
 * Redrawing on an overlay or step change needs none of `@lammer/cube/
 * maplibre`'s cache-buster-in-the-URL trick: `L.GridLayer` doesn't key
 * tiles by a URL template here (there's no `getTileUrl`, only
 * `createTile`), so `redraw()` -- Leaflet's own call for "the thing this
 * layer draws changed" -- goes straight back through `createTile` for
 * every tile currently on screen. Existing tiles stay up until their
 * replacement lands, the same non-blanking behaviour
 * `@lammer/cube/maplibre`'s `addCubeLayer` was written to guarantee, here
 * for free from Leaflet's own redraw semantics rather than something this
 * adapter has to reimplement.
 */

import * as L from 'leaflet'
import { renderCubeTile } from './render'
import type { CubeManifest } from './pyramid'
import type { OverlayType } from './types'

export type CubeLayerOptions = L.GridLayerOptions & {
  manifest: CubeManifest | null
  overlay: OverlayType | null
  /** Forecast step, in hours from the run's own init time. */
  stepH: number
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

/**
 * A raster layer backed by the cube, rendered on demand -- the Leaflet
 * counterpart to `@lammer/cube/maplibre`'s `addCubeLayer`/
 * `registerCubeProtocol` pair. Where those are two functions because
 * MapLibre's protocol handler is registered once for the whole map and the
 * layer is a separate, addressable thing, Leaflet's `GridLayer` already
 * *is* both: one object, added and removed like any other Leaflet layer.
 */
export class CubeLayer extends L.GridLayer {
  private cubeManifest: CubeManifest | null
  private cubeOverlay: OverlayType | null
  private cubeStepH: number

  // Leaflet's own base `Layer#options` is typed as plain `LayerOptions`;
  // redeclaring it here (a `declare` field adds no runtime assignment of
  // its own -- the constructor's `super(...)` call below is what actually
  // sets `this.options`) gives a caller `layer.options.opacity` back with
  // its real, specific type instead of a cast at every call site.
  declare options: CubeLayerOptions

  constructor(options: CubeLayerOptions) {
    const opacity = options.opacity ?? (options.overlay ? DEFAULT_OPACITY[options.overlay] : undefined) ?? 0.65
    super({ tileSize: 256, ...options, opacity })
    this.cubeManifest = options.manifest
    this.cubeOverlay = options.overlay
    this.cubeStepH = options.stepH
  }

  /** Swap the run this layer reads from -- e.g. a new run just published. */
  setManifest(manifest: CubeManifest | null): this {
    this.cubeManifest = manifest
    return this.redraw()
  }

  /** Change which field this layer paints. Opacity follows the new
   *  overlay's own default unless one was set explicitly via `setOpacity`. */
  setOverlay(overlay: OverlayType | null): this {
    this.cubeOverlay = overlay
    return this.redraw()
  }

  /** Move to a different forecast step (hours from run init). */
  setStepH(stepH: number): this {
    this.cubeStepH = stepH
    return this.redraw()
  }

  createTile(coord: L.Coords, done: L.DoneCallback): HTMLElement {
    const tile = document.createElement('canvas')
    tile.width = 256
    tile.height = 256

    const { cubeManifest: manifest, cubeOverlay: overlay, cubeStepH: stepH } = this
    if (!manifest || !overlay) {
      // Nothing to draw yet (e.g. the manifest is still loading) -- an
      // empty, fully transparent tile, not an error: `createTile` gets
      // called again on the next `redraw()` once there is something.
      done(undefined, tile)
      return tile
    }

    renderCubeTile(manifest, coord.z, coord.x, coord.y, overlay, stepH)
      .then(bitmap => {
        const ctx = tile.getContext('2d')
        if (ctx) ctx.drawImage(bitmap, 0, 0)
        done(undefined, tile)
      })
      .catch((err: unknown) => {
        console.error('[cube] tile failed:', err)
        done(err instanceof Error ? err : new Error(String(err)), tile)
      })

    return tile
  }
}

export function cubeLayer(options: CubeLayerOptions): CubeLayer {
  return new CubeLayer(options)
}
