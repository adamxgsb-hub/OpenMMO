import { beforeEach, describe, expect, it } from 'vitest'
import { get } from 'svelte/store'
import {
  depletedOreNodes,
  markNodeDepleted,
  markNodeRespawned,
  myMiningPhase,
  oreNodeKeyString,
  resetMiningStore,
} from './miningStore'

const VEIN = { tile_x: 2, tile_z: -3, index: 1 }
const OTHER = { tile_x: 2, tile_z: -3, index: 2 }

describe('miningStore', () => {
  beforeEach(() => resetMiningStore())

  it('starts idle with nothing depleted', () => {
    expect(get(myMiningPhase)).toBe('idle')
    expect(get(depletedOreNodes).size).toBe(0)
  })

  it('tracks depletion and respawn per vein', () => {
    markNodeDepleted(VEIN)
    expect(get(depletedOreNodes).has(oreNodeKeyString(VEIN))).toBe(true)
    // Its neighbour is untouched — depletion is per vein, not per tile.
    expect(get(depletedOreNodes).has(oreNodeKeyString(OTHER))).toBe(false)

    markNodeRespawned(VEIN)
    expect(get(depletedOreNodes).size).toBe(0)
  })

  it('replaces the set so Svelte sees the change', () => {
    const before = get(depletedOreNodes)
    markNodeDepleted(VEIN)
    expect(get(depletedOreNodes)).not.toBe(before)
  })

  it('is idempotent on repeat broadcasts', () => {
    markNodeDepleted(VEIN)
    markNodeDepleted(VEIN)
    expect(get(depletedOreNodes).size).toBe(1)

    markNodeRespawned(VEIN)
    // A respawn for a vein this client never saw crumble is a no-op, not a
    // crash: broadcasts are radius-gated, so arriving late is normal.
    markNodeRespawned(VEIN)
    markNodeRespawned(OTHER)
    expect(get(depletedOreNodes).size).toBe(0)
  })

  it('resets phase and depletion together on logout', () => {
    myMiningPhase.set('mining')
    markNodeDepleted(VEIN)
    resetMiningStore()
    expect(get(myMiningPhase)).toBe('idle')
    expect(get(depletedOreNodes).size).toBe(0)
  })
})
