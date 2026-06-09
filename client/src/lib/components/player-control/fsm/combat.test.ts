import { describe, expect, it, vi } from 'vitest'
import type { CombatUpdateResult } from '../../../managers/combatController'
import {
  initMovementState,
  type PlayerState,
  type Position,
} from '../../../utils/movementUtils'
import {
  applyChaseTargetUpdate,
  applyCombatTickOutcome,
  beginAttack,
  ensureAttackState,
  resetAttackInRangeRuntime,
  runCombatFrame,
  tickCombat,
  transitionAttackToIdle,
  type CombatControllerLike,
  type CombatOutcomeActions,
  type CombatTickOutcome,
} from './combat'

function actions(): CombatOutcomeActions {
  return {
    stopMovingToIdle: vi.fn(),
    prepareReachedAttackRange: vi.fn(),
    beginAttack: vi.fn(),
    setChasingMovement: vi.fn(),
    showAttackState: vi.fn(),
    sendAttackCycle: vi.fn(),
  }
}

function makeCombatController(result: CombatUpdateResult) {
  return {
    targetMonsterId: 'monster-1',
    update: vi.fn(() => result),
  }
}

function frameController(action: 'none' | 'idle'): CombatControllerLike {
  return {
    targetMonsterId: 'm1',
    update: vi.fn(() => ({ action })),
  }
}

const currentPos = { x: 0, y: 0, z: 0 }
const playerPos: Position = { x: 0, y: 0, z: 0 }
const playerState: PlayerState = {
  state: 'idle',
  speed: 0,
  rotation: 0,
  position: { x: 0, y: 0, z: 0 },
}

describe('applyChaseTargetUpdate', () => {
  it('does nothing when no new target is available', () => {
    const sendPlayerMove = vi.fn()

    const outcome = applyChaseTargetUpdate({
      currentPos,
      movementTarget: null,
      movementState: null,
      currentSpeed: 0,
      sendPlayerMove,
    })

    expect(outcome.kind).toBe('unchanged')
    expect(sendPlayerMove).not.toHaveBeenCalled()
  })

  it('ignores tiny target changes', () => {
    const sendPlayerMove = vi.fn()

    const outcome = applyChaseTargetUpdate({
      currentPos,
      newTarget: { x: 1.05, y: 0, z: 1.05 },
      movementTarget: { x: 1, y: 0, z: 1 },
      movementState: initMovementState(currentPos, { x: 1, y: 0, z: 1 }),
      currentSpeed: 0,
      sendPlayerMove,
    })

    expect(outcome.kind).toBe('unchanged')
    expect(sendPlayerMove).not.toHaveBeenCalled()
  })

  it('initializes chase movement and sends the retarget packet', () => {
    const sendPlayerMove = vi.fn()
    const newTarget = { x: 3, y: 0, z: 4 }

    const outcome = applyChaseTargetUpdate({
      currentPos,
      newTarget,
      movementTarget: null,
      movementState: null,
      currentSpeed: 1.25,
      sendPlayerMove,
    })

    expect(outcome.kind).toBe('updated')
    if (outcome.kind !== 'updated') return
    expect(outcome.movementTarget).toBe(newTarget)
    expect(outcome.movementState.currentSpeed).toBe(1.25)
    expect(outcome.movementState.totalDistance).toBe(5)
    expect(sendPlayerMove).toHaveBeenCalledWith(newTarget, Math.atan2(3, 4))
  })

  it('updates existing movement state in place for chase retargets', () => {
    const sendPlayerMove = vi.fn()
    const movementState = initMovementState(currentPos, { x: 1, y: 0, z: 1 })
    const newTarget = { x: 6, y: 0, z: 8 }

    const outcome = applyChaseTargetUpdate({
      currentPos,
      newTarget,
      movementTarget: { x: 1, y: 0, z: 1 },
      movementState,
      currentSpeed: 0,
      sendPlayerMove,
    })

    expect(outcome.kind).toBe('updated')
    if (outcome.kind !== 'updated') return
    expect(outcome.movementState).toBe(movementState)
    expect(movementState.targetPos).toEqual(newTarget)
    expect(movementState.totalDistance).toBe(10)
  })
})

