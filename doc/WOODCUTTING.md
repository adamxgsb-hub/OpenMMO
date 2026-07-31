# Woodcutting

Set an axe to a tree the world already grew, swing until it falls, carry off
the timber. The second gathering profession and the second consumer of the
trained-skill system (`shared/src/skills.rs`), built deliberately as
fishing's opposite: fishing is a reflex game about moments, woodcutting is a
commitment game about standing still. Server-authoritative end to end: every
timer, target check and yield lives in `server/src/game_state/woodcutting.rs`;
clients render broadcasts. There is nothing to answer mid-chop — by design
(see "Agent parity").

## The trees are the world's own

Woodcutting adds **no new placement data**. The choppable trees are exactly
the baked TR01 instances the world already renders (`doc/VEGETATION_SYSTEM.md`,
`shared/src/tree_format.rs`): slot 0 is `tree.glb` — the big broadleaf
"oaks", baked scale 0.7–3.0 — and slot 1 is `tree2.glb`, the smaller common
timber trees, scale 0.6–1.4. The server reads the same per-tile bytes the
client fetched (`terrain::trees::TreeReader`, decoding bit-for-bit like
`client/src/lib/utils/tree-data.ts`), so "is there really a tree there" is
answered from one source of truth. A tree is addressed as
`TreeRef { tile, slot, index }` — the position the file stores it at.

`TreeReader` is deliberately cache-free (unlike the height/water samplers):
tree tiles are tiny, a chop start is rare, and housing placement prunes and
rewrites tree tiles at runtime — a stale cache would point axes at trees that
no longer exist. Tile reads happen only in the async `ChopTree` handler,
never in the tick (the fishing sampler rule).

## The loop

```
ChopTree { position } ─► server snaps to the nearest standing tree (≤ 4 m
       │                 of the point) and validates axe/floor/reach/skill
       ▼
   Chopping ─ one swing per 1.5 s, on the server's 250 ms tick
       │ every swing: ChopSwing broadcast (progress bar, bystanders)
       │ move / attack / unequip axe / die / disconnect → Aborted
       ▼
   last swing: TreeFelled (world-wide) + logs to the bag + skill XP
       │
       ▼
   stump for 120 s ─► TreeRespawned (world-wide)
```

**Getting an axe:** buy a Woodsman's Axe from a general merchant (Rica stocks
it for 3 silver, shelf-neighbour to the fishing rod) and equip it in the main
hand. Axes are excluded from dungeon treasure chests, same reasoning and same
mechanism as rods (`item_defs.rs::equipment_ids_with_min_price`), and like
the rod the axe is **not a weapon** — no damage dice, so swinging it at a
monster uses the bare-handed path. A felling axe is a tool at a tool's price,
not a budget battleaxe.

- **Target** (`ChopTree { position }`): the client resolves a click to a
  trunk from its decoded tree tiles (`utils/chop-target.ts`) and sends that
  point; the server re-finds the nearest standing tree within
  `TREE_SNAP_RADIUS_METERS` (4 m) of it and requires the trunk within
  `MAX_CHOP_DISTANCE_METERS` (4 m) of the player, overworld floor only.
  Position in, position validated — an agent that only knows "I'm standing
  in a grove" can send its own feet and hit the same tree a pixel-perfect
  click would.
- **Work**: `swings_to_fell` (shared) = size-scaled base (4 + 2·scale for
  oaks, 3 + 2·scale for timber trees) minus a skill discount (1 swing per 6
  levels), never below 3 — a felling is always a visible commitment, never a
  drive-by tap. One swing per `SWING_MS` (1.5 s). One chopper per tree; the
  first axe claims it.
- **Yield**: `log_yield` tracks the baked instance's real scale — a 0.7-scale
  oak drops 1 Oak Log, the 3.0-scale giants drop 4; timber trees drop 1–2
  Timber Logs. Logs are stackable commodities awarded through the normal
  `award_item` path (bag, or spilled to the ground when overweight).
- **Stumps**: a felled tree joins an in-memory stump map for
  `TREE_RESPAWN_MS` (120 s) and cannot be re-chopped meanwhile. `TreeFelled`
  and `TreeRespawned` broadcast **world-wide** (stumps are few and every
  client must agree on which trees stand no matter where it was when the
  tree fell); a joining client gets the current stump list once via
  `TreeStumps`. A restart regrows the forest — stumps are transient state,
  not save data.

The whole machine runs on `tokio::time::Instant`s advanced by a 250 ms tick,
so the tests drive it with `start_paused` + `time::advance`
(`game_state/tests.rs::woodcutting_tests`) — including a real TR01-encoded
test grove through the production decoder.

## Skill, gates and the unlock ladder

