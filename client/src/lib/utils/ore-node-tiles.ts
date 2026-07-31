import type { OreNodeKey } from '../network/networkTypes'

/**
 * Tile-byte glue for the ore-node layer. The shared wasm
 * (`ore_nodes_for_tile`) is the single source of truth for where veins are —
 * the server validates mining against the identical function — so these
 * helpers only prepare its inputs and guard their shape. Kept out of the
 * Svelte layer so the byte contract is unit-testable (doc/MINING.md).
 */

/** Splat tile: 64×64 cells × 4 bytes (V2 encoding). */
export const SPLAT_TILE_BYTES = 64 * 64 * 4

/** Heightmap tile: 65×65 vertices × 2 bytes (u16 LE). */
export const HEIGHT_TILE_BYTES = 65 * 65 * 2

/** One vein as the shared `OreNode` crosses the wasm boundary. */
export interface WasmOreNode {
  index: number
  world_x: number
  world_y: number
  world_z: number
  rotation: number
  scale: number
  variant: number
  yield_total: number
}

/**
 * The raw little-endian bytes behind a heightmap, without copying. The
 * managers hand out `Uint16Array` views straight off the fetched buffer,
 * and the wasm derivation wants the same bytes the server read from disk —
 * so this must be a view, not a re-encode, or the two would diverge on a
 * big-endian host.
 */
export function heightmapBytes(heights: Uint16Array): Uint8Array {
  return new Uint8Array(heights.buffer, heights.byteOffset, heights.length * 2)
}

/**
 * Whether a tile's bytes are the exact shapes the derivation expects.
 * A short or oversized tile means a partial fetch or a format change;
 * skipping it leaves the tile to be retried rather than throwing out of
 * wasm on every pass.
 */
export function tileBytesAreWellFormed(
  splat: Uint8Array,
  heights: Uint16Array
): boolean {
  return (
    splat.length === SPLAT_TILE_BYTES &&
    heights.length * 2 === HEIGHT_TILE_BYTES
  )
}

/** Stable string form of a vein identity, for Set/Map keys. */
export function oreNodeKeyString(key: OreNodeKey): string {
  return `${key.tile_x},${key.tile_z},${key.index}`
}
