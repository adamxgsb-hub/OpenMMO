import type { PlayerState } from '../../../utils/movementUtils'

export type PlayerControlStateName =
  | 'idle'
  | 'moving'
  | 'keyboard_moving'
  | 'attacking'
  | 'object_interacting'
  | 'picking_up'
  | 'dead'
  | 'jump_feedback'

export interface ResolveControlStateInput {
  playerState: PlayerState
  isMoving: boolean
  hasKeyboardInput: boolean
}

export function resolveControlStateName({
  playerState,
  isMoving,
  hasKeyboardInput,
}: ResolveControlStateInput): PlayerControlStateName {
  switch (playerState.state) {
    case 'dead':
      return 'dead'
    case 'jump':
      return 'jump_feedback'
    case 'attack':
      return 'attacking'
    case 'interact':
      return playerState.interactionAnim === 'pickup'
        ? 'picking_up'
        : 'object_interacting'
    case 'moving':
      return hasKeyboardInput && isMoving ? 'keyboard_moving' : 'moving'
    case 'idle':
      return isMoving
        ? hasKeyboardInput
          ? 'keyboard_moving'
          : 'moving'
        : 'idle'
  }
}
