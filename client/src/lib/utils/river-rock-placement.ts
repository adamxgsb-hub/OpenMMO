import type { WaterFieldTileData } from './water-field-data'
import { RIVER_WHITEWATER_ONSET, WATER_FIELD_GRID } from './water-field-data'
import { TERRAIN_TILE_SIZE } from '../components/game-scene/terrain-utils'

/**
 * Deterministic river-rock placement from the baked water field.
 *
 * Rocks go at whitewater's upstream onset: a candidate is where the
 * current crosses into turbulence high enough to seed a wake. Candidates
 * are accepted greedily under a minimum spacing, so
 * a broad onset gets a small rock cluster while a lone pocket gets one.
 * Every client derives the same rocks from the same WFD1 data (pure
 * function of the tile payload + tile coords), so no extra bake artifact
 * or network message is needed.
 */

export interface RiverRockPlacement {
  /** World-space rock centre — the onset pixel displaced 0.8·halfWidth
   *  downstream so the spray burst (emitted 0.8 radii upstream of the
   *  centre) lands on the whitewater impact point. `y` is the baked
   *  water surface at the pixel. */
  x: number
  y: number
  z: number
  /** Variant index 0..2 → river_rock_01/02/03.glb. */
  variant: number
  /** Yaw (radians). */
  rotY: number
  /** Target above-water silhouette height (m) — the renderer normalizes
   *  the GLB's bounding box to this. */
  height: number
  /** Approximate world half-width (m) of the rendered rock, from
   *  {@link VARIANT_HALFWIDTH_RATIO} × height. Mesh offset, spray line,
   *  and wake-mask start all derive from this one value. */
  halfWidth: number
  /** Unit downstream flow direction at the rock pixel. */
  flowX: number
  flowZ: number
  /** Baked flow speed 0.3..1 (estuary-decayed, radial-enveloped) —
   *  scales the wake-foam drift velocity. */
  speed: number
  /** Water-surface drop per meter downstream (m/m, ≥ 0) over a short
   *  probe — drifting wake foam follows the surface down a rapid
   *  instead of floating off it. */
  surfaceDrop: number
  /** Baked turbulence at the pixel (drives spray rate / wake density). */
  turb: number
}

/** Keep rocks inside the channel proper (no estuary/bank-fade strays). */
const MIN_RIVERNESS = 0.55
/** Below this flow magnitude there is no meaningful "front/behind". */
const MIN_FLOW = 0.05
/** Cluster grain: a foam bloom seats roughly one rock per this spacing,
 *  so a ~15 m patch gets 2-3 and a lone pocket gets one. */
const ROCK_SPACING_M = 4.5
const MAX_ROCKS_PER_TILE = 6

/** A rock (and its foam wake / spray) only shows where the water surface
 *  clears the bed by this much — the turbulence field extends into the
 *  bank fade where the surface has already dropped below the terrain. */
export const MIN_ROCK_DEPTH_M = 0.25

/** halfWidth/height of each rock GLB's bounding box (river_rock_01..03).
 *  Keeps placement (and therefore the water layer's wake mask) free of
 *  any runtime GLB dependency; the rock layer warns when a re-exported
 *  model drifts from these ratios. */
export const VARIANT_HALFWIDTH_RATIO = [0.944, 1.154, 1.274]

/** Drop placements whose seat has no real water under it. `getBedHeight`
 *  null means the terrain heights are unavailable — keep everything
 *  rather than filter against a bogus bed. Shared by the rock layer and
 *  the water layer's wake mask so the two can never disagree. */
export function filterVisibleRocks(
  rocks: RiverRockPlacement[],
  getBedHeight: ((x: number, z: number) => number) | null
): RiverRockPlacement[] {
  if (!getBedHeight) return rocks
  return rocks.filter((p) => p.y - getBedHeight(p.x, p.z) >= MIN_ROCK_DEPTH_M)
}

