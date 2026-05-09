import type { Position, PlayerState } from '../../utils/movementUtils'

export function buildJumpState(prev: PlayerState): PlayerState {
  return {
    ...prev,
    state: 'jump',
    speed: 0,
    movementMode: undefined,
    attackCounter: undefined,
  }
}

/** Used after exiting both pickup and object interactions — same shape. */
export function buildIdleAfterInteract(prev: PlayerState): PlayerState {
  return {
    ...prev,
    state: 'idle',
    speed: 0,
    interactionAnim: undefined,
    interactOffsetY: undefined,
  }
}

export function buildAttackState(
  prev: PlayerState,
  rotation?: number
): PlayerState {
  return { ...prev, state: 'attack', rotation: rotation ?? prev.rotation }
}

export function buildIdleAfterAttack(prev: PlayerState): PlayerState {
  return { ...prev, state: 'idle', attackCounter: 0 }
}

export function buildDeadState(prev: PlayerState): PlayerState {
  return {
    ...prev,
    state: 'dead',
    speed: 0,
    movementMode: undefined,
  }
}

export function buildRespawnedState(
  prev: PlayerState,
  position: Position,
  rotation: number
): PlayerState {
  return {
    ...prev,
    state: 'idle',
    speed: 0,
    rotation,
    movementMode: undefined,
    attackCounter: 0,
    position,
  }
}

export function buildInteractState(
  prev: PlayerState,
  position: Position,
  rotation: number,
  anim: string,
  offsetY: number
): PlayerState {
  return {
    ...prev,
    state: 'interact',
    speed: 0,
    rotation,
    position,
    interactionAnim: anim,
    interactOffsetY: offsetY,
  }
}

export function buildPickupState(prev: PlayerState): PlayerState {
  return {
    ...prev,
    state: 'interact',
    speed: 0,
    interactionAnim: 'pickup',
  }
}
