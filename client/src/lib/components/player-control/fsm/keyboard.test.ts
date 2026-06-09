import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_MOVEMENT_CONFIG } from '../../../utils/movementUtils'
import {
  applyKeyboardMovement,
  applyKeyboardMovementOutcome,
  runKeyboardFrame,
  type KeyboardFrameActions,
  type KeyboardMovementOutcomeActions,
} from './keyboard'

function makeInput() {
  return {
    currentPos: { x: 0, y: 1, z: 0 },
    direction: { x: 1, z: 0 },
    config: DEFAULT_MOVEMENT_CONFIG,
    sampleHeight: vi.fn((x: number, z: number) => x + z),
    isMovementBlocked: vi.fn(() => false),
    isUphillTooSteep: vi.fn(() => false),
    writePlayerPosition: vi.fn(),
    sendPlayerMove: vi.fn(),
  }
}

function outcomeActions(): KeyboardMovementOutcomeActions {
  return {
    stopMovement: vi.fn(),
    triggerJumpFeedback: vi.fn(),
    setMoved: vi.fn(),
  }
}

function frameActions(): KeyboardFrameActions {
  return {
    exitPickupInteraction: vi.fn(),
    exitObjectInteraction: vi.fn(),
    clearClickMovement: vi.fn(),
    cancelCombat: vi.fn(),
    markMoving: vi.fn(),
    setKeyboardIdleRuntime: vi.fn(),
    emitKeyboardPlayerState: vi.fn(),
    stopMovement: vi.fn(),
    triggerJumpFeedback: vi.fn(),
    setMoved: vi.fn(),
  }
}

const movementDeps = {
  config: {
    maxSpeed: 3,
    acceleration: 6,
    deceleration: 6,
    arrivalThreshold: 0.05,
  },
  sampleHeight: () => 0,
  isMovementBlocked: () => false,
  isUphillTooSteep: () => false,
  writePlayerPosition: vi.fn(),
  sendPlayerMove: vi.fn(),
}

describe('applyKeyboardMovement', () => {
  it('moves at fixed keyboard step and sends the new position', () => {
    const input = makeInput()

    const outcome = applyKeyboardMovement(input)

    expect(outcome.kind).toBe('moved')
    expect(input.writePlayerPosition).toHaveBeenCalledWith(
      { x: 0.025, y: 0.025, z: 0 },
      Math.PI / 2
    )
    expect(input.sendPlayerMove).toHaveBeenCalledWith(
      { x: 0.025, y: 0.025, z: 0 },
      Math.PI / 2
    )
  })

  it('blocks movement before writing or sending', () => {
    const input = makeInput()
    input.isMovementBlocked.mockReturnValue(true)

    const outcome = applyKeyboardMovement(input)

    expect(outcome.kind).toBe('blocked')
    expect(input.writePlayerPosition).not.toHaveBeenCalled()
    expect(input.sendPlayerMove).not.toHaveBeenCalled()
  })

  it('reports steep uphill feedback before writing or sending', () => {
    const input = makeInput()
    input.isUphillTooSteep.mockReturnValue(true)

    const outcome = applyKeyboardMovement(input)

    expect(outcome.kind).toBe('slope_blocked')
    expect(input.writePlayerPosition).not.toHaveBeenCalled()
    expect(input.sendPlayerMove).not.toHaveBeenCalled()
  })
})

describe('applyKeyboardMovementOutcome', () => {
  it('stops movement on blocked outcomes', () => {
    const a = outcomeActions()

    expect(applyKeyboardMovementOutcome({ kind: 'blocked' }, a)).toEqual({
      kind: 'handled',
    })

    expect(a.stopMovement).toHaveBeenCalledOnce()
    expect(a.triggerJumpFeedback).not.toHaveBeenCalled()
  })

  it('stops movement and triggers jump feedback on slope blocks', () => {
    const a = outcomeActions()

    expect(applyKeyboardMovementOutcome({ kind: 'slope_blocked' }, a)).toEqual({
      kind: 'handled',
    })

    expect(a.stopMovement).toHaveBeenCalledOnce()
    expect(a.triggerJumpFeedback).toHaveBeenCalledOnce()
  })

  it('stores moved speed and rotation', () => {
    const a = outcomeActions()

    expect(
      applyKeyboardMovementOutcome(
        { kind: 'moved', currentSpeed: 3, playerRotation: 0.75 },
        a
      )
    ).toEqual({ kind: 'moved' })

    expect(a.setMoved).toHaveBeenCalledWith(3, 0.75)
  })
})

describe('runKeyboardFrame', () => {
  it('does nothing without a player or pressed keys', () => {
    const a = frameActions()

    runKeyboardFrame({
      currentPlayer: null,
      hasKeysPressed: true,
      interactionExit: 'none',
      hasMovementTarget: false,
      isInCombat: false,
      direction: null,
      actions: a,
      ...movementDeps,
    })

    expect(a.emitKeyboardPlayerState).not.toHaveBeenCalled()
  })

  it('exits interaction and cancels click movement before applying input', () => {
    const a = frameActions()

    runKeyboardFrame({
      currentPlayer: { position: { x: 0, y: 0, z: 0 } },
      hasKeysPressed: true,
      interactionExit: 'object',
      hasMovementTarget: true,
      isInCombat: true,
      direction: null,
      actions: a,
      ...movementDeps,
    })

    expect(a.exitObjectInteraction).toHaveBeenCalledOnce()
    expect(a.clearClickMovement).toHaveBeenCalledOnce()
    expect(a.cancelCombat).toHaveBeenCalledTimes(2)
    expect(a.setKeyboardIdleRuntime).toHaveBeenCalledOnce()
    expect(a.emitKeyboardPlayerState).toHaveBeenCalledOnce()
  })

  it('marks movement and emits player state after successful movement', () => {
    const a = frameActions()

    runKeyboardFrame({
      currentPlayer: { position: { x: 0, y: 0, z: 0 } },
      hasKeysPressed: true,
      interactionExit: 'none',
      hasMovementTarget: false,
      isInCombat: false,
      direction: { x: 1, z: 0 },
      actions: a,
      ...movementDeps,
    })

    expect(a.markMoving).toHaveBeenCalledOnce()
    expect(a.setMoved).toHaveBeenCalledOnce()
    expect(a.emitKeyboardPlayerState).toHaveBeenCalledOnce()
  })

  it('preserves early return for blocked movement outcomes', () => {
    const a = frameActions()

    runKeyboardFrame({
      currentPlayer: { position: { x: 0, y: 0, z: 0 } },
      hasKeysPressed: true,
      interactionExit: 'none',
      hasMovementTarget: false,
      isInCombat: false,
      direction: { x: 1, z: 0 },
      actions: a,
      ...movementDeps,
      isMovementBlocked: () => true,
    })

    expect(a.stopMovement).toHaveBeenCalledOnce()
    expect(a.emitKeyboardPlayerState).not.toHaveBeenCalled()
  })
})
