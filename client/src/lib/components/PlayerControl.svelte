<script lang="ts">
  import { onMount } from 'svelte'
  import { useThrelte } from '@threlte/core'
  import * as THREE from 'three'
  import { gameStore, hoveredSignpost, type LocalPlayer } from '../stores/gameStore'
  import { networkManager } from '../network/socket'
  import { monsterManager } from '../managers/monsterManager'
  import { groundItemManager } from '../managers/groundItemManager'
  import { combatController } from '../managers/combatController'
  import { preloadSwordHitSound, preloadSwordMissSound } from '../managers/sfxManager'
  import { inputHandler, type ClickIntent } from '../managers/inputHandler'
  import { mapEditorMode, housingEditorMode, debugSpeedMode, torchLightEnabled } from '../stores/debugStore'
  import { localTorchEquipped } from '../stores/inventoryStore'
  import {
    DEFAULT_MOVEMENT_CONFIG,
    type Position,
    type MovementState,
    type MovementConfig,
    type PlayerState,
  } from '../utils/movementUtils'
  import type { TerrainHeightManager } from '../managers/terrainHeightManager'
  import { playerFloorOffset, playerFloorLevel } from '../stores/housingStore'
  import { housingManager } from '../managers/housingManager'
  import { findPath } from '../managers/pathfinding'
  import { passability_get_floor_at } from '../wasm/onlinerpg_shared'
  import { get } from 'svelte/store'
  import { createPlayerPhysics } from './player-control/player-physics'
  import { subscribePlayerNetworkEvents } from './player-control/player-network-events'
  import type {
    PlayerControlEvent,
    PlayerControlUpdateOptions,
  } from './player-control/events'
  import {
    projectPlayerState,
    shouldEmitProjectedPlayerState,
  } from './player-control/fsm/projection'
  import {
    runMoveRequest,
    applyStartedClickMovement,
    type MoveRequestActions,
  } from './player-control/fsm/move-request'
  import { runKeyboardFrame } from './player-control/fsm/keyboard'
  import {
    dispatchPlayerControlEvent as dispatchQueuedPlayerControlEvent,
    createCanvasIntentEvent,
    type PlayerControlEventActions,
  } from './player-control/fsm/events'
  import { runPlayerMovementTick } from './player-control/fsm/movement-tick'
  import {
    beginJumpFeedback,
    shouldFinishJumpFeedback,
    resetMovementRuntimeState,
    transitionToDeadState,
    transitionToRespawnedState,
    type ControlRuntimeState,
  } from './player-control/fsm/lifecycle'
  import {
    exitPickupInteraction as buildExitPickupInteraction,
    finishPendingPickup as finishPendingPickupInteraction,
    handlePickupGrab,
    shouldFinishPendingPickup,
    decidePickupApproach,
    applyObjectInteractionPosition,
    getObjectInteractionExitPosition,
    beginPickupInteraction,
    beginObjectInteraction,
    exitObjectInteraction as buildExitObjectInteraction,
    handleInteractKey,
    getInteractionExitKind,
  } from './player-control/fsm/interaction'
  import {
    createAttackRuntimePatch,
    createControlRuntimePatch,
    createObjectInteractionRuntimePatch,
    createPickupInteractionRuntimePatch,
    createStartedMovementRuntimePatch,
    type PlayerControlRuntimePatch,
  } from './player-control/fsm/runtime-patch'
  import {
    beginAttack,
    ensureAttackState,
    resetAttackInRangeRuntime,
    transitionAttackToIdle,
  } from './player-control/fsm/combat'
  import type { PlayerControlStateName } from './player-control/fsm/control-state'
  import { createLocalPlayerControlMachine } from './player-control/fsm/state-definitions'

  interface Props {
    onStateChange: (state: PlayerState) => void
    camera: THREE.Camera
    heightManager: TerrainHeightManager
    groundMeshes: THREE.Object3D[]
    groundItemMeshes: THREE.Object3D[]
    monsterMeshes: THREE.Group[]
    doorMeshes: THREE.Object3D[]
    objectMeshes: THREE.Object3D[]
    attackCooldown?: number
  }

  let { onStateChange, camera, heightManager, groundMeshes, groundItemMeshes, monsterMeshes, doorMeshes, objectMeshes, attackCooldown }: Props = $props()

  let floorOffset = 0
  playerFloorOffset.subscribe((v) => (floorOffset = v))

  let currentPlayer = $state<LocalPlayer | null>(null)

  const { renderer } = useThrelte()

  const physics = createPlayerPhysics({
    getHeightManager: () => heightManager,
    getCurrentPlayerY: () => currentPlayer?.position.y ?? null,
    getFloorOffset: () => floorOffset,
  })
  const { sampleHeight, isMovementBlocked, isUphillTooSteep } = physics

  // Movement system
  let movementTarget = $state<Position | null>(null)
  let isMoving = $state(false)
  let movementState = $state<MovementState | null>(null)
  let lastSentPosition = $state<Position | null>(null)

  // A* pathfinding waypoints
  let pathWaypoints: Array<{ x: number; z: number; floor: number }> = []
  let currentWaypointIndex = 0

  // Use the same movement config as remote players, with debug speed multiplier
  let MOVEMENT_CONFIG = $derived<MovementConfig>({
    ...DEFAULT_MOVEMENT_CONFIG,
    maxSpeed: DEFAULT_MOVEMENT_CONFIG.maxSpeed * ($debugSpeedMode ? 10 : 1),
    acceleration: DEFAULT_MOVEMENT_CONFIG.acceleration * ($debugSpeedMode ? 10 : 1),
    deceleration: DEFAULT_MOVEMENT_CONFIG.deceleration * ($debugSpeedMode ? 10 : 1),
  })

  // Character rotation and current speed
  let playerRotation = $state(0)
  let currentSpeed = $state(0)

  const STAND_UP_DURATION = 300 // ms, matches animation crossfade duration
  let standUpTimer: ReturnType<typeof setTimeout> | null = null

  const JUMP_FEEDBACK_DURATION_MS = 1500
  const JUMP_FEEDBACK_COOLDOWN_MS = 1000
  let jumpFeedbackTimer: ReturnType<typeof setTimeout> | null = null
  let lastJumpFeedbackAt = 0

  function clearJumpFeedbackTimer() {
    if (!jumpFeedbackTimer) return
    clearTimeout(jumpFeedbackTimer)
    jumpFeedbackTimer = null
  }

  function enqueuePlayerControlEvent(event: PlayerControlEvent) {
    playerControlMachine.enqueueEvent(event)
  }

  /**
   * Briefly switch the player to the 'jump' state to play the jump animation
   * as a one-shot feedback that the terrain ahead is too steep. Cooldown
   * prevents the animation from restarting every frame while the user keeps
   * pushing into the slope.
   */
  function triggerJumpFeedback() {
    const transition = beginJumpFeedback({
      previousPlayerState: playerState,
      now: Date.now(),
      lastJumpFeedbackAt,
      cooldownMs: JUMP_FEEDBACK_COOLDOWN_MS,
    })
    lastJumpFeedbackAt = transition.runtime.lastJumpFeedbackAt
    if (transition.kind === 'cooldown') return

    setPlayerState(transition.nextPlayerState)
    transitionTo('jump_feedback')

    clearJumpFeedbackTimer()
    jumpFeedbackTimer = setTimeout(() => {
      jumpFeedbackTimer = null
      if (shouldFinishJumpFeedback(playerState)) {
        updatePlayerState()
        transitionTo('idle')
      }
    }, JUMP_FEEDBACK_DURATION_MS)
  }

  let pendingPickupInstanceId = $state<number | null>(null)
  let pendingPickupAfterMoveInstanceId = $state<number | null>(null)

  function finishPendingPickup() {
    pendingPickupInstanceId = finishPendingPickupInteraction(
      pendingPickupInstanceId,
      (id) => groundItemManager.finishPickup(id)
    )
  }

  function exitPickupInteraction() {
    const transition = buildExitPickupInteraction(playerState)
    if (transition.kind === 'ignored') return

    finishPendingPickup()
    setPlayerState(transition.nextPlayerState)
    transitionTo('idle')
  }

  function onInteractionFinished() {
    exitPickupInteraction()
  }

  function onPickupGrab() {
    handlePickupGrab(pendingPickupInstanceId, {
      setInHand: (id) => groundItemManager.setInHand(id),
      remove: (id) => groundItemManager.remove(id),
      sendPickupItem: (id) => networkManager.sendPickupItem(id),
    })
  }

  $effect(() => {
    if (shouldFinishPendingPickup(pendingPickupInstanceId, playerState)) {
      finishPendingPickup()
    }
  })

  function exitObjectInteraction(notify = true) {
    if (currentPlayer) {
      applyObjectInteractionPosition(
        currentPlayer,
        getObjectInteractionExitPosition(
          {
            x: currentPlayer.position.x,
            y: currentPlayer.position.y,
            z: currentPlayer.position.z,
          },
          playerRotation
        ),
        {
          hasHeightData: (x, z) => heightManager.hasHeightData(x, z),
          sampleHeight,
        }
      )
    }

    setPlayerState(buildExitObjectInteraction(playerState))
    transitionTo('idle')

    if (notify) {
      networkManager.sendStopInteraction()
    }
  }

  function applyRuntimePatch(patch: PlayerControlRuntimePatch) {
    if (patch.isMoving !== undefined) isMoving = patch.isMoving
    if (patch.movementTarget !== undefined) movementTarget = patch.movementTarget
    if (patch.movementState !== undefined) movementState = patch.movementState
    if (patch.currentSpeed !== undefined) currentSpeed = patch.currentSpeed
    if (patch.pathWaypoints !== undefined) pathWaypoints = patch.pathWaypoints
    if (patch.currentWaypointIndex !== undefined) {
      currentWaypointIndex = patch.currentWaypointIndex
    }
    if (patch.pendingPickupAfterMoveInstanceId !== undefined) {
      pendingPickupAfterMoveInstanceId =
        patch.pendingPickupAfterMoveInstanceId
    }
    if (patch.pendingPickupInstanceId !== undefined) {
      pendingPickupInstanceId = patch.pendingPickupInstanceId
    }
    if (patch.playerRotation !== undefined) playerRotation = patch.playerRotation
  }

  function applyRuntimeState(runtime: ControlRuntimeState) {
    applyRuntimePatch(createControlRuntimePatch(runtime))
  }

  function stopMovement() {
    applyRuntimeState(resetMovementRuntimeState())
    if (standUpTimer) {
      clearTimeout(standUpTimer)
      standUpTimer = null
    }
    updatePlayerState()
  }

  // Explicitly drive the machine's owned state. The machine no longer derives
  // its state name from flags — callers transition at the real decision points.
  function transitionTo(name: PlayerControlStateName) {
    playerControlMachine.transition(name)
  }

  // Stop movement and settle into idle (blocked path, keyboard release-to-idle).
  // Distinct from the bare stopMovement() used by arrive(), which then routes to
  // pickup/attack/idle itself.
  function stopMovementToIdle() {
    stopMovement()
    transitionTo('idle')
  }

  // Wrapper for sending move packets to track last sent position
  function sendPlayerMove(position: Position, rotation: number) {
    lastSentPosition = { ...position }
    networkManager.sendPlayerMove(position, rotation, Math.max(0, get(playerFloorLevel)))
  }

  function writePlayerPosition(position: Position, rotation: number) {
    gameStore.update((state) => {
      if (state.currentPlayer) {
        state.currentPlayer.position.set(position.x, position.y, position.z)
        state.currentPlayer.rotation = rotation
      }
      return state
    })
  }

  // Current player state
  let playerState = $state<PlayerState>({
    state: 'idle',
    speed: 0,
    rotation: 0,
    position: { x: 0, y: 0, z: 0 },
  })

  function setPlayerState(next: PlayerState) {
    playerState = next
    onStateChange(next)
  }

  gameStore.subscribe((state) => {
    currentPlayer = state.currentPlayer
    if (currentPlayer) {
      playerState.position = {
        x: currentPlayer.position.x,
        y: currentPlayer.position.y,
        z: currentPlayer.position.z,
      }
    }
  })

  // Update player state and notify parent
  function updatePlayerState(totalDistance?: number) {
    const currentPosition = currentPlayer
      ? {
          x: currentPlayer.position.x,
          y: currentPlayer.position.y,
          z: currentPlayer.position.z,
        }
      : playerState.position

    const newState = projectPlayerState({
      currentPosition,
      isMoving,
      currentSpeed,
      playerRotation,
      totalDistance,
      hasTorch: $localTorchEquipped || $torchLightEnabled,
      isInCombat: combatController.isInCombat,
      attackCounter: combatController.attackCounter,
    })

    // Only update if state actually changed
    if (shouldEmitProjectedPlayerState(playerState, newState)) {
      playerState = newState
      onStateChange(newState)
    }
  }

  // Initiate attack on a monster
  function initiateAttack(monsterId: string) {
    if (getInteractionExitKind(playerState) === 'pickup') {
      finishPendingPickup()
    }

    const monsterInfo = monsterManager.monsters.get(monsterId)
    const result = beginAttack({
      monsterId,
      monsterInfo,
      currentPosition: currentPlayer
        ? {
            x: currentPlayer.position.x,
            y: currentPlayer.position.y,
            z: currentPlayer.position.z,
          }
        : null,
      playerRotation,
      previousPlayerState: playerState,
      lastSentPosition,
      beginCombat: (id, inRange) => combatController.beginCombat(id, inRange),
      sendPlayerMove,
      sendPlayerAttack: (id) => networkManager.sendPlayerAttack(id),
    })

    if (result.kind === 'ignored_dead_target') return

    applyRuntimePatch(createAttackRuntimePatch(result))
    setPlayerState(result.nextPlayerState)
    transitionTo('attacking')
  }

  // Transition from attack to idle state
  function transitionToIdle() {
    const transition = transitionAttackToIdle(playerState)
    if (transition.kind === 'ignored') return
    setPlayerState(transition.nextPlayerState)
    transitionTo('idle')
  }

  function transitionToDead() {
    const transition = transitionToDeadState(playerState)
    if (transition.kind === 'ignored_already_dead') return

    applyRuntimeState(transition.runtime)
    combatController.cancelCombat()
    finishPendingPickup()

    setPlayerState(transition.nextPlayerState)
    transitionTo('dead')
  }

  function transitionToRespawned() {
    if (!currentPlayer) return

    const transition = transitionToRespawnedState(playerState, {
      x: currentPlayer.position.x,
      y: currentPlayer.position.y,
      z: currentPlayer.position.z,
    })
    applyRuntimeState(transition.runtime)
    combatController.cancelCombat()
    playerRotation = transition.runtime.playerRotation
    finishPendingPickup()

    setPlayerState(transition.nextPlayerState)
    transitionTo('idle')
  }

  /** Check E key interaction (door toggle). Call from game loop. */
  function checkInteraction() {
    handleInteractKey({
      currentPlayer,
      consumeInteract: () => inputHandler.consumeInteract(),
      findNearestDoor: (x, z, y, range) =>
        housingManager.findNearestDoor(x, z, y, range),
      sendToggleDoor: (houseId, roomIndex, wallDir, segmentIndex) =>
        networkManager.sendToggleDoor(houseId, roomIndex, wallDir, segmentIndex),
    })
  }

  // Stable action bags reused every frame by the movement/keyboard ticks.
  // They only read live `$state` inside their closures, so building them once
  // avoids reallocating ~20 closures per frame on the render hot path.
  const combatTickActions = {
    stopMovingToIdle: () => {
      if (isMoving) {
        isMoving = false
        movementTarget = null
        movementState = null
        updatePlayerState()
      }
      transitionToIdle()
    },
    prepareReachedAttackRange: () => {
      isMoving = false
      movementTarget = null
      movementState = null
      currentSpeed = 0
      updatePlayerState()
    },
    beginAttack: initiateAttack,
    setChasingMovement: (
      nextMovementTarget: Position,
      nextMovementState: MovementState,
      nextRotation: number
    ) => {
      movementTarget = nextMovementTarget
      movementState = nextMovementState
      playerRotation = nextRotation
      isMoving = true
      // Chase reports as 'moving' (playerState stays 'moving' while pathing to
      // the monster); the 'attacking' name is reserved for in-range swinging.
      transitionTo('moving')
    },
    showAttackState: (nextRotation: number) => {
      playerRotation = nextRotation
      const transition = ensureAttackState(playerState, nextRotation)
      if (transition.kind === 'ignored') return
      setPlayerState(transition.nextPlayerState)
      transitionTo('attacking')
    },
    sendAttackCycle: (monsterId: string, nextRotation: number) => {
      playerRotation = nextRotation
      networkManager.sendPlayerAttack(monsterId)
      updatePlayerState()
      transitionTo('attacking')
    },
  }

  const movementTickActions = {
    stopMovement: stopMovementToIdle,
    triggerJumpFeedback,
    setNextWaypoint: (
      nextCurrentSpeed: number,
      nextPlayerRotation: number,
      nextMovementTarget: Position,
      nextMovementState: MovementState,
      nextWaypointIndex: number
    ) => {
      currentSpeed = nextCurrentSpeed
      playerRotation = nextPlayerRotation
      movementTarget = nextMovementTarget
      movementState = nextMovementState
      currentWaypointIndex = nextWaypointIndex
    },
    arrive: (nextCurrentSpeed: number, nextPlayerRotation: number) => {
      currentSpeed = nextCurrentSpeed
      playerRotation = nextPlayerRotation
      const pickupAfterArrival = pendingPickupAfterMoveInstanceId
      // Bare stopMovement() here (not stopMovementToIdle): arrive routes to
      // pickup/attack/idle itself below.
      stopMovement()

      if (pickupAfterArrival !== null) {
        enterPickup(pickupAfterArrival)
        return
      }

      if (combatController.isInCombat) {
        initiateAttack(combatController.targetMonsterId!)
        return
      }

      transitionTo('idle')
    },
    continueMovement: (
      nextCurrentSpeed: number,
      nextPlayerRotation: number,
      totalDistance: number
    ) => {
      currentSpeed = nextCurrentSpeed
      playerRotation = nextPlayerRotation
      updatePlayerState(totalDistance)
    },
  }

  const keyboardFrameActions = {
    exitPickupInteraction,
    exitObjectInteraction,
    clearClickMovement: () => {
      movementTarget = null
      movementState = null
      pendingPickupAfterMoveInstanceId = null
    },
    cancelCombat: () => combatController.cancelCombat(),
    markMoving: () => {
      isMoving = true
      transitionTo('keyboard_moving')
    },
    setKeyboardIdleRuntime: () => {
      isMoving = false
      currentSpeed = 0
      transitionTo('idle')
    },
    emitKeyboardPlayerState: () => {
      updatePlayerState(isMoving ? 100 : undefined)
    },
    stopMovement: stopMovementToIdle,
    triggerJumpFeedback,
    setMoved: (nextCurrentSpeed: number, nextPlayerRotation: number) => {
      currentSpeed = nextCurrentSpeed
      playerRotation = nextPlayerRotation
    },
  }

  // Update player movement (click-to-move) with acceleration/deceleration
  function updatePlayerMovement(deltaTime: number) {
    runPlayerMovementTick({
      deltaTime,
      currentPlayer,
      playerStateName: playerState.state,
      isMoving,
      currentSpeed,
      movementTarget,
      movementState,
      pathWaypoints,
      currentWaypointIndex,
      config: MOVEMENT_CONFIG,
      isInCombat: combatController.isInCombat,
      combatController,
      cooldownMs: attackCooldown ? attackCooldown * 1000 : 1500,
      getMonsterInfo: (monsterId) => {
        const monsterData = monsterManager.monsters.get(monsterId)
        return monsterData
          ? {
              state: monsterData.state,
              isDeadPending: monsterData.isDeadPending,
            }
          : undefined
      },
      findMonsterPosition: (monsterId) =>
        monsterManager.findMeshPosition(monsterId, monsterMeshes),
      sampleHeight,
      hasHeightData: (x, z) => heightManager.hasHeightData(x, z),
      isMovementBlocked,
      isUphillTooSteep,
      getFloorLevel: () => get(playerFloorLevel),
      setFloorLevel: (floor) => playerFloorLevel.set(floor),
      writePlayerPosition,
      sendPlayerMove,
      actions: {
        transitionToDead,
        resetStoppedSpeed: () => {
          currentSpeed = 0
          updatePlayerState()
        },
        combat: combatTickActions,
        movement: movementTickActions,
      },
    })
  }

  function updateKeyboardMovement() {
    runKeyboardFrame({
      currentPlayer,
      hasKeysPressed: inputHandler.hasKeysPressed,
      interactionExit: getInteractionExitKind(playerState),
      hasMovementTarget: movementTarget !== null,
      isInCombat: combatController.isInCombat,
      direction: inputHandler.getMovementDirection(),
      config: MOVEMENT_CONFIG,
      sampleHeight,
      isMovementBlocked,
      isUphillTooSteep,
      writePlayerPosition,
      sendPlayerMove,
      actions: keyboardFrameActions,
    })
  }

  function createMoveRequestActions(
    clickPosition: Position,
    pickupAfterArrival: number | null,
    options: { pickupAfterArrival?: number | null }
  ): MoveRequestActions {
    return {
      clearPendingPickupAfterMove: () => {
        pendingPickupAfterMoveInstanceId = null
      },
      exitPickupAndRetry: () => {
        exitPickupInteraction()
        handleClickToMove(clickPosition, options)
      },
      exitObjectAndDelay: () => {
        exitObjectInteraction()

        if (standUpTimer) clearTimeout(standUpTimer)
        standUpTimer = setTimeout(() => {
          standUpTimer = null
          enqueuePlayerControlEvent({
            type: 'delayed_request_move',
            position: { ...clickPosition },
            pickupAfterArrival,
          })
        }, STAND_UP_DURATION)
      },
      applyStartedMovement: (started) => {
        const runtime = applyStartedClickMovement(started)
        const patch = createStartedMovementRuntimePatch(runtime)
        applyRuntimePatch(patch)
        updatePlayerState(patch.totalDistance)
        transitionTo('moving')
      },
    }
  }

  function handleClickToMove(
    clickPosition: Position,
    options: { pickupAfterArrival?: number | null } = {}
  ) {
    const pickupAfterArrival = options.pickupAfterArrival ?? null

    runMoveRequest({
      clickPosition,
      pickupAfterArrival,
      currentPlayer,
      interactionExit: getInteractionExitKind(playerState),
      isMoving,
      hasKeyboardInput: inputHandler.hasKeysPressed,
      currentFloor: Math.max(0, get(playerFloorLevel)),
      getFloorAt: passability_get_floor_at,
      findPath,
      sampleHeight,
      sendPlayerMove,
      actions: createMoveRequestActions(
        clickPosition,
        pickupAfterArrival,
        options
      ),
    })
  }

  function enterInteraction(intent: Extract<ClickIntent, { type: 'interact_object' }>) {
    if (getInteractionExitKind(playerState) === 'pickup') {
      finishPendingPickup()
    }

    const result = beginObjectInteraction({
      intent,
      previousPlayerState: playerState,
      cancelCombat: () => combatController.cancelCombat(),
    })

    applyRuntimePatch(createObjectInteractionRuntimePatch(result))
    setPlayerState(result.nextPlayerState)
    transitionTo('object_interacting')

    if (currentPlayer) {
      applyObjectInteractionPosition(currentPlayer, result.entryPosition, {
        hasHeightData: (x, z) => heightManager.hasHeightData(x, z),
        sampleHeight,
      })
    }

    networkManager.sendInteractObject(intent.objectType, intent.objectId)
  }

  function enterPickup(instanceId: number) {
    const result = beginPickupInteraction({
      instanceId,
      previousPlayerState: playerState,
      hasGroundItem: (id) => groundItemManager.items.has(id),
      beginPickup: (id) => groundItemManager.beginPickup(id),
      cancelCombat: () => combatController.cancelCombat(),
    })

    if (result.kind === 'ignored') return

    applyRuntimePatch(createPickupInteractionRuntimePatch(result))
    setPlayerState(result.nextPlayerState)
    transitionTo('picking_up')
  }

  function approachAndPickup(intent: Extract<ClickIntent, { type: 'pickup_ground_item' }>) {
    const decision = decidePickupApproach({
      playerState,
      intent,
      getGroundItem: (instanceId) => groundItemManager.items.get(instanceId),
    })
    if (decision.kind === 'ignored_dead') return

    combatController.cancelCombat()
    handleClickToMove(decision.target, {
      pickupAfterArrival: decision.pickupAfterArrival,
    })
  }

  function handleCanvasClickIntent(event: MouseEvent) {
    const editorMode = $mapEditorMode || $housingEditorMode
    const playerControlEvent = createCanvasIntentEvent({
      event,
      editorMode,
      currentPlayer,
      processIntent: () =>
        inputHandler.processCanvasClick(event, {
          camera,
          monsterMeshes,
          doorMeshes,
          objectMeshes,
          groundItemMeshes,
          groundMeshes,
          playerPosition: {
            x: currentPlayer!.position.x,
            y: currentPlayer!.position.y,
            z: currentPlayer!.position.z,
          },
          playerFloorLevel: get(playerFloorLevel),
          isMonsterDead: (id) => {
            const m = monsterManager.monsters.get(id)
            return m?.state === 'dead' || false
          },
        }),
    })
    if (!playerControlEvent) return

    enqueuePlayerControlEvent(playerControlEvent)
  }

  function createPlayerControlEventActions(): PlayerControlEventActions {
    return {
      attackInRange: (monsterId) => {
        initiateAttack(monsterId)
        const runtime = resetAttackInRangeRuntime()
        applyRuntimePatch(runtime)
      },
      chaseAndAttack: (monsterId, hitPoint) => {
        combatController.beginCombat(monsterId, false)
        handleClickToMove(hitPoint)
      },
      toggleDoor: (houseId, roomIndex, wallDir, segmentIndex) => {
        pendingPickupAfterMoveInstanceId = null
        networkManager.sendToggleDoor(houseId, roomIndex, wallDir, segmentIndex)
      },
      enterInteraction,
      enterPickup,
      approachAndPickup,
      moveToGround: (position) => {
        combatController.cancelCombat()
        handleClickToMove(position)
      },
      requestMove: handleClickToMove,
      onInteractionFinished,
      onPickupGrab,
      onRespawned: transitionToRespawned,
      onInteractionRejected: () => {
        if (playerState.state === 'interact') exitObjectInteraction(false)
      },
    }
  }

  function dispatchPlayerControlEvent(event: PlayerControlEvent) {
    dispatchQueuedPlayerControlEvent(event, createPlayerControlEventActions())
  }

  const playerControlMachine = createLocalPlayerControlMachine({
    dispatchEvent: dispatchPlayerControlEvent,
    stateActions: {
      onInteractionFinished,
      onPickupGrab,
      clearJumpFeedbackTimer,
      onRespawned: transitionToRespawned,
      onInteractionRejected: () => {
        if (playerState.state === 'interact') exitObjectInteraction(false)
      },
      handleInteractKey: checkInteraction,
      handleKeyboard: updateKeyboardMovement,
      tick: updatePlayerMovement,
    },
  })

  export function updatePlayerControl(
    deltaTime: number,
    options: PlayerControlUpdateOptions
  ) {
    playerControlMachine.update(deltaTime, options)
  }

  // Hover speech bubble for placed objects that carry text (e.g. signposts).
  // Driven by pointermove (event-based, not per-frame) and raycast only against
  // the object overlay group, throttled to ~20 Hz — negligible cost.
  let lastHoverRaycast = 0
  let lastHoverKey: string | null = null
  let hoverTrailing: ReturnType<typeof setTimeout> | null = null
  let pendingHoverEvent: MouseEvent | null = null

  function runHover(event: MouseEvent) {
    lastHoverRaycast = performance.now()
    const hit = inputHandler.processHover(event, camera, objectMeshes)
    const key = hit
      ? `${hit.text}@${hit.position.x.toFixed(1)},${hit.position.z.toFixed(1)}`
      : null
    if (key === lastHoverKey) return
    lastHoverKey = key
    hoveredSignpost.set(
      hit
        ? { x: hit.position.x, y: hit.position.y, z: hit.position.z, text: hit.text }
        : null
    )
  }

  function handlePointerHover(event: MouseEvent) {
    pendingHoverEvent = event
    const dt = performance.now() - lastHoverRaycast
    if (dt >= 50) {
      if (hoverTrailing) {
        clearTimeout(hoverTrailing)
        hoverTrailing = null
      }
      runHover(event)
    } else if (!hoverTrailing) {
      // Trailing edge: process the final position after the throttle window so a
      // quick flick off a signpost (then stop, without leaving the canvas)
      // doesn't strand the bubble over empty ground.
      hoverTrailing = setTimeout(() => {
        hoverTrailing = null
        if (pendingHoverEvent) runHover(pendingHoverEvent)
      }, 50 - dt)
    }
  }

  function clearHover() {
    if (hoverTrailing) {
      clearTimeout(hoverTrailing)
      hoverTrailing = null
    }
    if (lastHoverKey === null) return
    lastHoverKey = null
    hoveredSignpost.set(null)
  }

  onMount(() => {
    preloadSwordHitSound()
    preloadSwordMissSound()

    const removeInputListeners = inputHandler.setupEventListeners(
      renderer.domElement,
      handleCanvasClickIntent
    )

    const canvas = renderer.domElement
    canvas.addEventListener('pointermove', handlePointerHover)
    canvas.addEventListener('pointerleave', clearHover)

    const unsubscribeNetworkEvents = subscribePlayerNetworkEvents({
      isCurrentPlayerEligibleForRespawn: () =>
        !!currentPlayer && currentPlayer.health <= 0,
      isCurrentPlayer: (id) => !!currentPlayer && currentPlayer.id === id,
      isInteracting: () => playerState.state === 'interact',
      onRespawned: () => enqueuePlayerControlEvent({ type: 'network_respawned' }),
      onInteractionRejected: () =>
        enqueuePlayerControlEvent({ type: 'network_interaction_rejected' }),
    })

    // Debug observability hook for runtime verification of the control FSM.
    // Read from the browser console / Playwright via `window.__playerFSM`.
    // Dev-only so it never ships in production builds.
    if (import.meta.env.DEV && typeof window !== 'undefined') {
      ;(window as unknown as Record<string, unknown>).__playerFSM = {
        get stateName() {
          return playerControlMachine.stateName
        },
        get playerState() {
          return playerState.state
        },
        get position() {
          return currentPlayer
            ? {
                x: currentPlayer.position.x,
                y: currentPlayer.position.y,
                z: currentPlayer.position.z,
              }
            : null
        },
        get isMoving() {
          return isMoving
        },
        get movementTarget() {
          return movementTarget
        },
        get currentSpeed() {
          return currentSpeed
        },
        get rotation() {
          return playerRotation
        },
        get isInCombat() {
          return combatController.isInCombat
        },
        get pendingPickup() {
          return { instanceId: pendingPickupInstanceId, afterMove: pendingPickupAfterMoveInstanceId }
        },
      }
    }

    return () => {
      removeInputListeners()
      canvas.removeEventListener('pointermove', handlePointerHover)
      canvas.removeEventListener('pointerleave', clearHover)
      clearHover()
      unsubscribeNetworkEvents()
      playerControlMachine.dispose()
      if (standUpTimer) clearTimeout(standUpTimer)
      clearJumpFeedbackTimer()
      if (import.meta.env.DEV && typeof window !== 'undefined') {
        delete (window as unknown as Record<string, unknown>).__playerFSM
      }
    }
  })
</script>
