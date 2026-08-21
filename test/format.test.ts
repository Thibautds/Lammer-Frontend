import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCubeCache, openCube, plane, sample, upsample } from '../src/format'

/**
 * Builds a real, minimal CUB2 object byte-for-byte: the same 30-byte
 * header + JSON index + gzip-per-plane layout `format.ts`'s own
 * `parseHeader`/`plane` read -- not a mock of the format, an instance of
 * it, so this proves the wire format round-trips rather than just that
 * the mocks agree with themselves.
 */
async function buildCub2({
  rows, cols, planes,
}: {
  rows: number
  cols: number
  planes: { name: string; dtype: 'u2'; scale: number; offset: number; values: number[] }[]
}): Promise<{ bytes: Uint8Array; headerAndIndexLen: number }> {
  const specs: [string, number, number][] = []
  const specIndex = new Map<string, number>()
  const p: [string, number, number, number][] = []
  const planeBytes: Uint8Array[] = []
  let cursor = 0

  for (const plane of planes) {
    const specKey = `${plane.dtype}:${plane.scale}:${plane.offset}`
    let specId = specIndex.get(specKey)
    if (specId === undefined) {
      specId = specs.length
      specs.push([plane.dtype, plane.scale, plane.offset])
      specIndex.set(specKey, specId)
    }

    const raw = new Uint16Array(plane.values)
    const stream = new Blob([raw.buffer as ArrayBuffer]).stream().pipeThrough(new CompressionStream('gzip'))
    const gzipped = new Uint8Array(await new Response(stream).arrayBuffer())
    planeBytes.push(gzipped)
    p.push([plane.name, specId, cursor, gzipped.length])
    cursor += gzipped.length
  }

  const indexJson = new TextEncoder().encode(JSON.stringify({ p, s: specs }))
  const HEADER_SIZE = 30
  const header = new Uint8Array(HEADER_SIZE)
  const view = new DataView(header.buffer)
  header.set([0x43, 0x55, 0x42, 0x32], 0) // "CUB2"
  view.setFloat32(4, -10, true)  // west
  view.setFloat32(8, 40, true)   // south
  view.setFloat32(12, -5, true)  // east
  view.setFloat32(16, 45, true)  // north
  view.setUint16(20, rows, true)
  view.setUint16(22, cols, true)
  view.setUint16(24, planes.length, true)
  view.setUint32(26, indexJson.length, true)

  const headerAndIndexLen = HEADER_SIZE + indexJson.length
  const total = headerAndIndexLen + planeBytes.reduce((n, b) => n + b.length, 0)
  const bytes = new Uint8Array(total)
  bytes.set(header, 0)
  bytes.set(indexJson, HEADER_SIZE)
  let offset = headerAndIndexLen
  for (const b of planeBytes) {
    bytes.set(b, offset)
    offset += b.length
  }

  return { bytes, headerAndIndexLen }
}

describe('CUB2 round-trip', () => {
  let cubeBytes: Uint8Array
  let headerAndIndexLen: number

  beforeEach(async () => {
    const built = await buildCub2({
      rows: 2,
      cols: 2,
      planes: [
        // 300,310,320,330 raw -> *0.1 - 40 -> -10,-9,-8,-7
        { name: 't2m', dtype: 'u2', scale: 0.1, offset: -40, values: [300, 310, 320, 330] },
      ],
    })
    cubeBytes = built.bytes
    headerAndIndexLen = built.headerAndIndexLen

    // A real Range-serving fetch, not a stub that already knows the
    // answer: it slices whatever byte range was actually asked for out of
    // the real buffer above, the same way R2 would.
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const rangeHeader = (init?.headers as Record<string, string> | undefined)?.Range
      const match = rangeHeader?.match(/bytes=(\d+)-(\d+)/)
      const start = match ? Number(match[1]) : 0
      const end = match ? Math.min(Number(match[2]), cubeBytes.length - 1) : cubeBytes.length - 1
      const slice = cubeBytes.slice(start, end + 1)
      return new Response(slice, { status: 206 })
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    clearCubeCache()
  })

  it('probes the header and index without needing the plane bytes', async () => {
    // A probe smaller than the whole object -- the plane genuinely needs
    // its own Range request below, not one already satisfied by the probe.
    const cube = await openCube('https://example.test/block.cub2', 1, headerAndIndexLen)
    expect(cube).not.toBeNull()
    expect(cube!.rows).toBe(2)
    expect(cube!.cols).toBe(2)
    expect(cube!.bbox).toEqual([-10, 40, -5, 45])
  })

  it('reads a plane via its own Range request and decodes scale/offset correctly', async () => {
    const cube = await openCube('https://example.test/block.cub2', 1, headerAndIndexLen)
    const values = await plane(cube, 't2m')
    expect(values).not.toBeNull()
    // No upsampling (up=1): the decoded grid should be exactly the source
    // values, row-major, scale/offset applied.
    expect(Array.from(values!)).toEqual([-10, -9, -8, -7])
  })

  it('samples the decoded plane bilinearly at an exact grid point', async () => {
    const cube = await openCube('https://example.test/block.cub2', 1, headerAndIndexLen)
    const values = await plane(cube, 't2m')
    // Grid corners: (west,north)=(-10,45)->-10, (east,north)=(-5,45)->-9,
    // (west,south)=(-10,40)->-8, (east,south)=(-5,40)->-7.
    expect(sample(cube!, values, -10, 45)).toBeCloseTo(-10, 6)
    expect(sample(cube!, values, -5, 40)).toBeCloseTo(-7, 6)
  })

  it('returns null for a plane the index has no entry for', async () => {
    const cube = await openCube('https://example.test/block.cub2', 1, headerAndIndexLen)
    expect(await plane(cube, 'does_not_exist')).toBeNull()
  })
})

describe('upsample', () => {
  it('preserves the source values at grid points after upsampling', () => {
    const src = new Float32Array([0, 10, 5, 15]) // 2x2
    const up = upsample(src, 2, 2, 4)
    const fc = (2 - 1) * 4 + 1 // 5
    // Corners of the fine grid should still be exactly the source corners.
    expect(up[0]).toBeCloseTo(0, 4)
    expect(up[fc - 1]).toBeCloseTo(10, 4)
  })
})
