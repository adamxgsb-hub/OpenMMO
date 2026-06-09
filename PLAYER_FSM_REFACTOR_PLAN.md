# 플레이어 조종 로직 → 명시적 FSM 리팩터링

## Context (왜)

`client/src/lib/components/PlayerControl.svelte`의 로컬 플레이어 제어 로직은 시작 시점에는 FSM이 아니라
**암묵적 상태**다. 실제 거동은 `playerState.state` enum + 흩어진 플래그(`isMoving`, `movementTarget`,
`movementState`, `pathWaypoints`, `currentWaypointIndex`, `pendingPickupAfterMoveInstanceId`,
`pendingPickupInstanceId` …) + 별도 `combatController`의 곱(product)으로 결정되고, 전이 규칙이 한곳에
모이지 않고 `updatePlayerMovement` / `updateKeyboardMovement` / `handleClickToMove` / 콤뱃 `switch` /
네트워크 콜백에 분산되어 있다. "정지 후 전부 리셋"(`isMoving=false; movementTarget=null; …`) 같은 패턴이
6번 넘게 반복되고, 두 가지 emit 경로(always-emit `setPlayerState` vs diff-emit `updatePlayerState`)가
섞여 있어 유지보수/가독성이 나쁘다.

목표: 제어 모드를 **명시적 상태 객체 + 단일 전이 함수**로 재구성해 전이 규칙을 한곳에 모으고, 흩어진
플래그를 각 상태가 소유하게 한다. 애니메이션으로 나가는 `PlayerState` 계약과 게임 루프 진입점은 그대로
보존한다. 사용자 결정: **FSM 전환 + 정리/개선 동시 진행**. 단, 이 머신엔 브라우저 런타임 검증이 불가
(env_no_browser)하므로 — 동작 등가성을 기본으로 하고, 위험한 gameplay-feel 변경은 적용하지 않고 플래그만
남긴다. 안전장치로 FSM을 **프레임워크 비의존(주입식 context)**으로 만들어 **vitest 단위 테스트**로
전이표를 검증한다.

## 구현 현황

- `GameScene.svelte`는 이제 한 프레임에 `playerControl.updatePlayerControl(deltaTime, { editorMode, events })`
  하나만 호출한다. canvas/network/timer 이벤트는 `PlayerControl` 내부 queue에 쌓이고, animation callback은
  `GameScenePlayersLayer.svelte`가 `PlayerControlEvent`로 상향 전달해 다음 frame update에서 FIFO로 소비한다.
- `PlayerControl.svelte`의 public surface는 `updatePlayerControl`만 남겼고, 기존 loop용
  `checkInteraction`/`updateKeyboardMovement`/`updatePlayerMovement`/animation callback 메서드는 내부
  adapter 함수로 내려갔다.
- `client/src/lib/components/player-control/fsm/**`에 projection, movement substrate, keyboard/combat/movement
  frame, transition, runtime patch, state registry/overrides, machine, event dispatcher를 분리했다.
- 현재 구현은 안전한 이식 단계다. 머신은 상태 lifecycle/event queue/상태별 handler를 제공하지만,
  일부 런타임 값은 아직 Svelte adapter의 store/local state를 읽어 관측 상태명으로 동기화한다. 다음 단계에서
  `PlayerControlContext`를 실제 런타임 컨테이너로 더 강하게 연결하면 상태 객체가 플래그를 더 직접 소유하게 된다.

## 이번 단계에서 보존할 외부 계약

- 게임 루프(`GameScene.svelte` ~383-389)가 매 프레임 호출: `checkInteraction()` →
  `updateKeyboardMovement()` → `updatePlayerMovement(dt)` (이 순서 = load-bearing). FSM 이식 후에는
  `GameScene`이 이 순서를 알 필요가 없도록 단일 진입점으로 접는다.
  권장 계약은 `updatePlayerControl(deltaTime, { editorMode })` 또는 `updatePlayerFSM(deltaTime, { editorMode })`.
  TypeScript/Svelte 쪽 기존 스타일을 맞추려면 snake_case `player_fsm_update`보다는 camelCase 이름을 우선한다.
  내부 처리 순서는 기존과 동일하게 `!editorMode`일 때 interact → keyboard를 먼저 처리하고, 마지막에 항상
  movement/combat tick을 실행한다. editor 모드에서는 interact/keyboard만 skip하고 movement/combat tick은 실행한다.
