/**
 * WFD1 (Water Field Data, version 1) decoder — the unified sea + river
 * surface field. Format documented in
 * `shared/src/worldgen/tile_bake/water_field.rs`.
 */

const MAGIC = 0x31444657 // "WFD1" little-endian
const HEADER_BYTES = 16
const BYTES_PER_PIXEL = 6
const SUPPORTED_VERSION = 1

/** Heightmap encoding constants — must match
 *  `shared/src/worldgen/tile_bake/constants.rs` (HEIGHT_BIAS / HEIGHT_STEP). */
const HEIGHT_BIAS_M = 500
const HEIGHT_STEP_M = 0.05

/** Vertex-grid side length of one tile (matches heightmap resolution). */
export const WATER_FIELD_GRID = 65

export interface WaterFieldTileData {
  /** Row-major 65×65 water surface elevation in meters: river surface in
   *  channels, sea level in open sea, smoothmax blend at estuaries. On
   *  land the value sits below the terrain so `depth = surfaceY − bedY`
   *  reads ≤ 0 there. */
  surfaceY: Float32Array
  /** Row-major 65×65 downstream flow vector X component. Magnitude is the
   *  baked flow speed (estuary-decayed), not a unit vector. */
  flowX: Float32Array
  /** Row-major 65×65 downstream flow vector Z component. */
  flowZ: Float32Array
  /** Row-major 65×65 river↔sea blend: 1 in an inland channel, 0 in open
   *  sea and past the channel envelope. */
  riverness: Float32Array
}

/** Decode a `WFD1` per-tile file. Throws on corrupt data so the caller
 *  doesn't render garbage from a bad payload. */
export function decodeWaterFieldData(buffer: ArrayBuffer): WaterFieldTileData {
  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error(`water field too small: ${buffer.byteLength} bytes`)
  }
  const view = new DataView(buffer)
  const magic = view.getUint32(0, true)
  if (magic !== MAGIC) {
    throw new Error(
      `water field magic mismatch: got 0x${magic.toString(16)}, expected 0x${MAGIC.toString(16)}`
    )
  }
  const version = view.getUint16(4, true)
  if (version !== SUPPORTED_VERSION) {
    throw new Error(
      `water field version ${version} unsupported (expected ${SUPPORTED_VERSION})`
    )
  }
  const gridX = view.getUint16(6, true)
  const gridZ = view.getUint16(8, true)
  if (gridX !== WATER_FIELD_GRID || gridZ !== WATER_FIELD_GRID) {
    throw new Error(
      `water field grid ${gridX}×${gridZ} != expected ${WATER_FIELD_GRID}×${WATER_FIELD_GRID}`
    )
  }
  const expected = HEADER_BYTES + gridX * gridZ * BYTES_PER_PIXEL
  if (buffer.byteLength !== expected) {
    throw new Error(
      `water field size ${buffer.byteLength} does not match header (expected ${expected})`
    )
  }

  const count = gridX * gridZ
  const surfaceY = new Float32Array(count)
  const flowX = new Float32Array(count)
  const flowZ = new Float32Array(count)
  const riverness = new Float32Array(count)
  let off = HEADER_BYTES
  for (let i = 0; i < count; i++) {
    const enc = view.getUint16(off, true)
    surfaceY[i] = enc * HEIGHT_STEP_M - HEIGHT_BIAS_M
    flowX[i] = view.getInt8(off + 2) / 127
    flowZ[i] = view.getInt8(off + 3) / 127
    riverness[i] = view.getUint8(off + 4) / 255
    off += BYTES_PER_PIXEL
  }
  return { surfaceY, flowX, flowZ, riverness }
}
