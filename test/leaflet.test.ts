// @vitest-environment jsdom
//
// Expect jsdom's own "Not implemented: HTMLCanvasElement.prototype.
// getContext" notice on stderr for the tests that reach `createTile`'s
// drawImage call -- jsdom has no native 2D canvas backend, so `getContext`
// there logs and returns null rather than a real context. That's exactly
// the case `if (ctx) ctx.drawImage(...)` in leaflet.ts guards against;
// these tests passing (done() still called correctly either way) is the
// point, not the stderr noise.
import * as L from 'leaflet'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CubeManifest } from '../src/pyramid'

/** A real `L.Point` (so `Coords`' inherited methods -- clone/add/... --
 *  are genuinely there, not just typed as if they were) plus the `z`
 *  `Coords` adds on top. */
function coords(x: number, y: number, z: number): L.Coords {
  return Object.assign(L.point(x, y), { z }) as L.Coords
}

// Isolates the Leaflet wiring (createTile -> renderCubeTile -> done) from
// the render pipeline itself, which format/physics/pyramid tests already
// cover against real bytes -- this test is about whether CubeLayer calls
// through and routes the result correctly, not about re-proving the
// downscaling math.
vi.mock('../src/render', () => ({
  renderCubeTile: vi.fn(),
}))

const { renderCubeTile } = await import('../src/render')
const { CubeLayer, cubeLayer } = await import('../src/leaflet')

const fakeManifest = {} as CubeManifest

function fakeBitmap(): ImageBitmap {
  // jsdom has no real ImageBitmap/2D-canvas pixel pipeline; a plain object
  // is enough since the mocked renderCubeTile just needs *something* to
  // resolve with and the test only asserts on the done() callback, not on
  // actual pixels landing on the canvas.
  return {} as ImageBitmap
}

describe('CubeLayer.createTile', () => {
  beforeEach(() => {
    vi.mocked(renderCubeTile).mockReset()
  })

  it('hands back a canvas element synchronously', () => {
    const layer = cubeLayer({ manifest: null, overlay: null, stepH: 0 })
    const tile = layer.createTile(coords(1, 2, 3), () => {})
    expect(tile).toBeInstanceOf(HTMLCanvasElement)
    expect((tile as HTMLCanvasElement).width).toBe(256)
    expect((tile as HTMLCanvasElement).height).toBe(256)
  })

  it('calls done() with no error and an empty tile when there is no manifest yet', () => {
    const layer = cubeLayer({ manifest: null, overlay: 'temperature', stepH: 0 })
    const done = vi.fn()
    layer.createTile(coords(0, 0, 5), done)
    expect(done).toHaveBeenCalledWith(undefined, expect.any(HTMLCanvasElement))
    expect(renderCubeTile).not.toHaveBeenCalled()
  })

  it('renders through renderCubeTile with the layer\'s current overlay/step', async () => {
    vi.mocked(renderCubeTile).mockResolvedValue(fakeBitmap())
    const layer = cubeLayer({ manifest: fakeManifest, overlay: 'wind_speed', stepH: 12 })
    const done = vi.fn()
    layer.createTile(coords(4, 5, 6), done)

    await vi.waitFor(() => expect(done).toHaveBeenCalled())
    expect(renderCubeTile).toHaveBeenCalledWith(fakeManifest, 6, 4, 5, 'wind_speed', 12)
    expect(done).toHaveBeenCalledWith(undefined, expect.any(HTMLCanvasElement))
  })

  it('routes a render failure to done() as an error instead of throwing', async () => {
    vi.mocked(renderCubeTile).mockRejectedValue(new Error('boom'))
    const layer = cubeLayer({ manifest: fakeManifest, overlay: 'temperature', stepH: 0 })
    const done = vi.fn()
    layer.createTile(coords(0, 0, 0), done)

    await vi.waitFor(() => expect(done).toHaveBeenCalled())
    const [err] = done.mock.calls[0]!
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('boom')
  })

  it('setOverlay/setStepH/setManifest update what the next tile renders', async () => {
    vi.mocked(renderCubeTile).mockResolvedValue(fakeBitmap())
    const layer = cubeLayer({ manifest: null, overlay: null, stepH: 0 })
    layer.setManifest(fakeManifest).setOverlay('snow_depth').setStepH(48)

    const done = vi.fn()
    layer.createTile(coords(1, 1, 1), done)
    await vi.waitFor(() => expect(done).toHaveBeenCalled())
    expect(renderCubeTile).toHaveBeenCalledWith(fakeManifest, 1, 1, 1, 'snow_depth', 48)
  })

  it('defaults opacity per overlay, the same table the MapLibre adapter uses', () => {
    const cloud = cubeLayer({ manifest: null, overlay: 'cloud_cover', stepH: 0 })
    expect(cloud.options.opacity).toBe(0.72)
    const temp = cubeLayer({ manifest: null, overlay: 'temperature', stepH: 0 })
    expect(temp.options.opacity).toBe(0.65)
  })

  it('an explicit opacity option overrides the per-overlay default', () => {
    const layer = cubeLayer({ manifest: null, overlay: 'temperature', stepH: 0, opacity: 0.3 })
    expect(layer.options.opacity).toBe(0.3)
  })

  it('is a real L.GridLayer', () => {
    const layer = new CubeLayer({ manifest: null, overlay: null, stepH: 0 })
    expect(layer).toBeInstanceOf(L.GridLayer)
  })
})
