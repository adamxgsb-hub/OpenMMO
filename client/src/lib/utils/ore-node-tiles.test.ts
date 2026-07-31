import { describe, expect, it } from 'vitest'
import {
  HEIGHT_TILE_BYTES,
  SPLAT_TILE_BYTES,
  heightmapBytes,
  oreNodeKeyString,
  tileBytesAreWellFormed,
} from './ore-node-tiles'

describe('ore node tile bytes', () => {
  it('views a heightmap as the little-endian bytes the server read', () => {
    const heights = new Uint16Array([0, 1, 0x0201, 0xffff])
    const bytes = heightmapBytes(heights)
    expect(bytes.length).toBe(heights.length * 2)
    // Little-endian, and the same bytes the .bin file holds — the shared
    // derivation decodes them identically on both sides.
    expect(Array.from(bytes)).toEqual([0, 0, 1, 0, 1, 2, 255, 255])
  })

  it('views without copying, including offset views', () => {
    const backing = new Uint16Array([1, 2, 3, 4])
    const view = backing.subarray(1, 3)
    const bytes = heightmapBytes(view)
    expect(bytes.length).toBe(4)
    expect(Array.from(bytes)).toEqual([2, 0, 3, 0])
    // A real view: mutating the source shows through.
    backing[1] = 0x0102
    expect(Array.from(bytes)).toEqual([2, 1, 3, 0])
  })

  it('accepts exactly the tile shapes the derivation expects', () => {
    const splat = new Uint8Array(SPLAT_TILE_BYTES)
    const heights = new Uint16Array(HEIGHT_TILE_BYTES / 2)
    expect(tileBytesAreWellFormed(splat, heights)).toBe(true)
    // 64×64×4 splat, 65×65 u16 heightmap — the sizes the terrain endpoints
    // serve and the server reads from disk.
    expect(SPLAT_TILE_BYTES).toBe(16384)
    expect(HEIGHT_TILE_BYTES).toBe(8450)
  })

  it('rejects short or oversized tiles instead of feeding them to wasm', () => {
    const goodSplat = new Uint8Array(SPLAT_TILE_BYTES)
    const goodHeights = new Uint16Array(HEIGHT_TILE_BYTES / 2)
    expect(
      tileBytesAreWellFormed(new Uint8Array(SPLAT_TILE_BYTES - 4), goodHeights)
    ).toBe(false)
    expect(
      tileBytesAreWellFormed(new Uint8Array(SPLAT_TILE_BYTES + 4), goodHeights)
    ).toBe(false)
    expect(
      tileBytesAreWellFormed(
        goodSplat,
        new Uint16Array(HEIGHT_TILE_BYTES / 2 - 1)
      )
    ).toBe(false)
    expect(tileBytesAreWellFormed(new Uint8Array(0), new Uint16Array(0))).toBe(
      false
    )
  })

  it('keys veins by tile and index, including negative tiles', () => {
    expect(oreNodeKeyString({ tile_x: 2, tile_z: -3, index: 4 })).toBe('2,-3,4')
    // Distinct veins never collide, and the same vein always agrees.
    expect(oreNodeKeyString({ tile_x: 2, tile_z: -3, index: 4 })).toBe(
      oreNodeKeyString({ tile_x: 2, tile_z: -3, index: 4 })
    )
    expect(oreNodeKeyString({ tile_x: 2, tile_z: -3, index: 5 })).not.toBe(
      oreNodeKeyString({ tile_x: 2, tile_z: -3, index: 4 })
    )
    expect(oreNodeKeyString({ tile_x: -3, tile_z: 2, index: 4 })).not.toBe(
      oreNodeKeyString({ tile_x: 2, tile_z: -3, index: 4 })
    )
  })
})
