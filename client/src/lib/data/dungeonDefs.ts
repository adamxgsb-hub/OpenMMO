/**
 * Dungeon entrance registry, embedded at build time from data/dungeons.json
 * (generated from data-src/dungeons.csv). The server embeds the same file,
 * so entrances never travel over the network; the entrance id seeds the
 * deterministic layout generator on both sides.
 */
import dungeonsJson from '../../../../data/dungeons.json'

export interface DungeonEntranceDef {
  id: string
  name: string
  x: number
  y: number
  z: number
  rotation: number
}

export const DUNGEON_ENTRANCES: DungeonEntranceDef[] = Object.values(
  dungeonsJson as Record<string, DungeonEntranceDef>
)
