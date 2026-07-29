// Pure hull-interpolation and seat math, extracted for unit tests (the
// fishingMessages.ts precedent: decidable rules live in a plain module, the
// Svelte and network glue stays thin).

import { shortestWrappedDeltaX, wrapWorldX } from '../terrain/world-wrap'

export type BoatTransform = {
  x: number
  y: number
  z: number
  heading: number
}

/** Above this, the hull teleports instead of gliding — a boat first seen at
 *  the edge of delivery radius must not surf across the whole screen. */
export const SNAP_DISTANCE_M = 30

/** Catch-up factor over the server's speed, like the walking sim's slack:
 *  the rendered hull may run slightly hot to close interpolation gaps, but
 *  never falls steadily behind the 200 ms `BoatState` cadence. */
export const CATCH_UP = 1.25

/** How fast the bow swings, radians per second. */
export const TURN_RATE = 2.5

/** Deck height riders stand at, above the water line — the modeled hull's
 *  floorboards sit just under it, and character origins are their soles
 *  (`computeSoleGroundOffset`). */
export const DECK_HEIGHT_M = 0.05

/** Seat positions in hull-local meters (x starboard, z forward): the helm
 *  aft, two benches midship, one seat at the bow. */
const SEAT_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, -1.1],
  [-0.42, 0.1],
  [0.42, 0.1],
  [0, 1.2],
]

export function seatLocalOffset(seat: number): readonly [number, number] {
  return SEAT_OFFSETS[seat] ?? SEAT_OFFSETS[0]
}

/** Wrap an angle into (-π, π]. */
function wrapAngle(a: number): number {
  while (a <= -Math.PI) a += 2 * Math.PI
  while (a > Math.PI) a -= 2 * Math.PI
  return a
}

/** Ease the rendered hull toward the last `BoatState`: cross the world seam
 *  the short way, swing the bow along the shortest arc, snap on jumps too
 *  large to glide. Returns a new transform (inputs are not mutated). */
export function stepBoatTransform(
  current: BoatTransform,
  target: BoatTransform,
  dtSec: number,
  speedMps: number
): BoatTransform {
  const dx = shortestWrappedDeltaX(current.x, target.x)
  const dz = target.z - current.z
  const dist = Math.hypot(dx, dz)
  if (dist > SNAP_DISTANCE_M) {
    return { ...target }
  }
  const maxStep = speedMps * CATCH_UP * Math.max(dtSec, 0)
  const t = dist > 0 ? Math.min(1, maxStep / dist) : 1
  const heading =
    current.heading +
    Math.sign(wrapAngle(target.heading - current.heading)) *
      Math.min(
        Math.abs(wrapAngle(target.heading - current.heading)),
        TURN_RATE * Math.max(dtSec, 0)
      )
  return {
    x: wrapWorldX(current.x + dx * t),
    y: current.y + (target.y - current.y) * t,
    z: current.z + dz * t,
    heading: wrapAngle(heading),
  }
}

/** Where a seat sits in world space for a given hull transform: rotate the
 *  hull-local offset by the heading (heading 0 faces +Z, matching the
 *  shared `heading_of`), stand on the deck. */
export function seatWorldPosition(
  transform: BoatTransform,
  seat: number
): { x: number; y: number; z: number } {
  const [localX, localZ] = seatLocalOffset(seat)
  const sin = Math.sin(transform.heading)
  const cos = Math.cos(transform.heading)
  return {
    x: wrapWorldX(transform.x + localX * cos + localZ * sin),
    y: transform.y + DECK_HEIGHT_M,
    z: transform.z - localX * sin + localZ * cos,
  }
}
