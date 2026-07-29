import { writable } from 'svelte/store'
import type { BoatSnapshot, Position } from '../network/networkTypes'

/** One visible boat, mirrored from server broadcasts (`BoatSpawned` /
 *  `BoatState` / `BoatBoarded` / `BoatLeft`). Like the fishing bobbers,
 *  broadcasts are radius-gated server-side, so this map is "nearby only";
 *  a boat that sails out of range simply falls silent and is dropped when
 *  its `BoatRemoved` arrives or the store resets. */
export type BoatView = {
  id: number
  owner: number
  /** Server hull position; the rendered hull eases toward it. */
  position: Position
  heading: number
  sailing: boolean
  /** player id → seat. */
  riders: Map<number, number>
}

export const boats = writable<Map<number, BoatView>>(new Map())

/** The local player's berth: which boat, which seat, and whether they hold
 *  the tiller. Null while ashore. */
export type MyBerth = { boatId: number; seat: number; isPilot: boolean }
export const myBerth = writable<MyBerth | null>(null)

export function upsertBoat(snapshot: BoatSnapshot) {
  boats.update((map) => {
    const next = new Map(map)
    next.set(snapshot.id, {
      id: snapshot.id,
      owner: snapshot.owner,
      position: snapshot.position,
      heading: snapshot.heading,
      sailing: false,
      riders: new Map(snapshot.passengers.map((p) => [p.player_id, p.seat])),
    })
    return next
  })
}

export function applyBoatState(
  boatId: number,
  position: Position,
  heading: number,
  sailing: boolean
) {
  boats.update((map) => {
    const existing = map.get(boatId)
    if (!existing) return map
    const next = new Map(map)
    next.set(boatId, { ...existing, position, heading, sailing })
    return next
  })
}

export function removeBoat(boatId: number) {
  boats.update((map) => {
    if (!map.has(boatId)) return map
    const next = new Map(map)
    next.delete(boatId)
    return next
  })
}

export function setBoatRider(boatId: number, playerId: number, seat: number) {
  boats.update((map) => {
    const existing = map.get(boatId)
    if (!existing) return map
    const next = new Map(map)
    const riders = new Map(existing.riders)
    riders.set(playerId, seat)
    next.set(boatId, { ...existing, riders })
    return next
  })
}

export function clearBoatRider(boatId: number, playerId: number) {
  boats.update((map) => {
    const existing = map.get(boatId)
    if (!existing?.riders.has(playerId)) return map
    const next = new Map(map)
    const riders = new Map(existing.riders)
    riders.delete(playerId)
    next.set(boatId, { ...existing, riders })
    return next
  })
}

export function resetBoatsStore() {
  boats.set(new Map())
  myBerth.set(null)
}
