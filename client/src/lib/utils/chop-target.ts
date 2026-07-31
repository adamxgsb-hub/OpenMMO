/**
 * Resolve a clicked ground point to the nearest standing baked tree, from
 * the same decoded tile data the tree layer renders. Position-based on
 * purpose: instanced meshes have no stable ids to raycast (their slot
 * indices reshuffle every occlusion rebuild), while (tile, slot, index)
 * into the decoded arrays is exactly how the server addresses trees too.
 *
 * The 4 m snap radius mirrors the server's `TREE_SNAP_RADIUS_METERS`
 * (shared/src/woodcutting.rs); the server re-validates, so this only
 * decides chop-vs-walk — the fishing-cast precedent.
 */

import { TERRAIN_TILE_SIZE } from '../components/game-scene/terrain-utils'
import { getTreeInstanceData, type TreePlacementData } from './tree-data'

export const CHOP_SNAP_RADIUS_METERS = 4.0

export interface ChopTarget {
  /** Trunk world position (the point sent to the server). */
  x: number
  y: number
  z: number
  tileX: number
  tileZ: number
  /** Model slot: 0 = tree.glb, 1 = tree2.glb. */
  kind: number
  /** Index within the slot's array — the server's `TreeRef.index`. */
  index: number
}

/** Tile covering a world coordinate: tile 0 spans [-32, 32). Mirrors the
 *  Rust `coords::world_to_tile`. */
export function worldToTile(w: number): number {
  return Math.floor((w + TERRAIN_TILE_SIZE / 2) / TERRAIN_TILE_SIZE)
}

/**
 * Nearest standing tree within the snap radius of (x, z), or null.
 * `getTile` supplies decoded tile data (null when not loaded — unloaded
 * tiles simply can't be chopped into, the server would refuse anyway);
 * `isFelled` filters current stumps.
 */
export function findChopTarget(
  x: number,
  z: number,
  getTile: (tileX: number, tileZ: number) => TreePlacementData | null,
  isFelled: (
    tileX: number,
    tileZ: number,
    kind: number,
    index: number
  ) => boolean
): ChopTarget | null {
  const r = CHOP_SNAP_RADIUS_METERS
  let best: ChopTarget | null = null
  let bestDistSq = r * r

  for (let tileZ = worldToTile(z - r); tileZ <= worldToTile(z + r); tileZ++) {
    for (let tileX = worldToTile(x - r); tileX <= worldToTile(x + r); tileX++) {
      const data = getTile(tileX, tileZ)
      if (!data) continue
      for (let kind = 0; kind < 2; kind++) {
        const raw = getTreeInstanceData(data, kind === 0 ? 'tree1' : 'tree2')
        const count = raw.length / 5
        for (let i = 0; i < count; i++) {
          const base = i * 5
          const dx = raw[base] - x
          const dz = raw[base + 2] - z
          const distSq = dx * dx + dz * dz
          if (distSq > bestDistSq) continue
          if (isFelled(tileX, tileZ, kind, i)) continue
          best = {
            x: raw[base],
            y: raw[base + 1],
            z: raw[base + 2],
            tileX,
            tileZ,
            kind,
            index: i,
          }
          bestDistSq = distSq
        }
      }
    }
  }
  return best
}
