import { describe, expect, it } from 'vitest'
import type { PlayerState } from '../../../utils/movementUtils'
import {
  createAttackRuntimePatch,
  createControlRuntimePatch,
  createObjectInteractionRuntimePatch,
  createPickupInteractionRuntimePatch,
  createStartedMovementRuntimePatch,
} from './runtime-patch'

const playerState: PlayerState = {
  state: 'idle',
  speed: 0,
  rotation: 0,
  position: { x: 1, y: 2, z: 3 },
}

describe('runtime patch helpers', () => {
  it('maps a full control runtime reset into a component patch', () => {
    expect(
      createControlRuntimePatch({
        isMoving: false,
        movementTarget: null,
        movementState: null,
        currentSpeed: 0,
        pathWaypoints: [],
        currentWaypointIndex: 0,
        pendingPickupAfterMoveInstanceId: null,
      })
    ).toEqual({
      isMoving: false,
      movementTarget: null,
      movementState: null,
      currentSpeed: 0,
      pathWaypoints: [],
      currentWaypointIndex: 0,
      pendingPickupAfterMoveInstanceId: null,
    })
  })

  it('maps started click movement runtime including total distance', () => {
    const movementState = {
      currentSpeed: 1,
      startPos: { x: 1, y: 0, z: 2 },
      targetPos: { x: 5, y: 0, z: 6 },
      totalDistance: 12,
    }
    const movementTarget = { x: 5, y: 0, z: 6 }

    expect(
      createStartedMovementRuntimePatch({
        pathWaypoints: [{ x: 5, z: 6, floor: 0 }],
        currentWaypointIndex: 0,
        movementState,
        movementTarget,
        playerRotation: 1.25,
        isMoving: true,
        pendingPickupAfterMoveInstanceId: 42,
        totalDistance: 12,
      })
    ).toEqual({
      pathWaypoints: [{ x: 5, z: 6, floor: 0 }],
      currentWaypointIndex: 0,
      movementState,
      movementTarget,
      playerRotation: 1.25,
      isMoving: true,
      pendingPickupAfterMoveInstanceId: 42,
      totalDistance: 12,
    })
  })

  it('maps attack, object interaction, and pickup interaction runtime patches', () => {
    expect(
      createAttackRuntimePatch({
        kind: 'started',
        nextPlayerState: playerState,
        pendingPickupAfterMoveInstanceId: null,
      })
    ).toEqual({ pendingPickupAfterMoveInstanceId: null })

    expect(
      createObjectInteractionRuntimePatch({
        pendingPickupAfterMoveInstanceId: null,
        isMoving: false,
        movementTarget: null,
        playerRotation: 2,
        nextPlayerState: playerState,
        entryPosition: { x: 1, z: 3 },
      })
    ).toEqual({
      pendingPickupAfterMoveInstanceId: null,
      isMoving: false,
      movementTarget: null,
      playerRotation: 2,
    })

    expect(
      createPickupInteractionRuntimePatch({
        kind: 'started',
        pendingPickupAfterMoveInstanceId: null,
        pendingPickupInstanceId: 7,
        isMoving: false,
        movementTarget: null,
        movementState: null,
        currentSpeed: 0,
        nextPlayerState: playerState,
      })
    ).toEqual({
      pendingPickupAfterMoveInstanceId: null,
      pendingPickupInstanceId: 7,
      isMoving: false,
      movementTarget: null,
      movementState: null,
      currentSpeed: 0,
    })
  })
})
