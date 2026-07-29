import { networkManager } from '../../network/socket'
import type { Position, PositionCorrection } from '../../network/networkTypes'

export interface PlayerNetworkEventActions {
  /** True if the local player exists, is currently dead, and the id matches. */
  isCurrentPlayerEligibleForRespawn: () => boolean
  isCurrentPlayer: (playerId: number) => boolean
  isInteracting: () => boolean
  onRespawned: () => void
  onInteractionRejected: () => void
  onPositionCorrected: (correction: PositionCorrection) => void
  /** The local player took a seat (their own launch or a boarding). */
  onBoardedBoat: (berth: { boatId: number; seat: number }) => void
  /** The local player went ashore at the server-picked landing point. */
  onLeftBoat: (landing: { position: Position }) => void
}

/** Wires up respawn, interaction-rejected and position-correction listeners.
 *  Returns a cleanup. */
export function subscribePlayerNetworkEvents(
  actions: PlayerNetworkEventActions
): () => void {
  let respawnRequested = false

  const unsubscribeRespawnRequested = networkManager.respawnRequested.on(() => {
    if (!actions.isCurrentPlayerEligibleForRespawn() || respawnRequested) return
    respawnRequested = true
  })

  const unsubscribePlayerRespawned = networkManager.playerRespawned.on(
    (playerId) => {
      if (!actions.isCurrentPlayer(playerId)) return
      respawnRequested = false
      actions.onRespawned()
    }
  )

  const unsubscribeInteractionRejected = networkManager.interactionRejected.on(
    () => {
      if (actions.isInteracting()) actions.onInteractionRejected()
    }
  )

  const unsubscribePositionCorrected = networkManager.positionCorrected.on(
    actions.onPositionCorrected
  )

  const unsubscribeBoardedBoat = networkManager.boardedBoat.on(
    actions.onBoardedBoat
  )
  const unsubscribeLeftBoat = networkManager.leftBoat.on(actions.onLeftBoat)

  return () => {
    unsubscribeBoardedBoat()
    unsubscribeLeftBoat()
    unsubscribePositionCorrected()
    unsubscribeRespawnRequested()
    unsubscribePlayerRespawned()
    unsubscribeInteractionRejected()
  }
}