describe('tickCombat', () => {
  it('returns none when there is no combat target', () => {
    const controller = {
      targetMonsterId: null,
      update: vi.fn(),
    }

    const outcome = tickCombat({
      combatController: controller,
      deltaTime: 16,
      playerPos,
      playerStateName: 'idle',
      isMoving: false,
      currentSpeed: 0,
      movementTarget: null,
      movementState: null,
      cooldownMs: 1500,
      getMonsterInfo: vi.fn(),
      findMonsterPosition: vi.fn(),
      sendPlayerMove: vi.fn(),
    })

    expect(outcome.kind).toBe('none')
    expect(controller.update).not.toHaveBeenCalled()
  })

  it('maps attack cycles with rotation', () => {
    const controller = makeCombatController({
      action: 'attack_cycle',
      monsterId: 'monster-1',
      rotation: 1.25,
    })

    const outcome = tickCombat({
      combatController: controller,
      deltaTime: 16,
      playerPos,
      playerStateName: 'attack',
      isMoving: false,
      currentSpeed: 0,
      movementTarget: null,
      movementState: null,
      cooldownMs: 1500,
      getMonsterInfo: vi.fn(() => ({ state: 'idle' })),
      findMonsterPosition: vi.fn(() => ({ x: 1, y: 0, z: 0 })),
      sendPlayerMove: vi.fn(),
    })

    expect(outcome).toEqual({
      kind: 'attack_cycle',
      monsterId: 'monster-1',
      playerRotation: 1.25,
    })
  })

  it('updates chase movement when combat provides a new target', () => {
    const controller = makeCombatController({
      action: 'chasing',
      newTarget: { x: 3, y: 0, z: 4 },
    })
    const sendPlayerMove = vi.fn()

    const outcome = tickCombat({
      combatController: controller,
      deltaTime: 16,
      playerPos,
      playerStateName: 'moving',
      isMoving: true,
      currentSpeed: 0.5,
      movementTarget: null,
      movementState: null,
      cooldownMs: 1500,
      getMonsterInfo: vi.fn(() => ({ state: 'idle' })),
      findMonsterPosition: vi.fn(() => ({ x: 3, y: 0, z: 4 })),
      sendPlayerMove,
    })

    expect(outcome.kind).toBe('chasing_updated')
    expect(sendPlayerMove).toHaveBeenCalledWith(
      { x: 3, y: 0, z: 4 },
      Math.atan2(3, 4)
    )
  })
})

describe('applyCombatTickOutcome', () => {
  it('handles idle by stopping movement', () => {
    const a = actions()

    expect(applyCombatTickOutcome({ kind: 'idle' }, a)).toEqual({
      kind: 'handled',
    })
    expect(a.stopMovingToIdle).toHaveBeenCalledOnce()
  })

  it('handles reached attack range by preparing and starting attack', () => {
    const a = actions()

    expect(
      applyCombatTickOutcome(
        { kind: 'reached_attack_range', monsterId: 'm1' },
        a
      )
    ).toEqual({ kind: 'handled' })

    expect(a.prepareReachedAttackRange).toHaveBeenCalledOnce()
    expect(a.beginAttack).toHaveBeenCalledWith('m1')
  })

  it('continues into movement after chase updates', () => {
    const a = actions()
    const movementTarget = { x: 1, y: 2, z: 3 }
    const movementState = {
      currentSpeed: 1,
      startPos: { x: 0, y: 0, z: 0 },
      targetPos: movementTarget,
      totalDistance: 10,
    }

    expect(
      applyCombatTickOutcome(
        {
          kind: 'chasing_updated',
          movementTarget,
          movementState,
          playerRotation: 0.5,
        },
        a
      )
    ).toEqual({ kind: 'continue_movement' })

    expect(a.setChasingMovement).toHaveBeenCalledWith(
      movementTarget,
      movementState,
      0.5
    )
  })

  it('continues movement for no-op combat outcomes', () => {
    const a = actions()

    for (const outcome of [
      { kind: 'none' },
      { kind: 'chasing_unchanged' },
    ] satisfies CombatTickOutcome[]) {
      expect(applyCombatTickOutcome(outcome, a)).toEqual({
        kind: 'continue_movement',
      })
    }
  })

  it('handles attack animation and attack cycle outcomes', () => {
    const a = actions()

    expect(
      applyCombatTickOutcome({ kind: 'attacking', playerRotation: 1 }, a)
    ).toEqual({ kind: 'handled' })
    expect(
      applyCombatTickOutcome(
        { kind: 'attack_cycle', monsterId: 'm1', playerRotation: 2 },
        a
      )
    ).toEqual({ kind: 'handled' })

    expect(a.showAttackState).toHaveBeenCalledWith(1)
    expect(a.sendAttackCycle).toHaveBeenCalledWith('m1', 2)
  })
})

