/**
 * Reading CUB2: one probe per object, then one Range request per plane.
 *
 * The format exists to be read this way. Planes are gzipped individually and
 * the index carries their byte offsets, so showing cloud cover costs one plane
 * out of the ~800 in a twelve-step bundle. A client that fetches the object
 * whole pays 800x for it -- which is exactly what the demo viewer did until it
 * was measured.
 */

const HEADER_SIZE = 30

type Dtype = 'u1' | 'u2' | 'i2'

const TYPED: Record<Dtype, { ctor: Uint8ArrayConstructor | Uint16ArrayConstructor | Int16ArrayConstructor; sentinel: number }> = {
  u1: { ctor: Uint8Array, sentinel: 255 },
  u2: { ctor: Uint16Array, sentinel: 65535 },
  i2: { ctor: Int16Array, sentinel: 32767 },
}

type PlaneEntry = { dtype: Dtype; scale: number; offset: number; off: number; len: number }

export type Cube = {
  url: string
  bbox: [number, number, number, number]
  rows: number
  cols: number
  fineRows: number
  fineCols: number
  up: number
  dataStart: number
  index: Map<string, PlaneEntry>
  have: Uint8Array
  planes: Map<string, Promise<Float32Array | null>>
}

/**
 * MapLibre asks for every visible tile at once and each tile wants its blocks
 * -- a profile-carrying layer alone is a couple dozen Range requests per
 * block (needs + profileNeeds x levels + gh x levels), times however many
 * blocks a tile touches. Without a rein a pan opens as many connections as
 * the browser allows and every one of them is slower for it.
 *
 * Six was HTTP/1.1's per-origin connection limit -- irrelevant here: this
 * origin is Cloudflare R2, served over HTTP/2, which multiplexes many
 * concurrent requests over one connection rather than opening one each. The
 * real ceiling is the server's own SETTINGS_MAX_CONCURRENT_STREAMS, which
 * Cloudflare sets north of 100; 24 leaves headroom without turning every
 * first load's burst of block/plane requests into a six-wide queue on a
 * connection that could carry far more of them at once.
 */
const NET = { limit: 24, active: 0, waiting: [] as (() => void)[] }

function throttled<T>(run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const go = () => {
      NET.active += 1
      run().then(resolve, reject).finally(() => {
        NET.active -= 1
        const next = NET.waiting.shift()
        if (next) next()
      })
    }
    if (NET.active < NET.limit) go()
    else NET.waiting.push(go)
  })
}

type RangeResult = { bytes: Uint8Array; whole: boolean } | null

/**
 * A server that ignores Range answers 200 with everything. That is handled
 * rather than guarded against: the response simply becomes the local copy and
 * every later plane is free.
 */
async function fetchRange(url: string, start: number, end: number): Promise<RangeResult> {
  const response = await throttled(() => fetch(url, { headers: { Range: `bytes=${start}-${end}` } }))
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`${url} -> ${response.status}`)
  return { bytes: new Uint8Array(await response.arrayBuffer()), whole: response.status === 200 }
}

function parseHeader(buf: Uint8Array) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const magic = String.fromCharCode(...buf.subarray(0, 4))
  if (magic !== 'CUB2') throw new Error(`not a CUB2 object: ${magic}`)

  const bbox: [number, number, number, number] = [
    view.getFloat32(4, true), view.getFloat32(8, true),
    view.getFloat32(12, true), view.getFloat32(16, true),
  ]
  const rows = view.getUint16(20, true)
  const cols = view.getUint16(22, true)
  const nPlanes = view.getUint16(24, true)
  const indexLen = view.getUint32(26, true)
  if (buf.length < HEADER_SIZE + indexLen) {
    throw new Error(`probe of ${buf.length} B is short of a ${indexLen} B index`)
  }

  const raw = JSON.parse(new TextDecoder().decode(buf.subarray(HEADER_SIZE, HEADER_SIZE + indexLen)))
  if (raw.p.length !== nPlanes) throw new Error('index and header disagree on plane count')

  const index = new Map<string, PlaneEntry>()
  for (const [name, specId, off, len] of raw.p as [string, number, number, number][]) {
    const [dtype, scale, offset] = raw.s[specId] as [Dtype, number, number]
    index.set(name, { dtype, scale, offset, off, len })
  }
  return { bbox, rows, cols, dataStart: HEADER_SIZE + indexLen, index }
}