- 리팩터 후 public surface:
  `updatePlayerControl(deltaTime, { editorMode, events? })`.
  기존 게임 루프용 `checkInteraction()`, `updateKeyboardMovement()`, `updatePlayerMovement(dt)`는 새 단일
  진입점으로 대체한다. 필요하면 compatibility wrapper로 잠시 남길 수 있지만 최종 정리에서는 제거한다.
  canvas click, 지연 stand-up 이동, 네트워크 콜백, 애니메이션 콜백(`onInteractionFinished`, `onPickupGrab`)은
  모두 `PlayerControlEvent`로 큐에 쌓고 다음 `updatePlayerControl` 시작 시 순서대로 소비한다.
  animation callback처럼 `PlayerControl.svelte` 밖에서 발생하는 이벤트는 `GameScene`/`GameScenePlayersLayer`가
  queue에 추가하고, 다음 game-loop update에서 `events`로 넘긴다. 임시 compatibility wrapper 외의 별도
  public method는 두지 않는다.
- `onStateChange(PlayerState)` 계약 유지: `{ position, state, speed, rotation, movementMode?,
  attackCounter?, interactionAnim?, interactOffsetY? }`. 소비처 `PlayerModel.svelte`가 이 필드들로
  애니메이션을 고른다.

이 섹션은 "영구적으로 변경 금지"가 아니라, 리팩터링의 blast radius를 관리하기 위한 단계적 경계다.
가독성이나 구조 개선상 외부 계약 변경이 더 낫다고 판단되면, FSM 이식과 같은 PR 안에서라도 호출자
(`GameScene.svelte`, `GameScenePlayersLayer.svelte`, `PlayerModel.svelte`)까지 함께 정리하되, 동작 순서와
애니메이션 계약은 테스트로 고정한다.

## 설계 개요

제어-모드 FSM. 애니메이션용 `PlayerState`는 활성 상태에서 매 프레임 **파생(derive)**한다(상태가 곧 진실).
프레임워크 비의존 모듈로 분리하고 Svelte 컴포넌트는 얇은 어댑터로 남긴다.

**상태 (8개):**
1. `Idle`
2. `Moving(goal)` — `MoveGoal = {kind:'ground'} | {kind:'pickup', instanceId} | {kind:'chase', monsterId}`.
   PathMove + Chase를 **하나로 통합**(둘은 동일 integrator·도착/벽/경사 가드·floor 처리·send 케이던스를
   공유하고, 차이는 goal 출처와 onArrive 액션뿐 — 현재 코드의 `break` fall-through 결합과 일치).
3. `KeyboardMove` — 자유 WASD, 고정 스텝(no accel/decel/waypoint/arrival), 매 프레임 입력 재평가, click-move/combat 선점.
4. `Attack` — 사거리 내, `combatController`가 스윙 사이클 구동. 몬스터 사망/소실 → Idle, 도주 → Moving(chase).
5. `InteractObject` — 오브젝트 위 착석/소셜 애니. 종료 경로별로 stand-up 지연 다름(아래 불변식 참조).
6. `Pickup` — 줍기 애니(35%에 `onPickupGrab` grab, 끝에 `onInteractionFinished` finish).
7. `Dead`
8. `JumpFeedback` — 경사-too-steep 시 transient 점프 애니(~1.5s, 쿨다운 1s) → Idle.

각 `ControlState`: `enter?()`, `exit?()`, `tick(dt) -> next|null`, 이벤트 핸들러(기본 no-op).
애니메이션용 `PlayerState` 파생은 상태 객체별 `toPlayerState()`가 아니라 공통 `projection.ts`에서 처리한다.

**머신/컨텍스트:**
- `PlayerStateMachine`: 현재 상태 보유, `transition(next){ exit → swap → enter }`, dispatch를 현재
  상태 메서드로 fan-out. 게임 루프 단일 진입점은
  `updatePlayerControl(dt, { editorMode, events? }) → dispatch queued events → handleInteractKey? →
  handleKeyboard? → tick(dt)`로 매핑한다.
  `editorMode`가 true이면 interact/key 단계만 건너뛰고 `tick(dt)`는 항상 실행한다.
  이벤트는 `events.ts`의 `PlayerControlEvent` union으로 통합한다:
  `canvas_intent`, `request_move`, `delayed_request_move`, `anim_interaction_finished`,
  `anim_pickup_grab`, `network_respawned`, `network_interaction_rejected`.
