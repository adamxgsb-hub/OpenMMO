// Hull interpolation, the remotePlayerManager pattern: message handlers
// feed server targets in, the frame loop calls update(), and renderers read
// smooth transforms out. Riders are placed off these transforms too, so one
// eased hull moves everyone aboard in step.

import {
  seatWorldPosition,
  stepBoatTransform,
  type BoatTransform,
} from './boat-transform'
import { boat_speed_mps } from '../wasm/onlinerpg_shared'
import type * as THREE from 'three'

type TrackedBoat = {
  current: BoatTransform
  target: BoatTransform
}

class BoatManager {
  private tracked = new Map<number, TrackedBoat>()

  /** Hull scene objects by boat id, registered by Boat.svelte so canvas
   *  clicks can raycast them (each carries `userData.boatId`). */
  private meshes = new Map<number, THREE.Object3D>()

  /** First sight of a boat: render it where the server says, no glide. */
  spawn(boatId: number, transform: BoatTransform) {
    this.tracked.set(boatId, {
      current: { ...transform },
      target: { ...transform },
    })
  }

  /** A `BoatState` landed: ease toward it from the next update(). */
  setTarget(boatId: number, target: BoatTransform) {
    const entry = this.tracked.get(boatId)
    if (entry) {
      entry.target = { ...target }
    } else {
      this.spawn(boatId, target)
    }
  }

  remove(boatId: number) {
    this.tracked.delete(boatId)
    this.meshes.delete(boatId)
  }

  registerMesh(boatId: number, mesh: THREE.Object3D) {
    this.meshes.set(boatId, mesh)
  }

  unregisterMesh(boatId: number) {
    this.meshes.delete(boatId)
  }

  /** Raycast targets for hull clicks. */
  clickTargets(): THREE.Object3D[] {
    return [...this.meshes.values()]
  }

  update(deltaTime: number) {
    const speed = boat_speed_mps()
    for (const entry of this.tracked.values()) {
      entry.current = stepBoatTransform(
        entry.current,
        entry.target,
        deltaTime,
        speed
      )
    }
  }

  transformOf(boatId: number): BoatTransform | undefined {
    return this.tracked.get(boatId)?.current
  }

  /** Where a rider in `seat` stands right now, or undefined for an unknown
   *  boat (its next broadcast re-tracks it). */
  seatWorldPositionOf(boatId: number, seat: number) {
    const transform = this.transformOf(boatId)
    return transform ? seatWorldPosition(transform, seat) : undefined
  }

  reset() {
    this.tracked.clear()
    this.meshes.clear()
  }
}

export const boatManager = new BoatManager()
