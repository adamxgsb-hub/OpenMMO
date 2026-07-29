import type { Position } from '../../utils/movementUtils'
import type { ClickIntent } from '../../managers/inputHandler'
import type { WallDirection } from '../../utils/house-geometry'
import {
  PLAYER_ATTACK_RANGE_METERS,
  PLAYER_PICKUP_RANGE_METERS,
} from '../../data/combatTiming'

/** Boarding reach, meters — mirrors the shared `boats::BOARD_RADIUS_M` (the
 *  server revalidates every boarding, so this only decides board-vs-walk). */
const BOAT_BOARD_RADIUS_M = 3

type InteractIntent = Extract<ClickIntent, { type: 'interact_object' }>
type PickupIntent = Extract<ClickIntent, { type: 'pickup_ground_item' }>
type NpcIntent = Extract<ClickIntent, { type: 'interact_npc' }>
type BreakPropIntent = Extract<ClickIntent, { type: 'break_prop' }>
type OpenPropIntent = Extract<ClickIntent, { type: 'open_prop' }>
type CastFishingIntent = Extract<ClickIntent, { type: 'cast_fishing' }>
type BoardBoatIntent = Extract<ClickIntent, { type: 'board_boat' }>
type SailToIntent = Extract<ClickIntent, { type: 'sail_to' }>

export interface CanvasClickActions {
  /** Player is at melee range — start the attack swing immediately. */
  attackInRange(monsterId: string): void
  /** Out of range — chase the monster, attacking on arrival. */
  chaseAndAttack(monsterId: string, hitPoint: Position): void
  toggleDoor(
    houseId: string,
    roomIndex: number,
    wallDir: WallDirection,
    segmentIndex: number
  ): void
  /** Open/close a dungeon door (entrance at depth 0, or an interior room door)
   *  via the server, so the swing syncs to other players. */
  toggleDungeonDoor(depth: number, doorId: number): void
  enterInteraction(intent: InteractIntent): void
  enterPickup(intent: PickupIntent): void
  approachAndPickup(intent: PickupIntent): void
  interactNpc(intent: NpcIntent): void
  /** Walk up to a clicked barrel/crate, breaking it on arrival. */
  breakProp(intent: BreakPropIntent): void
  /** Walk up to a clicked chest, opening it (lid animation) on arrival. */
  openProp(intent: OpenPropIntent): void
  moveToGround(position: Position): void
  /** Stop, face the water, and cast the equipped rod (server validates). */
  castFishing(intent: CastFishingIntent): void
  /** In reach of a clicked hull — climb aboard (server validates seats). */
  boardBoat(intent: BoardBoatIntent): void
  /** Pilot charted a course: the server samples and follows the water. */
  sailTo(intent: SailToIntent): void
  /** Step ashore near the hull (server probes for a dry landing). */
  leaveBoat(): void
}

export function dispatchCanvasClickIntent(
  intent: ClickIntent,
  isMapEditorMode: boolean,
  actions: CanvasClickActions
): void {
  if (isMapEditorMode && intent.type !== 'move_to_ground') return

  switch (intent.type) {
    case 'attack_monster':
      if (intent.distance < PLAYER_ATTACK_RANGE_METERS) {
        actions.attackInRange(intent.monsterId)
      } else {
        actions.chaseAndAttack(intent.monsterId, intent.hitPoint)
      }
      return
    case 'toggle_door':
      actions.toggleDoor(
        intent.houseId,
        intent.roomIndex,
        intent.wallDir,
        intent.segmentIndex
      )
      return
    case 'toggle_dungeon_door':
      actions.toggleDungeonDoor(intent.depth, intent.doorId)
      return
    case 'interact_object':
      actions.enterInteraction(intent)
      return
    case 'pickup_ground_item':
      if (intent.distance <= PLAYER_PICKUP_RANGE_METERS) {
        actions.enterPickup(intent)
      } else {
        actions.approachAndPickup(intent)
      }
      return
    case 'interact_npc':
      actions.interactNpc(intent)
      return
    case 'break_prop':
      actions.breakProp(intent)
      return
    case 'open_prop':
      actions.openProp(intent)
      return
    case 'move_to_ground':
      actions.moveToGround(intent.position)
      return
    case 'cast_fishing':
      actions.castFishing(intent)
      return
    case 'board_boat':
      if (intent.distance <= BOAT_BOARD_RADIUS_M) {
        actions.boardBoat(intent)
      } else {
        // Too far to climb aboard: walk toward the hull; click it again in
        // reach (no auto-board on arrival in this slice).
        actions.moveToGround(intent.position)
      }
      return
    case 'sail_to':
      actions.sailTo(intent)
      return
    case 'leave_boat':
      actions.leaveBoat()
      return
    case 'none':
      return
    default: {
      const _exhaustive: never = intent
      return _exhaustive
    }
  }
}
