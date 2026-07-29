import { describe, expect, it } from 'vitest'
import {
  DECK_HEIGHT_M,
  SNAP_DISTANCE_M,
  seatWorldPosition,
  stepBoatTransform,
  type BoatTransform,
} from './boat-transform'
import { WORLD_MAX_X, WORLD_MIN_X } from '../terrain/world-wrap'

const SPEED = 6

const at = (x: number, z: number, heading = 0): BoatTransform => ({
  x,
  y: 0,
  z,
  heading,
})

describe('stepBoatTransform', () => {
  it('glides toward the target at boat speed with catch-up slack', () => {
    const stepped = stepBoatTransform(at(0, 0), at(0, 20), 0.2, SPEED)
    // 6 m/s * 1.25 catch-up * 0.2 s = 1.5 m
    expect(stepped.z).toBeCloseTo(1.5, 3)
    expect(stepped.x).toBe(0)
  })

  it('arrives exactly instead of orbiting the target', () => {
    const stepped = stepBoatTransform(at(0, 0), at(0, 0.5), 0.2, SPEED)
    expect(stepped.z).toBeCloseTo(0.5, 5)
  })

  it('crosses the world seam the short way', () => {
    const stepped = stepBoatTransform(
      at(WORLD_MAX_X - 1, 0),
      at(WORLD_MIN_X + 1, 0),
      0.2,
      SPEED
    )
    // Moving east across the seam: x grows past WORLD_MAX_X and wraps, so
    // the result sits near the west edge, not somewhere mid-world.
    expect(
      Math.min(
        Math.abs(stepped.x - (WORLD_MAX_X - 1)),
        Math.abs(stepped.x - (WORLD_MIN_X - 1))
      )
    ).toBeLessThan(2)
  })

  it('snaps on jumps too large to glide', () => {
    const target = at(0, SNAP_DISTANCE_M + 5)
    expect(stepBoatTransform(at(0, 0), target, 0.016, SPEED)).toEqual(target)
  })

  it('turns the bow along the shortest arc', () => {
    // From just past -π toward just short of +π: the short way crosses the
    // ±π seam, so the heading should move *away* from zero.
    const current = at(0, 0, -3)
    const target = at(0, 0, 3)
    const stepped = stepBoatTransform(current, target, 0.1, SPEED)
    expect(Math.abs(stepped.heading)).toBeGreaterThan(3 - 0.3)
  })
})

describe('seatWorldPosition', () => {
  it('stands riders on the deck', () => {
    const seat = seatWorldPosition(at(10, 5), 0)
    expect(seat.y).toBeCloseTo(DECK_HEIGHT_M, 5)
  })

  it('rotates seat offsets with the hull', () => {
    // Helm sits aft (-z locally). Heading 0 faces +z, so aft is -z; after a
    // half turn the same seat sits at +z of the hull.
    const before = seatWorldPosition(at(0, 0, 0), 0)
    const after = seatWorldPosition(at(0, 0, Math.PI), 0)
    expect(before.z).toBeLessThan(0)
    expect(after.z).toBeCloseTo(-before.z, 4)
    expect(after.x).toBeCloseTo(-before.x, 4)
  })

  it('keeps every seat within a hull length of the mast', () => {
    for (const seat of [0, 1, 2, 3]) {
      const p = seatWorldPosition(at(0, 0, 1.234), seat)
      expect(Math.hypot(p.x, p.z)).toBeLessThan(2)
    }
  })
})
