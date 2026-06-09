import {
  calculateMovementStep,
  initMovementState,
  type MovementConfig,
  type MovementState,
  type Position,
} from '../../../utils/movementUtils'

export interface PathWaypoint {
  x: number
  z: number
  floor: number
}

interface MovementSubstrateInput {
  currentPos: Position
  movementTarget: Position
  movementState: MovementState
  pathWaypoints: PathWaypoint[]
  currentWaypointIndex: number
  config: MovementConfig
  deltaTimeSeconds: number
  sampleHeight: (x: number, z: number) => number
  isMovementBlocked: (
    fromX: number,
    fromZ: number,
    toX: number,
    toZ: number,
    y: number
  ) => boolean
  isUphillTooSteep: (
    x: number,
    z: number,
    y: number,
    dirX: number,
    dirZ: number
  ) => boolean
  getFloorLevel: () => number
  setFloorLevel: (floor: number) => void
  writePlayerPosition: (position: Position, rotation: number) => void
  sendPlayerMove: (position: Position, rotation: number) => void
}

export type MovementSubstrateOutcome =
  | { kind: 'blocked' }
  | { kind: 'slope_blocked' }
  | {
      kind: 'continued'
      currentSpeed: number
      playerRotation: number
      totalDistance: number
    }
  | {
      kind: 'next_waypoint'
      currentSpeed: number
      playerRotation: number
      movementTarget: Position
      movementState: MovementState
      currentWaypointIndex: number
    }
  | {
      kind: 'arrived'
      currentSpeed: number
      playerRotation: number
    }

export function stepMovementSubstrate({
  currentPos,
  movementTarget,
  movementState,
  pathWaypoints,
  currentWaypointIndex,
  config,
  deltaTimeSeconds,
  sampleHeight,
  isMovementBlocked,
  isUphillTooSteep,
  getFloorLevel,
  setFloorLevel,
  writePlayerPosition,
  sendPlayerMove,
}: MovementSubstrateInput): MovementSubstrateOutcome {
  const result = calculateMovementStep(
    currentPos,
    movementState,
    config,
    deltaTimeSeconds
  )

  movementState.currentSpeed = result.newSpeed
  const currentSpeed = result.newSpeed
  const playerRotation = result.rotation

  if (result.arrived) {
    if (
      isMovementBlocked(
        currentPos.x,
        currentPos.z,
        movementTarget.x,
        movementTarget.z,
        currentPos.y
      )
    ) {
      return { kind: 'blocked' }
    }

    const arrivedWp = pathWaypoints[currentWaypointIndex]
    if (arrivedWp && arrivedWp.floor !== getFloorLevel()) {
      setFloorLevel(arrivedWp.floor)
    }

    writePlayerPosition(
      {
        x: movementTarget.x,
        y: sampleHeight(movementTarget.x, movementTarget.z),
        z: movementTarget.z,
      },
      playerRotation
    )

    const nextWaypointIndex = currentWaypointIndex + 1
    if (nextWaypointIndex < pathWaypoints.length) {
      const nextWp = pathWaypoints[nextWaypointIndex]

      if (nextWp.floor !== getFloorLevel()) {
        setFloorLevel(nextWp.floor)
      }

      const wpPos: Position = {
        x: nextWp.x,
        y: sampleHeight(nextWp.x, nextWp.z),
        z: nextWp.z,
      }

      const ndx = wpPos.x - movementTarget.x
      const ndz = wpPos.z - movementTarget.z
      const nextRotation = Math.atan2(ndx, ndz)
      const nextMovementState = initMovementState(
        movementTarget,
        wpPos,
        movementState.currentSpeed
      )

      sendPlayerMove(wpPos, nextRotation)

      return {
        kind: 'next_waypoint',
        currentSpeed: nextMovementState.currentSpeed,
        playerRotation: nextRotation,
        movementTarget: wpPos,
        movementState: nextMovementState,
        currentWaypointIndex: nextWaypointIndex,
      }
    }

    sendPlayerMove(movementTarget, playerRotation)
    return { kind: 'arrived', currentSpeed, playerRotation }
  }

  if (
    isMovementBlocked(
      currentPos.x,
      currentPos.z,
      result.newPos.x,
      result.newPos.z,
      currentPos.y
    )
  ) {
    return { kind: 'blocked' }
  }

  const dirX = Math.sin(result.rotation)
  const dirZ = Math.cos(result.rotation)
  if (isUphillTooSteep(currentPos.x, currentPos.z, currentPos.y, dirX, dirZ)) {
    return { kind: 'slope_blocked' }
  }

  writePlayerPosition(
    {
      x: result.newPos.x,
      y: sampleHeight(result.newPos.x, result.newPos.z),
      z: result.newPos.z,
    },
    playerRotation
  )

  return {
    kind: 'continued',
    currentSpeed,
    playerRotation,
    totalDistance: movementState.totalDistance,
  }
}
