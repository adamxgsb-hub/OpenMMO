# Boats

A simple rowboat one player pilots and up to three more ride together —
the smallest slice of the archipelago-crossing travel the worldgen was
tuned for (`min_strait_width_cells` deliberately cuts land bridges
"producing archipelagos that require boats to traverse").

Server-authoritative end to end: the boat's position, its route and every
rider aboard live in `server/src/game_state/boats.rs`. Clients render one
broadcast hull transform and place riders from it; they never move a rider
themselves.

## The deed

The boat is owned as a **deed** (`boat_deed`, 300c, sold by the general
merchant — locked by `a_merchant_sells_the_boat_deed` in
`server/src/merchant_defs.rs`). Using it at the water's edge launches the
boat and steps you aboard; using it again aboard — stopped, alone, near
shore — packs the boat up. The deed is never consumed
(`UseEffect::LaunchBoat` in `server/src/item_defs.rs` skips
`consume_one_and_sync`), so the deed *is* the boat, rolled up. Carrying no
`equipSlot`, it can never slip into the dungeon-chest pool
(`equipment_ids_with_min_price` filters on the slot).

There is no boat persistence table: a hull exists only between launch and
stow, and a server restart implicitly stows every boat. One hull afloat
per owner.

## Water

A point is navigable when the baked water field's surface sits at least
`MIN_NAV_DEPTH_M` (0.3 m) above the terrain bed — the fishing water check
(`surface − bed`), with a deeper draft: a bobber floats where a keel
grounds. Both samplers are async and tile-cached, and are only ever read
in handlers (`launch`, `SailTo`, the shore probes) — **never in the boat
tick**, the same rule fishing established.

## Sailing

`SailTo { x, z }` samples the whole leg every `SAIL_SAMPLE_STEP_M` (2 m,
clamped to `MAX_SAIL_LEG_M` 60 m — `leg_sample_points` in
`shared/src/boats.rs`) and keeps only the watery prefix as waypoints with
pre-sampled surface heights. A leg aground from its first step earns
"The way is blocked by land."; a later shoal silently truncates, and the
final `BoatState { sailing: false }` shows where the boat stopped.

`tick_boats` (200 ms, dt-driven like the player movement sim) walks the
route at `BOAT_SPEED_MPS` (6.0 — twice walking pace), wrapping the
cylindrical world's X seam, and broadcasts one `BoatState` per moving boat
per tick within `EVENT_DELIVERY_RADIUS`.

## Riding together

`BoardBoat` seats up to `BOAT_SEATS` (4) riders in **fixed seats** — the
owner holds the helm (seat 0), nobody is ever re-seated, and only the
owner steers. Riders' server positions are the hull's exactly (seat
offsets are client-side cosmetics), so combat range, chat radius and AOI
stay honest to within a hull length.

While the boat moves, riders generate **no `PlayerMoved` at all**: the one
`BoatState` broadcast carries everyone, and clients derive each rider from
the interpolated hull plus their seat. Server-side, `carry_rider` moves
positions with the hull and runs an appearance-only AOI diff
(`fanout_player_position_update` with no movement message). Boarding and
going ashore are the exceptions — each is a single trusted hop with a
normal `PlayerMoved`.

Aboard, walking ("You are on a boat — sail it or step ashore."), attacking
and fishing are refused — each guard lives in its `game_state` method,
where the tests can reach it. Dying and disconnecting pull a player from
their seat through the existing `on_player_died` / disconnect chokepoints.
Going ashore probes `SHORE_PROBE_RADIUS_M` around the hull for water
shallow enough to stand in; in open water it is refused. The last rider
off takes the hull with them — the deed model leaves no orphan boats.

## Client

- `stores/boatsStore.ts` — boats and the local berth, mutated only by
  `network/messageHandlers.ts` (the fishing-store pattern).
- `managers/boat-transform.ts` — pure hull easing + seat math
  (vitest-covered; X-seam shortest way, shortest-arc bow swing, snap on
  out-of-range jumps).
- `managers/boatManager.ts` — interpolation between `BoatState`s; also the
  hull click-target registry.
- `components/Boat.svelte` — the Meshy-generated rowboat hull
  (`models/objects/rowboat.glb`), normalized at load to the 3.6 m
  seat-offset footprint and stamped with `userData.boatId` for the click
  raycast.
- Input: clicking a hull boards (out of reach walks closer); aboard, deep
  water charts a course (pilot only) and land steps ashore
  (`managers/inputHandler.ts`, `canvas-click-dispatcher.ts`).
- A `sailing` control state (`player-control/fsm/`) with **no walking or
  keyboard phases**: the rider's only frame work is seat placement from
  the eased hull, so no `PlayerMove` is ever sent aboard and the
  offset-following camera glides with the boat.

## Agent parity

Agents sail through the same protocol: `sail` / `stop_sailing` / `board` /
`disembark` actions (`agent-client/src/driver/action.rs`), no reflex layer
needed — the server drives the hull, the LLM only picks destinations.
Nothing about sailing is timing-sensitive, so a bot and a person pilot
equally well. `BoatState` broadcasts are deduplicated latest-per-boat
(the `PlayerMoved` collapse) before the event queue.

Agents cannot see water — there is no client-side water field in the
agent — so the server's `[BoatError]` refusals are their depth sounder:
sail, read the refusal, adjust. The world state lists their berth or any
boat in sight with its `boat_id`.

## Deliberate limits (this slice)

- **No deck walking**: riders are pinned to seats. Walking a moving deck
  is the "moving bridge" problem (`bridgeManager` handles only static
  decks) and is deferred whole.
- **No combat at sea, in either direction decided**: attacking from a boat
  is refused, taking damage does not eject, dying does. Whether boats
  should ever be fought from (or boarded hostilely) is an open design
  question this slice deliberately does not answer.
- **No fishing from the deck** — a natural follow-up once boat fishing is
  wanted (the cast check already knows depth).
- **Visual wave clipping**: the hull rides the baked mean water surface;
  the Gerstner shader displacement is visual-only, so crests can lap
  through the hull.
- **Riders stand rather than sit**: there is no seated or rowing clip in
  the animation packs (`locomotion`, `combat_melee`, `social`), so riders
  hold `idle` on the floorboards and the modeled oars never move. Both
  clips follow the established pipeline (`doc/ASSETS.md`,
  `doc/ANIMATION.md`) and are the obvious next art pass.
- **No currents**: the baked water field's `flowX/flowZ` are ignored.
- Prices and speeds are first guesses — final tuning is explicitly the
  maintainer's call.