- `PlayerControlContext`: 주입 의존성 + 공유 이동 substrate 접근자 + emit 헬퍼.
  deps = `getPlayer()`, `physics{sampleHeight,isMovementBlocked,isUphillTooSteep}`(기존 `player-physics.ts`
  그대로), `config()`, network sends, `combatController`, `inputHandler`, `groundItemManager`,
  `housingManager`, `playerFloorLevel` get/set, `hasTorch()`.
  추가로 전역 import를 피하고 테스트 가능성을 유지하기 위해 아래 의존성을 **반드시 context에 명시 주입**한다:
  `writePlayerPosition(pos, rotation)`(기존 `gameStore.update` 위치 쓰기), `findPath(...)`,
  `getFloorAt(x,z,y)`(`passability_get_floor_at`), `getMonsterCombatSnapshot(monsterId)`,
  `findMonsterMeshPosition(monsterId)`, `getAttackCooldownMs()`, network command 전체
  (`sendPlayerMove`, `sendPlayerAttack`, `sendPickupItem`, `sendInteractObject`, `sendStopInteraction`,
  `sendToggleDoor`).
  emit = `project()`(diff-emit) / `emitTransition()`(always-emit) / `sendMove()`.
  `project()`는 builders에 의존하지 않는 별도 projector로 둔다. `player-state-builders.ts`는
  attack/dead/respawn/interact/pickup/jump 같은 **전이 스냅샷**에만 사용하고, 이동/키보드 프레임의
  `PlayerState` 파생은 `projectPlayerState(controlState, ctx)`가 담당한다.

## 모듈 분해

**그대로 두고 주입만 (절대 흡수 금지):** `combatController.ts`(콤뱃 타이머·attackCounter·1000ms chase
throttle·BGM 소유), `movementUtils.ts`(순수 함수, remote player와 공유), `player-physics.ts`(이미 추출됨),
`canvas-click-dispatcher.ts`(순수 intent→action 라우터 — 7개 콜백을 머신 dispatch로 연결),
`player-network-events.ts`(4개 콜백 → dispatch). **`player-state-builders.ts`는 전이 스냅샷에서만
재사용**한다. 이동 프레임 projection까지 builders로 억지 재사용하지 않는다.

**FSM으로 흡수 (현재 PlayerControl.svelte의 자유함수/플래그):** `isMoving/movementTarget/movementState/
pathWaypoints/currentWaypointIndex/currentSpeed/playerRotation/lastSentPosition/pendingPickup*` →
Moving·KeyboardMove 상태 + 공유 substrate. `stopMovement/updatePlayerState/setPlayerState/sendPlayerMove`
→ context 헬퍼. `initiateAttack/transitionToIdle/transitionToDead/transitionToRespawned/
triggerJumpFeedback/enterInteraction/enterPickup/approachAndPickup/exitObjectInteraction/
exitPickupInteraction/finishPendingPickup` → 상태 `enter()/exit()`/전이.

**새 파일 레이아웃** `client/src/lib/components/player-control/fsm/`:
- `context.ts` — `PlayerControlContext` 타입 + emit 헬퍼(`project`/`emitTransition`/`sendMove`).
- `events.ts` — `PlayerControlEvent` union. canvas click intent, direct move request, delayed move,
  네트워크, 애니메이션 콜백을 모두 같은 이벤트 모델로 표현한다.
- `machine.ts` — `PlayerStateMachine`.
- `projection.ts` — 현재 control state + context에서 애니메이션용 `PlayerState`를 파생. 기존
  `updatePlayerState`의 diff 대상/threshold와 `movementMode`/`attackCounter` 산출을 그대로 보존.
- `movement-substrate.ts` — "movementState 따라 전진 + 벽/경사/도착/floor 처리" 공유 헬퍼(Moving 전용,
  Keyboard는 적분기가 달라 제외).
- `states/idle.ts`, `moving.ts`, `keyboard-move.ts`, `attack.ts`, `interact-object.ts`, `pickup.ts`,
  `dead.ts`, `jump-feedback.ts`.

`PlayerControl.svelte`는 얇은 어댑터로 축소: deps로 context 구성 → machine 생성 → pending event queue 보유 →
게임 루프용 `updatePlayerControl(deltaTime, { editorMode, events? })` 호출 시 내부 queue와 optional events drain →
`onStateChange`는 machine의 emit으로 연결. `GameScene.svelte`는 한 프레임에 이 함수 하나만 호출한다.
`PlayerControl.svelte`에는 canvas click의 editor button/intent 필터를 유지하고, 결과 intent를 즉시 실행하지 않고
`PlayerControlEvent`로 enqueue한다.

