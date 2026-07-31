import { describe, expect, it } from 'vitest'
import { findChopTarget, worldToTile } from './chop-target'
import type { TreePlacementData } from './tree-data'

// Build in-memory TreePlacementData the way tree-data.ts lays it out:
// [u32 tree1Count][u32 tree2Count] then interleaved f32 [x,y,z,rot,scale].
function placementData(
  tree1: number[][],
  tree2: number[][]
): TreePlacementData {
  const floats = [...tree1, ...tree2].flat()
  const buffer = new ArrayBuffer(8 + floats.length * 4)
  const header = new Uint32Array(buffer, 0, 2)
  header[0] = tree1.length
  header[1] = tree2.length
  new Float32Array(buffer, 8).set(floats)
  return { tree1Count: tree1.length, tree2Count: tree2.length, buffer }
}

describe('worldToTile', () => {
  it('matches the Rust tile convention (tile 0 spans [-32, 32))', () => {
    expect(worldToTile(0)).toBe(0)
    expect(worldToTile(31.9)).toBe(0)
    expect(worldToTile(32)).toBe(1)
    expect(worldToTile(-32)).toBe(0)
    expect(worldToTile(-32.1)).toBe(-1)
  })
})

describe('findChopTarget', () => {
  const oakNear = [1.0, 5.0, 1.0, 0, 1.2]
  const oakFar = [3.5, 5.0, 0.0, 0, 2.0]
  const tree2Close = [0.5, 5.0, 0.5, 0, 0.8]

  it('picks the nearest standing tree across both slots', () => {
    const data = placementData([oakNear, oakFar], [tree2Close])
    const hit = findChopTarget(
      0,
      0,
      (tx, tz) => (tx === 0 && tz === 0 ? data : null),
      () => false
    )
    expect(hit).not.toBeNull()
    expect(hit!.kind).toBe(1)
    expect(hit!.index).toBe(0)
    expect(hit!.x).toBeCloseTo(0.5)
  })

  it('skips felled trees and returns the next nearest', () => {
    const data = placementData([oakNear], [tree2Close])
    const hit = findChopTarget(
      0,
      0,
      (tx, tz) => (tx === 0 && tz === 0 ? data : null),
      (_tx, _tz, kind, index) => kind === 1 && index === 0
    )
    expect(hit).not.toBeNull()
    expect(hit!.kind).toBe(0)
  })

  it('returns null when nothing stands within the snap radius', () => {
    const data = placementData([[20.0, 5.0, 20.0, 0, 1.0]], [])
    const hit = findChopTarget(
      0,
      0,
      (tx, tz) => (tx === 0 && tz === 0 ? data : null),
      () => false
    )
    expect(hit).toBeNull()
  })

  it('searches across tile boundaries', () => {
    // A tree at x=33 lives in tile 1; a click at x=31 must still find it.
    const data = placementData([[33.0, 5.0, 0.0, 0, 1.0]], [])
    const hit = findChopTarget(
      31,
      0,
      (tx, tz) => (tx === 1 && tz === 0 ? data : null),
      () => false
    )
    expect(hit).not.toBeNull()
    expect(hit!.tileX).toBe(1)
  })
})