Felling grants Woodcutting XP through the shared skill curve: 12 XP per Oak
Log, 6 per Timber Log (`chop_xp` — the reward tracks exactly what landed in
the bag). No character XP, same reasoning as fishing: professions must not
touch combat balance.

The unlock ladder is spaced against the level-30 cap the way fishing spaces
salmon (10) and sturgeon (20) — but the gate comes from the **baked scale**,
so the trees you cannot cut yet are literally the tallest ones on screen:

| Tree | Gate | Why |
|---|---|---|
| Timber trees (`tree2.glb`, any size) | — | The skill is for everyone, day one |
| Oaks below scale 1.8 | — | Common broadleafs |
| Oaks ≥ 1.8 | Woodcutting 10 | The big canopy trees |
| "Ancient oaks" ≥ 2.6 | Woodcutting 20 | The 4-log giants |

Skill also shaves swings (above) — mastery is faster, never instant.

## The timber economy

Anchored to the same income faucets as fishing (a coin pile is 1–10c, Rica
pays 40% of base): a Timber Log sells for ~4c, an Oak Log for 8c, so a
15-second ancient-oak felling pays ~32c — a couple of coin piles, gated
behind level 20 and a 2-minute stump. Pinned by a contract test
(`item_defs.rs::log_prices_stay_in_the_coin_pile_economy`): every log's sell
value stays in the 4–12c band and the best single felling in the game stays
under 60c, so a price tweak can't quietly turn groves into gold mines.
Timber is also the obvious future build material (boats, housing) — selling
to Rica is its floor price, not its purpose.

## Client

- `stores/woodcuttingStore.ts` — chop phase/progress + the world-wide
  `felledTrees` set.
- `utils/chop-target.ts` — click → nearest standing trunk from the decoded
  tile data (position-based on purpose: the instanced tree meshes reshuffle
  their slot indices every occlusion rebuild, so there is no stable id to
  raycast). Unit-tested, including tile-boundary search.
- `managers/inputHandler.ts` — axe in main hand + a standing tree near the
  clicked ground point → `chop_tree` intent instead of a walk; out-of-reach
  trees walk you to a stop-short point (the `approachAndTrade` pattern).
- `components/WoodcuttingPrompt.svelte` — progress HUD (swing bar, ESC to
  stop), mounted beside `FishingPrompt` in `GameHud`.
- `GameSceneTreeLayer.svelte` — skips felled instances on rebuild, driven by
  the `felledTrees` store; the baked tile caches are untouched (the data
  didn't change, only which instances currently stand).
- `CharacterPanel.svelte` — renders the Woodcutting skill with zero
  component changes (the skills section is map-driven).

## Agent parity

Fishing keeps parity by making its windows generous; woodcutting keeps it by
having **no windows at all**. Once `ChopTree` is accepted, the server swings
on its own clock — a human, a laggy human, and an agent-client produce
identical fellings. The agent-client therefore has no woodcutting reflex
layer; the LLM decides where and whether:

```json
{"type": "chop_tree", "x": 7.0, "z": 3.0}
{"type": "chop_tree"}
{"type": "stop_chopping"}
```

Outcomes arrive as `[Woodcutting]` events, refusals as `[WoodcuttingError]`,
and skill progress as the new `[Skill]` line (`SkillXpGained`, which also
retro-fits fishing XP visibility). Chop-swing progress and the world-wide
tree bookkeeping are classified as unbuffered noise (`state.rs`) so a felling
costs the agent exactly one LLM turn.

## Deliberate limits

- **No minigame.** A gathering loop you can hold a conversation over is a
  feature, and the contrast with fishing keeps the two professions feeling
  different. If woodcutting ever needs depth, add it at the *decision* layer
  (which tree, which grove) — not the reflex layer.
- **No axe tiers, no rare drops (bird nests, resin), no firemaking/fletching
  sinks** — all natural follow-ups once timber has a consumer (boat hulls,
  housing walls).
- **Art & sound ship later, the fishing precedent**: no chop animation pack,
  swing SFX, or axe/log icons yet (the axe and logs use the placeholder icon
  the rod itself shipped with until its PR6 equivalent; a Meshy→Blender axe
  model via `ART-PIPELINE.md` is the follow-up). The `ChopStarted`/`ChopSwing`
  broadcasts already carry everything a swing animation needs.
- **Stumps are invisible remotely-felled trees**, not stump models — the tree
  simply vanishes until it respawns. A stump mesh is pure polish on top of
  the same `felledTrees` set.
- **Baked-tile rewrites (housing prunes) shift tree indices.** Live sessions
  and stumps tolerate this: chop validation re-reads the current bytes at
  start, and a dangling stump entry just expires. The worst case is a stump
  hiding the wrong tree for its 2-minute lifetime in the rare event a house
  lands in a half-chopped grove.