## 동작 보존 불변식 (실행 시 반드시 지킬 것 — 회귀 위험 핵심)

1. **두 emit 경로 유지.** 전이(attack/dead/respawn/interact/pickup/jump/idle-after-X)는 **always-emit**.
   이동/키보드/idle 프레임은 **diff-emit**: 기존 7-필드 비교 그대로(`state`, `speed`(>0.01), `rotation`,
   `position.x/z`(>0.01), `movementMode`, `attackCounter`). `interactionAnim`/`interactOffsetY`/
   `position.y`는 diff에 **넣지 않는다**(전이의 always-emit가 담당; y는 매 프레임 변해 spam 유발).
2. **terrain Y 재정렬**(`updatePlayerMovement` 최상단)은 `interact` 상태에서 **skip**(착석 Y 유지). 그 외 상태만 적용.
3. **floor-level 순서**: 중간 waypoint 도착 시 `arrived wp floor 설정 → position write → index++ →
   next wp floor 설정`. `sendMove`는 `playerFloorLevel`을 읽으므로 send 전에 floor가 최신이어야 함.
4. **Moving(chase) 결합**: 콤뱃 update의 `chasing`은 `movementState.targetPos/totalDistance/startPos`를
   **in-place로 덮어쓰고** 같은 integrator로 fall-through. waypoint 재초기화 아님. chase는
   `pathWaypoints` 비어있음 + live 몬스터로 retarget(throttle은 combatController 소유, 미변경).
   구현상 `Moving(goal.kind === 'chase')`의 `tick()`은 매 프레임 **먼저**
   `combatController.update(...)`를 호출해야 한다. 결과가 `chasing`이면 target만 갱신한 뒤 같은 tick에서
   movement substrate를 계속 실행한다. 결과가 `reached_attack_range`/`attacking`/`attack_cycle`/`idle`이면
   substrate로 내려가지 않고 해당 전이/side effect를 처리한다. 이 규칙을 `Attack` 상태에만 두면 원거리
   추격 중 retarget/몬스터 사망/사거리 도달 처리가 깨진다.
5. **lastSentPosition dedup은 `initiateAttack`에서만** 사용. 이동/키보드 send는 매 프레임 무조건 발신
   (단 `sendMove`는 항상 `lastSentPosition`을 갱신). 키보드/패스 send에 dedup 추가 금지.
6. **stand-up 3경로 비대칭 보존**: ① 오브젝트-interact 중 클릭 → `exitObjectInteraction()` 후
   **300ms `standUpTimer`** 뒤 지연 이동. ② 오브젝트-interact 중 키보드 → **즉시** stand-up. ③ Pickup 중
   클릭/키보드 → **즉시** exit 후 진행. pending 타이머는 `exit()`에서 clear.
7. **JumpFeedback**: 쿨다운(1000ms)은 트리거 시점에 모듈-레벨 `lastJumpFeedbackAt`로 체크. 1500ms 타이머는
   "여전히 jump 투영 상태일 때만" Idle로(콤뱃/인터랙션이 선점했으면 no-op).
   timer는 active state가 소유하고, state `exit()`와 `machine.dispose()`에서 반드시 clear한다.
8. **`movementMode` 산출**: path = `movementState.totalDistance`, keyboard = 100(항상 run), 그 외 =
   undefined. `attackCounter`는 `isInCombat`일 때만 `cc.attackCounter`로 채움(현재와 bit-for-bit 동일하게
   재현해 diff flapping 방지). `hasTorch` = `localTorchEquipped || torchLightEnabled` 두 스토어.
9. **editor 모드**: 단일 게임 루프 진입점 `updatePlayerControl(dt, { editorMode, events? })` 안에서
   `editorMode === true`이면 interact/key 단계만 skip하고 movement/combat tick은 실행한다.
   `PlayerControl.svelte`에는 canvas click의 button 선택과 `dispatchCanvasClickIntent` editor 필터도 유지한다
   (`move_to_ground` 외 intent 차단).
10. **respawn**: `playerRespawned`(자기 id)에만 반응, `respawnRequested`는 무시. respawn 시 rotation=0 리셋.
11. **InteractObject의 `onInteractionFinished`는 no-op**(소셜 루프 유지) — pickup만 finish. 보존.
12. 위치 직접 쓰기 패턴 보존: `enterInteraction`/`exitObjectInteraction`은 `currentPlayer.position`을
    직접 mutate 후 다음 emit이 새 position을 실어보냄(gameStore.update 안 거침).
