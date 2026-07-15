/**
 * dungeon-geo-entrance.ts — the surface entrance structure, rendered at depth 0
 * so the terrain hole over the shaft reads as a covered stairwell (mossy-plaster
 * walls, corner pillars, a gabled gravel roof, descending stairs and double
 * doors). Local to (originX, entranceY, originZ) like the floor groups.
 */
import * as THREE from 'three'
import { addMergedMeshes, type GeoEntry } from './house-geo-utils'
import {
  ENTRANCE_WALL_T,
  shaftCoverRun,
  type DungeonShaft,
} from '../managers/dungeonManager'
import { addBox, addGableRoof } from './dungeon-geo-primitives'
import { shaftRect, collectShaftStairs } from './dungeon-geo-shaft'
import {
  addEntranceArch,
  buildEntranceDoors,
  type DoorLeaf,
} from './dungeon-geo-doors'
import {
  DUNGEON_VOID_TEXTURE_IDX,
  DUNGEON_ENTRANCE_WALL_TEXTURE_IDX,
  DUNGEON_CEILING_TEXTURE_IDX,
  DUNGEON_PILLAR_TEXTURE_IDX,
  type DungeonGeoCtx,
} from './dungeon-geo-constants'

/**
 * Surface entrance structure, rendered at depth 0 so the terrain hole over
 * the shaft reads as a covered stairwell. Renders the descending stairs (so
 * the player visibly walks down the upper half before the floor-1 group takes
 * over at the shaft midpoint) plus stone walls on the two run-axis sides and
 * the far (deep) end, spanning from a dark pit floor one floor down
 * (−floorHeight) up to a raised parapet (+ABOVE), capped by a gabled gravel
 * roof — a small roofed shed over the stairs. The entry end stays open as
 * an ABOVE-tall doorway.
 *
 * The covered footprint is anchored at the entry (shallow) end — one landing
 * cell gap, then half the tread span toward the deep end — so the shed is a
 * compact porch over the upper stairs (shaftHoleRect insets the deep end to
 * match). The stairs themselves are still built full-length, so the lower half
 * continues descending under the terrain past the porch's far wall (which lands
 * on the shaft midpoint, where the depth-0↔1 swap hides this group anyway). The
 * anchored inset depends on `reversed` (which end is the entry).
 *
 * The whole group (roof included) is shown only at depth 0 via group
 * visibility. Local to (originX, entranceY, originZ) like floors.
 */
export interface DungeonEntranceGroup {
  group: THREE.Group
  /** Double-door leaves at the entry; caller lerps each rotation.y open/shut. */
  doors: DoorLeaf[]
}

