import type { MovementConfig, Position } from '../../../utils/movementUtils'
import type { InteractionExitKind } from './interaction'

// ───────────────────────────────────────────────────────────────────────────
// Keyboard movement integrator (fixed-step, no accel/decel/waypoints)
// ───────────────────────────────────────────────────────────────────────────

export interface KeyboardDirection {
  x: number
  z: number
}

interface KeyboardMovementInput {
  currentPos: Position
  direction: KeyboardDirection
  config: MovementConfig
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
  writePlayerPosition: (position: Position, rotation: number) => void
  sendPlayerMove: (position: Position, rotation: number) => void
}

export type KeyboardMovementOutcome =
  | { kind: 'blocked' }
  | { kind: 'slope_blocked' }
  | {
      kind: 'moved'
      currentSpeed: number
      playerRotation: number
    }

export function applyKeyboardMovement({
  currentPos,
  direction,
  config,
  sampleHeight,
  isMovementBlocked,
  isUphillTooSteep,
  writePlayerPosition,
  sendPlayerMove,
}: KeyboardMovementInput): KeyboardMovementOutcome {
  const currentSpeed = config.maxSpeed
  const speed = config.maxSpeed * (1000 / 120 / 1000)
  const newX = currentPos.x + direction.x * speed
  const newZ = currentPos.z + direction.z * speed

  if (isMovementBlocked(currentPos.x, currentPos.z, newX, newZ, currentPos.y)) {
    return { kind: 'blocked' }
  }

  if (
    isUphillTooSteep(
      currentPos.x,
      currentPos.z,
      currentPos.y,
      direction.x,
      direction.z
    )
  ) {
    return { kind: 'slope_blocked' }
  }

  const groundY = sampleHeight(newX, newZ)
  const playerRotation = Math.atan2(direction.x, direction.z)
  const position = { x: newX, y: groundY, z: newZ }

  writePlayerPosition(position, playerRotation)
  sendPlayerMove(position, playerRotation)

  return {
    kind: 'moved',
    currentSpeed,
    playerRotation,
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Keyboard movement outcome application
// ───────────────────────────────────────────────────────────────────────────

export interface KeyboardMovementOutcomeActions {
  stopMovement: () => void
  triggerJumpFeedback: () => void
  setMoved: (currentSpeed: number, playerRotation: number) => void
}

export type KeyboardMovementOutcomeApplication =
  | { kind: 'handled' }
  | { kind: 'moved' }

export function applyKeyboardMovementOutcome(
  outcome: KeyboardMovementOutcome,
  actions: KeyboardMovementOutcomeActions
): KeyboardMovementOutcomeApplication {
  switch (outcome.kind) {
    case 'blocked':
      actions.stopMovement()
      return { kind: 'handled' }

    case 'slope_blocked':
      actions.stopMovement()
      actions.triggerJumpFeedback()
      return { kind: 'handled' }

    case 'moved':
      actions.setMoved(outcome.currentSpeed, outcome.playerRotation)
      return { kind: 'moved' }

    default: {
      const _exhaustive: never = outcome
      return _exhaustive
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Keyboard frame (per-frame WASD step with click-move / combat preemption)
// ───────────────────────────────────────────────────────────────────────────

interface KeyboardFramePlayer {
  position: Position
}

export interface KeyboardFrameActions extends KeyboardMovementOutcomeActions {
  exitPickupInteraction: () => void
  exitObjectInteraction: () => void
  clearClickMovement: () => void
  cancelCombat: () => void
  markMoving: () => void
  setKeyboardIdleRuntime: () => void
  emitKeyboardPlayerState: () => void
}

interface RunKeyboardFrameInput {
  currentPlayer: KeyboardFramePlayer | null
  hasKeysPressed: boolean
  interactionExit: InteractionExitKind
  hasMovementTarget: boolean
  isInCombat: boolean
  direction: KeyboardDirection | null
  config: MovementConfig
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
  writePlayerPosition: (position: Position, rotation: number) => void
  sendPlayerMove: (position: Position, rotation: number) => void
  actions: KeyboardFrameActions
}

export function runKeyboardFrame({
  currentPlayer,
  hasKeysPressed,
  interactionExit,
  hasMovementTarget,
  isInCombat,
  direction,
  config,
  sampleHeight,
  isMovementBlocked,
  isUphillTooSteep,
  writePlayerPosition,
  sendPlayerMove,
  actions,
}: RunKeyboardFrameInput) {
  if (!currentPlayer || !hasKeysPressed) return

  if (interactionExit !== 'none') {
    if (interactionExit === 'pickup') {
      actions.exitPickupInteraction()
    } else {
      actions.exitObjectInteraction()
    }
  }

  if (hasMovementTarget) {
    actions.clearClickMovement()
    actions.cancelCombat()
  }

  if (isInCombat) {
    actions.cancelCombat()
  }

  if (direction) {
    const outcome = applyKeyboardMovement({
      currentPos: {
        x: currentPlayer.position.x,
        y: currentPlayer.position.y,
        z: currentPlayer.position.z,
      },
      direction,
      config,
      sampleHeight,
      isMovementBlocked,
      isUphillTooSteep,
      writePlayerPosition: (position, rotation) => {
        writePlayerPosition(position, rotation)
        actions.markMoving()
      },
      sendPlayerMove,
    })

    const keyboardApplication = applyKeyboardMovementOutcome(outcome, actions)
    if (keyboardApplication.kind === 'handled') return
  } else {
    actions.setKeyboardIdleRuntime()
  }

  actions.emitKeyboardPlayerState()
}