13. **머신 lifecycle**: `PlayerStateMachine.dispose()`를 제공하고 `PlayerControl.svelte`의 `onMount` cleanup에서
    호출한다. active state timer(stand-up, jump feedback), pending scheduled transition, trailing side effect가
    unmount 이후 `onStateChange`/network send를 호출하지 않도록 한다.
14. **event queue 순서**: frame 밖에서 발생한 canvas/animation/network/timer 이벤트는 발생 순서대로 queue에
    쌓고, 다음 `updatePlayerControl` 시작 시 FIFO로 모두 dispatch한다. 같은 프레임의 키보드/interaction polling보다
    먼저 처리한다. 클릭 즉시성은 최대 한 프레임 지연(보통 16ms 이하)만 허용한다.
15. **외부 애니메이션 이벤트 라우팅**: `PlayerModel`/`GameScenePlayersLayer`는 더 이상
    `playerControl.onPickupGrab()`/`onInteractionFinished()`를 직접 호출하지 않는다. 대신
    `{ type: 'anim_pickup_grab' }`, `{ type: 'anim_interaction_finished' }`를 상위 pending event queue에 추가하고,
    `GameScene`이 다음 `updatePlayerControl(deltaTime, { editorMode, events })` 호출에 포함한다.

## 정리/개선 (이번에 적용 — 정확성/견고성, gameplay-feel 불변)

- **L5 — Pickup→Dead/Respawn 시 `finishPendingPickup()` 명시 호출.** 현재는 Svelte `$effect`(반응형 backstop)에
  의존하는데 프레임워크 비의존 FSM엔 `$effect`가 없다 → Pickup을 떠나는 **모든** 전이(Dead.enter, Respawn,
  키보드/클릭 stand-up, anim finish)에서 명시적으로 `finishPendingPickup()` 호출. **가장 가능성 높은 회귀** → 필수.
- **L4 — Pickup 진입 시 `interactOffsetY` 명시적으로 0.** `buildPickupState`가 `...prev`로 stale offset을
  물려받을 수 있음(이전 오브젝트 인터랙션 offset). Pickup `enter()`에서 0으로 명시.
- **L7 — Moving(chase)→Idle를 단일 명시 전이로.** 콤뱃 `idle` 결과가 'moving'에서 왔을 때 현재
  `transitionToIdle()`가 no-op이고 `isMoving=false`+projection의 이중 경로에 의존 → FSM에선 한 개의 명시
  전이(Moving(chase) → Idle)로.

## 적용하지 않고 플래그만 (gameplay-feel 변경, 런타임 검증 불가 → 사용자 요청 시 별도 처리)

- **L1** stand-up 지연이 입력 경로마다 비대칭(클릭=300ms, 키보드/공격클릭=즉시).
- **L2** 비이동 키(E/Space) 누르면 `hasKeysPressed`로 click-move·combat이 취소됨(WASD 아님에도).
- **L3** 키보드 프레임에 health 가드 없음 → 죽은 프레임 1회 처리 가능.
- **L6** out-of-range `attack_monster`가 최대 1s 동안 stale 클릭 지점으로 접근(throttle seed).

이 4개는 **현재 동작 그대로 보존**한다. (전이표·테스트에 "현재 동작"으로 명시해 의도된 보존임을 기록.)

## 구현 순서

1. `fsm/context.ts`, `fsm/events.ts` — 타입·이벤트 union·emit 헬퍼 시그니처 정의.
2. `fsm/projection.ts` — 기존 `updatePlayerState`의 projection/diff emit을 먼저 순수화. builders는 전이
   snapshot용으로만 남기고, 이동/키보드 frame projection은 여기서 담당.
3. `fsm/movement-substrate.ts` — 기존 `updatePlayerMovement`의 integrator 블록(도착/중간waypoint/벽/경사/
   floor/ sendMove)을 **로직 동일하게** 이식, Moving 전용.
4. `fsm/states/*.ts` — 상태별 enter/exit/tick/handlers. `Moving(chase)`의 combat-first tick 규칙을
   명시 구현. 불변식 1–15 준수.