describe('runCombatFrame', () => {
  it('continues movement when combat is inactive or player is missing', () => {
    const a = actions()

    expect(
      runCombatFrame({
        isInCombat: false,
        combatController: frameController('idle'),
        deltaTime: 16,
        currentPlayer: { position: { x: 0, y: 0, z: 0 } },
        playerStateName: 'moving',
        isMoving: true,
        currentSpeed: 1,
        movementTarget: null,
        movementState: null,
        cooldownMs: 1500,
        getMonsterInfo: vi.fn(),
        findMonsterPosition: vi.fn(),
        sendPlayerMove: vi.fn(),
        actions: a,
      })
    ).toEqual({ kind: 'continue_movement' })

    expect(a.stopMovingToIdle).not.toHaveBeenCalled()
  })

  it('ticks combat and applies handled outcomes', () => {
    const a = actions()

    expect(
      runCombatFrame({
        isInCombat: true,
        combatController: frameController('idle'),
        deltaTime: 16,
        currentPlayer: { position: { x: 1, y: 2, z: 3 } },
        playerStateName: 'moving',
        isMoving: true,
        currentSpeed: 1,
        movementTarget: null,
        movementState: null,
        cooldownMs: 1500,
        getMonsterInfo: vi.fn(),
        findMonsterPosition: vi.fn(),
        sendPlayerMove: vi.fn(),
        actions: a,
      })
    ).toEqual({ kind: 'handled' })

    expect(a.stopMovingToIdle).toHaveBeenCalledOnce()
  })
})

describe('beginAttack', () => {
  it('ignores dead targets', () => {
    const beginCombat = vi.fn()

    const result = beginAttack({
      monsterId: 'm1',
      monsterInfo: { state: 'dead' },
      currentPosition: { x: 1, y: 0, z: 2 },
      playerRotation: 0,
      previousPlayerState: playerState,
      lastSentPosition: null,
      beginCombat,
      sendPlayerMove: vi.fn(),
      sendPlayerAttack: vi.fn(),
    })

    expect(result.kind).toBe('ignored_dead_target')
    expect(beginCombat).not.toHaveBeenCalled()
  })

  it('starts combat, syncs position, sends attack, and returns attack state', () => {
    const beginCombat = vi.fn()
    const sendPlayerMove = vi.fn()
    const sendPlayerAttack = vi.fn()
    const currentPosition = { x: 1, y: 0, z: 2 }

    const result = beginAttack({
      monsterId: 'm1',
      monsterInfo: { state: 'idle' },
      currentPosition,
      playerRotation: 0.5,
      previousPlayerState: playerState,
      lastSentPosition: null,
      beginCombat,
      sendPlayerMove,
      sendPlayerAttack,
    })

    expect(beginCombat).toHaveBeenCalledWith('m1', true)
    expect(sendPlayerMove).toHaveBeenCalledWith(currentPosition, 0.5)
    expect(sendPlayerAttack).toHaveBeenCalledWith('m1')
    expect(result).toEqual({
      kind: 'started',
      nextPlayerState: { ...playerState, state: 'attack' },
      pendingPickupAfterMoveInstanceId: null,
    })
  })

  it('skips position sync when the last sent x/z position matches', () => {
    const sendPlayerMove = vi.fn()
    const currentPosition = { x: 1, y: 10, z: 2 }

    beginAttack({
      monsterId: 'm1',
      monsterInfo: { state: 'idle' },
      currentPosition,
      playerRotation: 0.5,
      previousPlayerState: playerState,
      lastSentPosition: { x: 1, y: 0, z: 2 },
      beginCombat: vi.fn(),
      sendPlayerMove,
      sendPlayerAttack: vi.fn(),
    })

    expect(sendPlayerMove).not.toHaveBeenCalled()
  })
})

describe('resetAttackInRangeRuntime', () => {
  it('clears movement runtime after an in-range attack event', () => {
    expect(resetAttackInRangeRuntime()).toEqual({
      isMoving: false,
      movementTarget: null,
      movementState: null,
      pathWaypoints: [],
      currentWaypointIndex: 0,
    })
  })
})

describe('transitionAttackToIdle', () => {
  it('ignores non-attack states', () => {
    expect(transitionAttackToIdle(playerState)).toEqual({
      kind: 'ignored',
    })
  })

  it('builds idle state after attack', () => {
    const attackState: PlayerState = {
      ...playerState,
      state: 'attack',
      attackCounter: 2,
    }

    expect(transitionAttackToIdle(attackState)).toEqual({
      kind: 'idle',
      nextPlayerState: {
        ...attackState,
        state: 'idle',
        speed: 0,
        attackCounter: 0,
      },
    })
  })
})

describe('ensureAttackState', () => {
  it('ignores already attacking states', () => {
    expect(ensureAttackState({ ...playerState, state: 'attack' }, 1)).toEqual({
      kind: 'ignored',
    })
  })

  it('builds attack state when not already attacking', () => {
    expect(ensureAttackState(playerState, 1.25)).toEqual({
      kind: 'attack',
      nextPlayerState: {
        ...playerState,
        state: 'attack',
        rotation: 1.25,
      },
    })
  })
})