const cubeCache = new Map<string, Promise<Cube | null>>()

export function clearCubeCache() {
  cubeCache.clear()
}

/**
 * One probe gets the header and the whole index; after that a plane is one
 * Range request, or none at all when the probe already covered it -- which it
 * does for every static.cub, those being about 2 kB entire.
 */
export function openCube(url: string, up: number, probeBytes: number): Promise<Cube | null> {
  let pending = cubeCache.get(url)
  if (!pending) {
    pending = (async () => {
      const got = await fetchRange(url, 0, probeBytes - 1)
      if (!got) return null
      const head = parseHeader(got.bytes)
      return {
        url,
        ...head,
        up,
        fineRows: (head.rows - 1) * up + 1,
        fineCols: (head.cols - 1) * up + 1,
        have: got.bytes,
        planes: new Map(),
      }
    })().catch(err => {
      cubeCache.delete(url)
      throw err
    })
    cubeCache.set(url, pending)
  }
  return pending
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Pull the whole object down in one request.
 *
 * The map and a point forecast want opposite things. The map wants one plane
 * across many blocks, so a Range per plane is exactly right. A point wants
 * every plane of one block: 37 per step, 65 steps, which as Range requests is
 * 2405 round trips for a single click. The same bytes arrive in six whole
 * objects.
 *
 * Nothing else changes -- `plane()` already reads locally whenever the bytes
 * are in `have`, so after this every plane in the object is free.
 */
export async function prefetchAll(cube: Cube | null): Promise<void> {
  if (!cube) return
  let end = cube.dataStart
  for (const entry of cube.index.values()) {
    end = Math.max(end, cube.dataStart + entry.off + entry.len)
  }
  if (cube.have.length >= end) return
  const got = await fetchRange(cube.url, 0, end - 1)
  if (got && got.bytes.length > cube.have.length) cube.have = got.bytes
}

export function plane(cube: Cube | null, name: string): Promise<Float32Array | null> {
  if (!cube) return Promise.resolve(null)
  const cached = cube.planes.get(name)
  if (cached) return cached

  const entry = cube.index.get(name)
  if (!entry) return Promise.resolve(null)

  const start = cube.dataStart + entry.off
  const end = start + entry.len - 1

  const load = (async () => {
    let blob: Uint8Array
    if (end < cube.have.length) {
      blob = cube.have.subarray(start, end + 1)
    } else {
      const got = await fetchRange(cube.url, start, end)
      if (!got) return null
      if (got.whole) {
        cube.have = got.bytes
        blob = got.bytes.subarray(start, end + 1)
      } else {
        blob = got.bytes
      }
    }

    const raw = await inflate(blob)
    const { ctor, sentinel } = TYPED[entry.dtype]
    const ints = new ctor(raw.buffer, raw.byteOffset, raw.byteLength / ctor.BYTES_PER_ELEMENT)
    const coarse = new Float32Array(ints.length)
    for (let i = 0; i < ints.length; i++) {
      coarse[i] = ints[i] === sentinel ? NaN : ints[i] * entry.scale + entry.offset
    }
    return upsample(coarse, cube.rows, cube.cols, cube.up)
  })()

  cube.planes.set(name, load)
  return load
}

// ── Getting rid of the grid ──────────────────────────────────────────
//
// Bilinear interpolation is continuous in value but not in slope: inside a
// cell its second derivative is exactly zero, at every cell boundary it is a
// spike. That is a crease on every grid line, and under a log colour ramp a
// crease is a visible line -- measured at 5.7 mm per source cell on a
// convective band. It belongs to the interpolator, not to the data: Windy
// draws GFS at 22 km, coarser than this, with no grid at all.
//
// Doing bicubic per pixel would be 16 taps instead of 4, in a loop that
// already runs 65,536 times a tile. So the cubic runs *once*, at decode: each
// plane is B-spline upsampled and the hot loop keeps its cheap bilinear. The
// crease drops to 1.25 and the peak is preserved, which for precipitation is
// the number people read off the map.

function bspline(p0: number, p1: number, p2: number, p3: number, t: number): number {
  if (!(isFinite(p0) && isFinite(p1) && isFinite(p2) && isFinite(p3))) return p1
  const u = 1 - t
  const t2 = t * t
  const t3 = t2 * t
  return (u * u * u * p0 + (3 * t3 - 6 * t2 + 4) * p1 +
          (-3 * t3 + 3 * t2 + 3 * t + 1) * p2 + t3 * p3) / 6
}

/**
 * Off the end of the array the taps extend linearly, p(-1) = 2p(0) - p(1),
 * rather than repeating the edge value: repeating bends the spline towards the
 * edge and leaves a visible lip.
 *
 * This is only ever the pole case. It is not how block joins are handled -- a
 * substituted tap carries no curvature, so leaning on it there puts the crease
 * straight back. Blocks ship a real cell on each side instead, one before and
 * two after. At 90N there is no neighbouring block to ask.
 */
export function upsample(src: Float32Array, rows: number, cols: number, up: number): Float32Array {
  const fc = (cols - 1) * up + 1
  const fr = (rows - 1) * up + 1

  const wide = new Float32Array(rows * fc)
  for (let r = 0; r < rows; r++) {
    const o = r * cols
    for (let i = 0; i < fc; i++) {
      const x = i / up
      const x0 = Math.min(cols - 2, Math.floor(x))
      const t = x - x0
      const p1 = src[o + x0]
      const p2 = src[o + x0 + 1]
      const p0 = x0 > 0 ? src[o + x0 - 1] : 2 * p1 - p2
      const p3 = x0 + 2 < cols ? src[o + x0 + 2] : 2 * p2 - p1
      wide[r * fc + i] = bspline(p0, p1, p2, p3, t)
    }
  }

  const out = new Float32Array(fr * fc)
  for (let j = 0; j < fr; j++) {
    const y = j / up
    const y0 = Math.min(rows - 2, Math.floor(y))
    const t = y - y0
    const o1 = y0 * fc
    const o2 = o1 + fc
    const o0 = y0 > 0 ? o1 - fc : -1
    const o3 = y0 + 2 < rows ? o2 + fc : -1
    for (let i = 0; i < fc; i++) {
      const p1 = wide[o1 + i]
      const p2 = wide[o2 + i]
      out[j * fc + i] = bspline(
        o0 >= 0 ? wide[o0 + i] : 2 * p1 - p2, p1, p2,
        o3 >= 0 ? wide[o3 + i] : 2 * p2 - p1, t)
    }
  }
  return out
}

/**
 * Bilinear sample of one refined plane. Grid rows run north to south and the
 * bbox holds cell centres, so the fractional index is a straight linear map
 * with no half-cell fudge.
 */
export function sample(cube: Cube, values: Float32Array | null, lon: number, lat: number): number {
  if (!values) return NaN
  const [w, s, e, n] = cube.bbox
  const rows = cube.fineRows
  const cols = cube.fineCols
  const fx = cols > 1 ? ((lon - w) / (e - w)) * (cols - 1) : 0
  const fy = rows > 1 ? ((n - lat) / (n - s)) * (rows - 1) : 0
  const x0 = Math.max(0, Math.min(cols - 1, Math.floor(fx)))
  const y0 = Math.max(0, Math.min(rows - 1, Math.floor(fy)))
  const x1 = Math.min(cols - 1, x0 + 1)
  const y1 = Math.min(rows - 1, y0 + 1)
  const tx = fx - x0
  const ty = fy - y0
  const v00 = values[y0 * cols + x0]
  const v10 = values[y0 * cols + x1]
  const v01 = values[y1 * cols + x0]
  const v11 = values[y1 * cols + x1]
  const top = v00 + (v10 - v00) * tx
  const bot = v01 + (v11 - v01) * tx
  return top + (bot - top) * ty
}