/** Deterministic 0..1 hash — same inputs, same rock, on every client. */
function hash01(a: number, b: number, c: number, salt: number): number {
  let h =
    Math.imul(a | 0, 0x27d4eb2d) ^
    Math.imul(b | 0, 0x165667b1) ^
    Math.imul(c | 0, 0x9e3779b1) ^
    Math.imul(salt | 0, 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

export function computeRockPlacements(
  field: WaterFieldTileData,
  tileX: number,
  tileZ: number
): RiverRockPlacement[] {
  const G = WATER_FIELD_GRID
  const { turbulence, riverness, flowX, flowZ, surfaceY } = field

  // A candidate is the upstream edge of a foam patch: turbulence is at
  // the whitewater onset here, while the immediately upstream field pixel
  // is below it. This puts the obstruction where its moving wake begins,
  // rather than somewhere in an already-turbulent interior.
  const candidates: { i: number; j: number; t: number }[] = []
  for (let j = 0; j < G; j++) {
    for (let i = 0; i < G; i++) {
      const idx = j * G + i
      const t = turbulence[idx]
      if (t < RIVER_WHITEWATER_ONSET || riverness[idx] < MIN_RIVERNESS) continue
      const fx = flowX[idx]
      const fz = flowZ[idx]
      const fLen = Math.hypot(fx, fz)
      if (fLen < MIN_FLOW) continue
      const si = Math.round(fx / fLen)
      const sj = Math.round(fz / fLen)
      const upstreamI = i - si
      const upstreamJ = j - sj
      // Seam ownership: row/col 64 duplicates the neighbour tile's 0 (the
      // field bytes are identical per the WFD1 contract), so each shared
      // world pixel must spawn from exactly one tile:
      // (a) If the upstream probe leaves the grid, skip — the mirrored
      //     view of the same pixel (our 64 ↔ neighbour's 0) has the probe
      //     in-grid, so that tile decides.
      // (b) When both views can probe (the step doesn't cross the shared
      //     edge), the 0-side owns it: keep an edge-64 candidate only when
      //     the step comes from inside (si/sj == 1), which is exactly when
      //     the 0-side view falls under (a).
      // Together every seam pixel has one owner — never zero, never two.
      if (
        upstreamI < 0 ||
        upstreamI >= G ||
        upstreamJ < 0 ||
        upstreamJ >= G ||
        (i === G - 1 && si !== 1) ||
        (j === G - 1 && sj !== 1) ||
        turbulence[upstreamJ * G + upstreamI] >= RIVER_WHITEWATER_ONSET
      )
        continue
      candidates.push({ i, j, t })
    }
  }

  // Prefer the pixels closest to the threshold, i.e. the actual foam
  // boundary, before filling any remaining spaced slots.
  candidates.sort((a, b) => a.t - b.t || a.j - b.j || a.i - b.i)

  const out: RiverRockPlacement[] = []
  const placed: { i: number; j: number }[] = []
  for (const c of candidates) {
    if (out.length >= MAX_ROCKS_PER_TILE) break
    let tooClose = false
    for (const p of placed) {
      const dx = c.i - p.i
      const dz = c.j - p.j
      if (dx * dx + dz * dz < ROCK_SPACING_M * ROCK_SPACING_M) {
        tooClose = true
        break
      }
    }
    if (tooClose) continue
    const pixel = c.j * G + c.i

    const idx = pixel
    const fx = flowX[idx]
    const fz = flowZ[idx]
    const fLen = Math.hypot(fx, fz)
    const ux = fx / fLen
    const uz = fz / fLen
    const jx = (hash01(tileX, tileZ, pixel, 11) - 0.5) * 0.9
    const jz = (hash01(tileX, tileZ, pixel, 12) - 0.5) * 0.9
    const variant = Math.min(2, Math.floor(hash01(tileX, tileZ, pixel, 5) * 3))
    const height = 0.55 + hash01(tileX, tileZ, pixel, 9) * 0.65
    const halfWidth = VARIANT_HALFWIDTH_RATIO[variant] * height
    // Tiles are CENTER-anchored (worldToTileCell rounds): tile (tx,tz)
    // spans [t·64−32, t·64+32), so pixel (0,0) sits at t·64−32 — using
    // t·64 as the origin displaced every rock by (+32,+32) onto whatever
    // terrain happened to be there.
    const originX = tileX * TERRAIN_TILE_SIZE - TERRAIN_TILE_SIZE / 2
    const originZ = tileZ * TERRAIN_TILE_SIZE - TERRAIN_TILE_SIZE / 2
    const probeI = Math.max(0, Math.min(G - 1, c.i + Math.round(ux * 3)))
    const probeJ = Math.max(0, Math.min(G - 1, c.j + Math.round(uz * 3)))
    const probeDist = Math.hypot(probeI - c.i, probeJ - c.j)
    const surfaceDrop =
      probeDist > 0
        ? Math.max(
            0,
            (surfaceY[idx] - surfaceY[probeJ * G + probeI]) / probeDist
          )
        : 0
    out.push({
      // Displace the centre 0.8·halfWidth downstream of the impact pixel
      // (see RiverRockPlacement.x docs) — depth filter, wake mask, and
      // renderer all consume this final centre.
      x: originX + c.i + jx + ux * halfWidth * 0.8,
      y: surfaceY[idx],
      z: originZ + c.j + jz + uz * halfWidth * 0.8,
      variant,
      rotY: hash01(tileX, tileZ, pixel, 7) * Math.PI * 2,
      height,
      halfWidth,
      flowX: ux,
      flowZ: uz,
      speed: Math.min(1, fLen),
      surfaceDrop,
      turb: c.t,
    })
    placed.push({ i: c.i, j: c.j })
  }
  return out
}
