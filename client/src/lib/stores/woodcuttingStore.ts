import { writable } from 'svelte/store'
import type { TreeRef, TreeStump } from '../network/networkTypes'

/** The local player's place in the chopping loop. There is no reflex phase:
 *  once `chopping`, the server swings on its own clock until the tree falls
 *  or something interrupts the work. */
export type ChopPhase = 'idle' | 'chopping'

export const myChopPhase = writable<ChopPhase>('idle')

/** The local player's chop progress (null while idle). `startedAt` is client
 *  receipt time — only used to animate the bar between swings; the
 *  authoritative timer lives on the server. */
export type ChopProgress = {
  swingsDone: number
  swingsNeeded: number
  swingMs: number
  startedAt: number
}

export const myChopProgress = writable<ChopProgress | null>(null)

/** Stable client-side key for a baked tree instance. Matches the tree
 *  layer's tile key convention (`${x}_${z}`). */
export function treeKey(tree: TreeRef): string {
  return `${tree.tile_x}_${tree.tile_z}_${tree.kind}_${tree.index}`
}

/** Every tree currently felled, world-wide (`TreeFelled` / `TreeRespawned`
 *  broadcasts plus the `TreeStumps` join snapshot). The tree layer skips
 *  these instances when rebuilding, and clicks refuse to target them. */
export const felledTrees = writable<Set<string>>(new Set())

export function markTreeFelled(tree: TreeRef) {
  felledTrees.update((set) => {
    const next = new Set(set)
    next.add(treeKey(tree))
    return next
  })
}

export function markTreeRespawned(tree: TreeRef) {
  felledTrees.update((set) => {
    const key = treeKey(tree)
    if (!set.has(key)) return set
    const next = new Set(set)
    next.delete(key)
    return next
  })
}

export function setFelledTrees(stumps: TreeStump[]) {
  felledTrees.set(new Set(stumps.map((s) => treeKey(s.tree))))
}

export function resetWoodcuttingStore() {
  myChopPhase.set('idle')
  myChopProgress.set(null)
  felledTrees.set(new Set())
}
