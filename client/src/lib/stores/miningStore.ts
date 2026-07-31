import { writable } from 'svelte/store'
import type { OreNodeKey } from '../network/networkTypes'

/** The local player's place in the mining loop. All timing is server-side —
 *  `mining` covers the whole swing loop; the strikes arrive as broadcasts. */
export type MiningPhase = 'idle' | 'mining'

export const myMiningPhase = writable<MiningPhase>('idle')

/** Stable string form of a vein identity, for Set/Map keys. */
export function oreNodeKeyString(key: OreNodeKey): string {
  return `${key.tile_x},${key.tile_z},${key.index}`
}

/** Veins this client saw crumble (`MiningNodeDepleted`) and not yet respawn.
 *  Best-effort visual state: a player who arrives later simply sees the
 *  intact rock and learns the truth on their first swing — the server is
 *  the authority either way (doc/MINING.md). */
export const depletedOreNodes = writable<Set<string>>(new Set())

export function markNodeDepleted(key: OreNodeKey) {
  depletedOreNodes.update((set) => {
    const next = new Set(set)
    next.add(oreNodeKeyString(key))
    return next
  })
}

export function markNodeRespawned(key: OreNodeKey) {
  depletedOreNodes.update((set) => {
    const id = oreNodeKeyString(key)
    if (!set.has(id)) return set
    const next = new Set(set)
    next.delete(id)
    return next
  })
}

export function resetMiningStore() {
  myMiningPhase.set('idle')
  depletedOreNodes.set(new Set())
}
