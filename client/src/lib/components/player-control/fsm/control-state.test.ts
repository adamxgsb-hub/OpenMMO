import { describe, expect, it } from 'vitest'
import type { PlayerState } from '../../../utils/movementUtils'
import { resolveControlStateName } from './control-state'

function playerState(
  state: PlayerState['state'],
  extra: Partial<PlayerState> = {}
): PlayerState {
  return {
    state,
    speed: 0,
    rotation: 0,
    position: { x: 0, y: 0, z: 0 },
    ...extra,
  }
}

describe('resolveControlStateName', () => {
  it('maps direct animation states to control states', () => {
    expect(
      resolveControlStateName({
        playerState: playerState('dead'),
        isMoving: true,
        hasKeyboardInput: true,
      })
    ).toBe('dead')

    expect(
      resolveControlStateName({
        playerState: playerState('attack'),
        isMoving: false,
        hasKeyboardInput: false,
      })
    ).toBe('attacking')

    expect(
      resolveControlStateName({
        playerState: playerState('jump'),
        isMoving: false,
        hasKeyboardInput: false,
      })
    ).toBe('jump_feedback')
  })

  it('splits object interaction and pickup interaction', () => {
    expect(
      resolveControlStateName({
        playerState: playerState('interact', { interactionAnim: 'pickup' }),
        isMoving: false,
        hasKeyboardInput: false,
      })
    ).toBe('picking_up')

    expect(
      resolveControlStateName({
        playerState: playerState('interact', { interactionAnim: 'sit' }),
        isMoving: false,
        hasKeyboardInput: false,
      })
    ).toBe('object_interacting')
  })

  it('distinguishes keyboard movement from click movement', () => {
    expect(
      resolveControlStateName({
        playerState: playerState('idle'),
        isMoving: true,
        hasKeyboardInput: true,
      })
    ).toBe('keyboard_moving')

    expect(
      resolveControlStateName({
        playerState: playerState('idle'),
        isMoving: true,
        hasKeyboardInput: false,
      })
    ).toBe('moving')
  })

  it('keeps idle when no movement runtime is active', () => {
    expect(
      resolveControlStateName({
        playerState: playerState('idle'),
        isMoving: false,
        hasKeyboardInput: true,
      })
    ).toBe('idle')
  })
})
