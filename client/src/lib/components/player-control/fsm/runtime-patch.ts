import type { MovementState, Position } from '../../../utils/movementUtils'
import type { BeginAttackOutcome } from './combat'
import type { MovementStartRuntime } from './move-request'
import type { PathWaypoint } from './movement-substrate'
import type {
  BeginObjectInteractionOutcome,
  BeginPickupOutcome,
} from './interaction'
import type { ControlRuntimeState } from './lifecycle'

export interface PlayerControlRuntimePatch {
  isMoving?: boolean
  movementTarget?: Position | null
  movementState?: MovementState | null
  currentSpeed?: number
  pathWaypoints?: PathWaypoint[]
  currentWaypointIndex?: number
  pendingPickupAfterMoveInstanceId?: number | null
  pendingPickupInstanceId?: number | null
  playerRotation?: number
  totalDistance?: number
}

export function createControlRuntimePatch(
  runtime: ControlRuntimeState
): PlayerControlRuntimePatch {
  return {
    isMoving: runtime.isMoving,
    movementTarget: runtime.movementTarget,
    movementState: runtime.movementState,
    currentSpeed: runtime.currentSpeed,
    pathWaypoints: runtime.pathWaypoints,
    currentWaypointIndex: runtime.currentWaypointIndex,
    pendingPickupAfterMoveInstanceId: runtime.pendingPickupAfterMoveInstanceId,
  }
}

export function createStartedMovementRuntimePatch(
  runtime: MovementStartRuntime
): PlayerControlRuntimePatch {
  return {
    pathWaypoints: runtime.pathWaypoints,
    currentWaypointIndex: runtime.currentWaypointIndex,
    movementState: runtime.movementState,
    movementTarget: runtime.movementTarget,
    playerRotation: runtime.playerRotation,
    isMoving: runtime.isMoving,
    pendingPickupAfterMoveInstanceId: runtime.pendingPickupAfterMoveInstanceId,
    totalDistance: runtime.totalDistance,
  }
}

export function createAttackRuntimePatch(
  outcome: Extract<BeginAttackOutcome, { kind: 'started' }>
): PlayerControlRuntimePatch {
  return {
    pendingPickupAfterMoveInstanceId: outcome.pendingPickupAfterMoveInstanceId,
  }
}

export function createObjectInteractionRuntimePatch(
  outcome: BeginObjectInteractionOutcome
): PlayerControlRuntimePatch {
  return {
    pendingPickupAfterMoveInstanceId: outcome.pendingPickupAfterMoveInstanceId,
    isMoving: outcome.isMoving,
    movementTarget: outcome.movementTarget,
    playerRotation: outcome.playerRotation,
  }
}

export function createPickupInteractionRuntimePatch(
  outcome: Extract<BeginPickupOutcome, { kind: 'started' }>
): PlayerControlRuntimePatch {
  return {
    pendingPickupAfterMoveInstanceId: outcome.pendingPickupAfterMoveInstanceId,
    pendingPickupInstanceId: outcome.pendingPickupInstanceId,
    isMoving: outcome.isMoving,
    movementTarget: outcome.movementTarget,
    movementState: outcome.movementState,
    currentSpeed: outcome.currentSpeed,
  }
}
