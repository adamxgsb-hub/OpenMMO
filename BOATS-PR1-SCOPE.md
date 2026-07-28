# Boats PR1 — scope per Jake's feedback

Jake's reply to the proposal (2026-07-28):

> How about implementing a simple boat that an user/agent can control and
> other users ride together? Then we discuss about other high level game
> stuffs (trade, piracy, pvp, etc.)

Reading: green light to build, scoped to the social/movement core. Trade,
piracy, PvP, tiers, tides, ferries, contracts — all deferred to discussion.
This matches the proposal's stage 1 ("Boat movement core") plus the crew
feature, minus everything economic.

## What PR1 ships

- **One boat**: a simple sailboat (no tiers). Sold cheap by Rica in
  Aldermark — the spawn town sits on a river, so the boat is usable within
  a minute of buying it. Owned as a **deed** item: use at water's edge to
  launch, use again while aboard (docked/still) to dry-dock back to the bag.
  One hull afloat per player. No new persistence table.
- **Pilot control, human and agent, same information**:
  - Human: with your boat launched, click water to sail there; click shore
    to beach/stop. UI shows heading and a stop control.
  - Agent: `{"type": "sail", "x": …, "z": …}` and `{"type": "stop_sailing"}`
    actions; outcomes come back as events, in-flight motion is noise (the
    fishing pattern).
  - Server-authoritative: waypoint steering across the water field
    (validated with the `WaterSampler`), fixed speed, tick-driven like the
    fishing tick. If the straight run to the click is blocked by land, sail
    to the obstruction and stop with a message — no full A* over water in
    PR1 (noted as follow-up; keeps the diff small).
- **Riding together**: other players (and agents) near a boat can board it;
  their positions attach to the hull and the server moves them with it;
  they disembark freely near shore/shallow water. Pilot disembarking (or
  disconnecting) anchors the boat in place. No combat aboard in PR1 —
  attacking or being attacked simply puts you off the boat (the fishing
  abort idiom), so nothing about PvP is decided implicitly.
- **Protocol**: `BoatLaunched`, `BoatState` (broadcast movement),
  `BoatBoarded` / `BoatLeft`, `SailTo`, `StopSailing`, errors via
  `SystemMessage`. `PROTOCOL_VERSION` bump.
- **Art**: one hull model via the ART-PIPELINE workflow (Meshy → Blender →
  glb) or a placeholder procedural hull if the model isn't ready — the
  fishing precedent (ship v1 asset-light, polish after) applies.
- **Tests**: state machine with injected clock (launch, sail, blocked,
  dry-dock), two-player ride-together (passenger moves with hull,
  disembark), abort paths (attacked, disconnect, unequip-like edge cases),
  agent action parsing. The whole fishing test discipline.

## Explicitly NOT in PR1 (awaiting Jake's discussion)

Sailing skill & tiers · cargo hold & trade · ports, ferries, docks ·
piracy/parley · tides · PvP · sealed contracts · commissioning. The
proposal (`PR0-boats-proposal.md`) stays the reference for that discussion.

## Notes

- This is the stage estimated at ~2 days — the hardest stage (moving
  platform + passenger sync). Everything later rides on it.
- Branch: `boats/pr1-simple-boat` layered on upstream master, same
  workflow as the fishing stack.
