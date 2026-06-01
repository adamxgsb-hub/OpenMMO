import { describe, expect, it, vi } from 'vitest'
import { CombatController } from './combatController'

vi.mock('./bgmManager', () => ({
  startBattleMusic: vi.fn(),
  stopBattleMusic: vi.fn(),
}))

describe('CombatController', () => {
  it('does not start a new attack cycle after the target flees out of range during the current attack', () => {
    const controller = new CombatController()
    controller.beginCombat('m1', true)

    const result = controller.update(
      1500,
      { x: 0, y: 0, z: 0 },
      { state: 'run' },
      { x: 3.5, y: 0, z: 0 },
      false,
      1500,
      'attack'
    )

    expect(result).toEqual({ action: 'idle' })
    expect(controller.isInCombat).toBe(false)
  })

  it('starts the next attack cycle when the target is still in range', () => {
    const controller = new CombatController()
    controller.beginCombat('m1', true)

    const result = controller.update(
      1500,
      { x: 0, y: 0, z: 0 },
      { state: 'idle' },
      { x: 1.5, y: 0, z: 0 },
      false,
      1500,
      'attack'
    )

    expect(result).toEqual({
      action: 'attack_cycle',
      monsterId: 'm1',
      rotation: Math.PI / 2,
    })
  })
})
