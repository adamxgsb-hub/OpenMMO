import {
  passability_find_path,
  passability_find_path_budget,
} from '../wasm/onlinerpg_shared'
import { dungeonManager } from './dungeonManager'

export interface PathWaypoint {
  x: number
  z: number
  floor: number
}

export interface PathResult {
  waypoints: PathWaypoint[]
  found: boolean
}

/**
 * Find a smoothed path on a 1m world grid with floor-level awareness.
 * Delegates to the WASM A* implementation in the shared crate.
 */
export function findPath(
  startX: number,
  startZ: number,
  startFloor: number,
  goalX: number,
  goalZ: number,
  goalFloor: number
): PathResult {
  // Dungeon floors are 56×56 mazes; cross-floor routes can exhaust the
  // housing default node budget, so dungeon queries get a bigger one.
  const c = dungeonManager.consts
  if (startFloor >= c.floorIndexBase || goalFloor >= c.floorIndexBase) {
    return passability_find_path_budget(
      startX,
      startZ,
      startFloor,
      goalX,
      goalZ,
      goalFloor,
      c.pathMaxNodes
    ) as PathResult
  }
  return passability_find_path(
    startX,
    startZ,
    startFloor,
    goalX,
    goalZ,
    goalFloor
  ) as PathResult
}