export function buildDungeonEntranceGroup(
  entranceShaft: DungeonShaft,
  ctx: DungeonGeoCtx
): DungeonEntranceGroup {
  const entries: GeoEntry[] = []
  const r = shaftRect(entranceShaft, ctx)

  // Covered footprint: anchored at the entry (shallow) end with a one-cell
  // landing gap, then running half the tread span toward the deep end (the
  // remaining lower stairs continue under the terrain). shaftCoverRun is the
  // single source the terrain hole (shaftHoleRect) also uses, so the two stay
  // in lockstep.
  const { inset, coverLen } = shaftCoverRun(
    ctx.shaftLen,
    entranceShaft.reversed
  )
  const cr = entranceShaft.alongZ
    ? { x: r.x, w: r.w, z: r.z + inset, d: coverLen }
    : { x: r.x + inset, w: coverLen, z: r.z, d: r.d }

  // How far the walls descend — matches the up-shaft drop to floor 1.
  const depth = ctx.floorHeight
  // Headroom above the entry surface: walls rise this far above ground (a
  // raised parapet) and the gabled roof sits on top. The deep end clears
  // depth + ABOVE; the entry end is an ABOVE-tall doorway.
  const ABOVE = 3.0
  const T = ENTRANCE_WALL_T // wall thickness (shared with collision)
  const CT = 0.2 // roof slab thickness
  const OH = 0.5 // lateral roof eave overhang (past the ~0.35m corner pillars)
  const END_OH = 0.5 // run-axis (gable end) overhang past the corner pillars
  const RIDGE_RISE = 1.0 // gable peak height above the walls

  // Dark floor at the bottom of the visible shaft (backs the open pit so it
  // doesn't show through to the sky).
  addBox(
    entries,
    DUNGEON_VOID_TEXTURE_IDX,
    cr.w,
    0.05,
    cr.d,
    cr.x + cr.w / 2,
    -depth + 0.025,
    cr.z + cr.d / 2
  )

  // Mossy-plaster walls on the two run-axis sides and the far (deep) end,
  // spanning [−depth, +ABOVE]. The entry end stays open. Slight outset so
  // walking the shaft never clips them. (Surface building — distinct texture
  // from the underground stone walls.)
  const wallH = depth + ABOVE
  const wallCy = (ABOVE - depth) / 2 // center of the [−depth, +ABOVE] span
  const wallTex = DUNGEON_ENTRANCE_WALL_TEXTURE_IDX
  // Deep/far end is the high-coordinate end unless the shaft runs reversed.
  const farPositive = !entranceShaft.reversed
  if (entranceShaft.alongZ) {
    addBox(
      entries,
      wallTex,
      T,
      wallH,
      cr.d + T,
      cr.x - T / 2,
      wallCy,
      cr.z + cr.d / 2
    )
    addBox(
      entries,
      wallTex,
      T,
      wallH,
      cr.d + T,
      cr.x + cr.w + T / 2,
      wallCy,
      cr.z + cr.d / 2
    )
    const farZ = farPositive ? cr.z + cr.d + T / 2 : cr.z - T / 2
    addBox(
      entries,
      wallTex,
      cr.w + T * 2,
      wallH,
      T,
      cr.x + cr.w / 2,
      wallCy,
      farZ
    )
  } else {
    addBox(
      entries,
      wallTex,
      cr.w + T,
      wallH,
      T,
      cr.x + cr.w / 2,
      wallCy,
      cr.z - T / 2
    )
    addBox(
      entries,
      wallTex,
      cr.w + T,
      wallH,
      T,
      cr.x + cr.w / 2,
      wallCy,
      cr.z + cr.d + T / 2
    )
    const farX = farPositive ? cr.x + cr.w + T / 2 : cr.x - T / 2
    addBox(
      entries,
      wallTex,
      T,
      wallH,
      cr.d + T * 2,
      farX,
      wallCy,
      cr.z + cr.d / 2
    )
  }

  // Front wall over the door: fills the entry opening above the rounded cap
  // plus the front gable triangle (so the doorway reads as a fitted arch under
  // a gabled wall, all stone). entryLow = entry at the low-coord end.
  addEntranceArch(
    entries,
    entranceShaft.alongZ,
    cr,
    farPositive,
    ctx,
    ABOVE,
    RIDGE_RISE
  )

  // Decorative stone square pillars at the four footprint corners, protruding
  // PILLAR_PROTRUDE proud of the wall outer faces (centre offset diagonally
  // outward = wall outset + protrusion − half the pillar). Plain boxes from
  // the ground to just under the roof.
  const PILLAR_SIZE = 0.3
  const PILLAR_PROTRUDE = 0.1
  const pillarOff = T + PILLAR_PROTRUDE - PILLAR_SIZE / 2
  const pillarBase = -0.3 // sink slightly so it never floats over dipping terrain
  const pillarTop = ABOVE - 0.07 // stop short of the roof eaves
  const pillarH = pillarTop - pillarBase
  const pillarCy = (pillarTop + pillarBase) / 2
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      const cornerX = sx < 0 ? cr.x : cr.x + cr.w
      const cornerZ = sz < 0 ? cr.z : cr.z + cr.d
      addBox(
        entries,
        DUNGEON_PILLAR_TEXTURE_IDX,
        PILLAR_SIZE,
        pillarH,
        PILLAR_SIZE,
        cornerX + sx * pillarOff,
        pillarCy,
        cornerZ + sz * pillarOff
      )
    }
  }

  // Gabled gravel-stone roof on top, ridge along the run axis. The gable
  // planes are the doorway edge (entry) and the far wall's *outer* face — so
  // END_OH overhangs past the actual walls on both ends, not the footprint
  // (the far wall is outset by T, which would otherwise eat the overhang).
  // The entry-end gable triangle is omitted — the front wall above supplies it.
  const roofShift = farPositive ? T / 2 : -T / 2
  const alongZ = entranceShaft.alongZ
  const [runDim, latDim] = alongZ ? [cr.d, cr.w] : [cr.w, cr.d]
  // Entry gable is the low-coord end when farPositive, else the high-coord end.
  const entryGableSign = farPositive ? -1 : 1
  addGableRoof(
    entries,
    DUNGEON_CEILING_TEXTURE_IDX,
    alongZ,
    cr.x + cr.w / 2 + (alongZ ? 0 : roofShift),
    cr.z + cr.d / 2 + (alongZ ? roofShift : 0),
    runDim + T,
    latDim,
    ABOVE,
    RIDGE_RISE,
    OH,
    END_OH,
    CT,
    entryGableSign
  )

  // Descending stairs (no side wall — the walls above supply the sides; no
  // landings — terrain covers the entry row, the dark pit floor backs the deep
  // end). Same world-space geometry as the floor-1 up-shaft.
  collectShaftStairs(
    entries,
    entranceShaft,
    ctx,
    0,
    -depth,
    false,
    false,
    false
  )

  // Double doors across the open entry end (kept separate from the merged
  // meshes so they can swing). Local to the same (origin, entranceY) frame.
  const doors = buildEntranceDoors(entranceShaft, cr, ctx)

  const group = new THREE.Group()
  addMergedMeshes(group, entries)
  for (const leaf of doors) group.add(leaf.pivot)
  return { group, doors }
}