5. `fsm/machine.ts` — 머신 + transition + dispatch fan-out + project/emitTransition + `dispose()`.
6. `PlayerControl.svelte`/`GameScene.svelte` 재배선 — deps로 context 구성, machine 생성,
   `GameScene`은 pending event queue를 drain해
   `playerControl.updatePlayerControl(deltaTime, { editorMode, events })` 하나만 호출.
   `PlayerControl.svelte`가 내부 canvas/network/timer event를 enqueue하고, `GameScenePlayersLayer`는
   animation event를 `GameScene` queue로 올린다. state를 직접 바꾸는 callback은 제거한다.
   흡수된 자유함수/플래그와 compatibility wrapper는 안정화 후 제거.
7. `fsm/__tests__/` (vitest) — context를 mock으로 주입해 전이표 검증:
   idle↔moving(ground)↔arrival→idle, pickup near/far(approach→arrival→pickup→grab→finish),
   combat click in/out range→chase→reached→attack→attack_cycle→monster dead→idle, keyboard 선점,
   `Moving(chase)` retarget/사망/사거리 도달, interact 진입/거부/stand-up 3경로, dead/respawn,
   jump-feedback 쿨다운 + dispose clear, **L5 finishPickup on dead**, **L4 offsetY 0 on pickup**,
   event queue FIFO/drain 순서, emit-on-change diff 동작.

## 검증

- `npm run check`(svelte-check + tsc), `npm run lint`, `npm test`(vitest, 신규 FSM 테스트 포함) 모두 통과.
- `npm run format` 적용.
- 브라우저 검증 불가 → 사용자에게 스모크 테스트 요청 항목(우선순위순): 클릭 이동 / WASD 이동 / 몬스터
  근접·원거리 클릭(추격→공격→연타) / 아이템 근접·원거리 줍기 / 오브젝트 인터랙션 진입·이탈(클릭 vs 키보드) /
  사망·리스폰 / 급경사 점프 피드백 / 문 E키 / editor 모드에서 우클릭 이동.

## 후속 방향: 엔티티별 FSM 확장

이번 플랜의 범위는 **LocalPlayerControlFSM**이다. 여기서 바로 "모든 엔티티를 하나의 universal FSM 엔진 +
외부 JSON 정의"로 확장하지 않는다. 그 방식은 가능하지만, guard/action이 문자열 registry로 커지고 side effect
순서가 숨겨지며 TypeScript 타입 안정성이 약해질 위험이 크다.

대신 후속 단계에서는 엔티티 타입별로 책임이 분명한 FSM을 따로 만든다:

- `LocalPlayerControlFSM` — 로컬 입력, 클릭 이동, 전투 명령, 네트워크 송신, 애니메이션 콜백 처리.
- `RemotePlayerPresentationFSM` — 서버 패킷 기반 보간, 원격 플레이어 애니메이션 projection.
- `MonsterAIFSM` — 몬스터 판단, 추적, 공격, 사망 전이. 서버/클라 권위 경계는 별도로 명시.
- `RemoteMonsterPresentationFSM` — 서버 권위 몬스터 상태를 클라이언트에서 재생.
- `NpcInteractionFSM` — 대화, 루프 애니메이션, 스케줄, 상호작용 흐름.

공통화는 첫 FSM부터 추상화하지 말고, 최소 2-3개 FSM을 구현한 뒤 반복되는 패턴만 추출한다. 추출 후보는
`transition(exit → swap → enter)`, event queue drain, timer dispose, diff projection, debug trace 정도다.
상태 정의도 처음에는 JSON이 아니라 TypeScript object/config로 유지한다. JSON/데이터 기반 FSM은 side effect가
얕고 디자이너 데이터화 이점이 큰 NPC patrol/dialog/schedule 같은 영역부터 제한적으로 실험한다.

## 영향 파일

- 신규: `client/src/lib/components/player-control/fsm/**`(context, events, machine, movement-substrate,
  states/*, __tests__/*)
- 대폭 축소: `client/src/lib/components/PlayerControl.svelte`(얇은 어댑터화)
- 재사용·미변경: `player-state-builders.ts`, `player-physics.ts`, `canvas-click-dispatcher.ts`,
  `player-network-events.ts`, `combatController.ts`, `movementUtils.ts`
- 일부 변경: `GameScene.svelte`(게임 루프 단일 진입점 호출 + pending event queue drain),
  `GameScenePlayersLayer.svelte`(animation callback을 `PlayerControlEvent`로 상향 전달)
- 미변경 예상: `PlayerModel.svelte`(콜백 prop 자체는 유지 가능)
