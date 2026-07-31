# Mining

Walk up to an ore vein with a pickaxe, click it, and the pick swings on a
server timer until the vein crumbles or you stop. The second gathering
profession on the trained-skill system (`shared/src/skills.rs`), built on the
fishing template: server-authoritative end to end — every timer and roll
lives in `server/src/game_state/mining.rs`; clients render broadcasts and can
only start or stop.

## Where ore comes from — generated, not stored

The world had no ore, and this feature adds none to the bake. **Ore veins
are a pure function of terrain tiles that already exist.**

The splat baker classifies exposed rock: cells whose slope crosses
`CLIFF_SLOPE_THRESHOLD` (≈45°) get `PAL_CLIFF` as their primary texture, and
a fade apron around them carries it as secondary
(`shared/src/worldgen/tile_bake/splatmap.rs`). That palette channel *is* the
geology — mountains, gorge walls, sea cliffs. `ore_nodes_for_tile(tile_x,
tile_z, splatmap, heightmap)` (`shared/src/worldgen/ore_nodes.rs`) scans a
tile's baked splat + height bytes and deterministically places 0–5 outcrops
on that rock (Mulberry32 seeded per tile — the tree-bake pattern, with its
own prime pair): per-cell probability on cliff cells, an 8 m spacing floor,
never underwater, never on the plains (grass cells carry `vegMeta ≠ 0`; ore
and trees occupy complementary terrain by construction). Each node also
rolls its identity: rock variant, scale, rotation, and a **yield of 2–5
ore**.

This is the **river-rock idiom promoted to gameplay**: the client already
derives decorative rocks from baked water-field bytes with no extra artifact
or message (`client/src/lib/utils/river-rock-placement.ts`); ore does the
same, but everyone runs the *same shared Rust*:

- the **server** derives node lists to validate `MiningStart`
  (`terrain::ore::OreNodeIndex`, tile-cached, the third sampler beside
  height and water);
- the **web client** calls the identical function through wasm
  (`ore_nodes_for_tile` in `wasm_api.rs`) to render and raycast outcrops
  (`GameSceneOreNodesLayer.svelte`) — every rendered outcrop is a real vein;
- the **agent-client** could derive them natively from the same terrain
  HTTP tiles (today it doesn't need to: `mine` aims at a position and the
  server snaps).

Same bytes in, same veins out, on every surface — parity by construction,
no re-bake, no migration, works on every world baked to date. The only
mutable state is **depletion**, held in server memory with a respawn
deadline; a restart heals every vein, the right failure mode for a
renewable resource.

## The loop

```
MiningStart { position } ─► snap to nearest vein (≤6 m), validate
        │                    pickaxe · overworld floor · reach ≤3 m ·
        │                    vein not spent · vein not claimed
        ▼
   Swinging ─ every 2.8 s (2%/level faster, floor 60%):
        │      d20 + level/2 ≥ 8 → an ore breaks free (nat 1 always misses)
        │      ore → bag (or spills when overweight) + skill XP
        ▼
   vein's yield exhausted ─► MiningNodeDepleted ─► Ended (Exhausted)
   MiningStop / move / attack / death / pickaxe stowed ─► Ended
```

**Getting a pickaxe:** Rica sells it (3 silver — a starter tool, same shelf
as the fishing rod), main-hand equip. Excluded from dungeon-chest loot like
the rod (`equipment_ids_with_min_price`). Not a weapon: swinging it at a
monster uses the bare-handed path.

- **Start** (`MiningStart { position }`): a *position*, not a node id — the
  server snaps to the nearest vein within 6 m, so the web client can click a
  mesh and an agent can just say "mine here". Refusals are a direct
  `MiningError` (no pickaxe, no vein, spent vein, someone already working
  it, out of reach). One miner per vein at a time; one session per player.
- **Strikes** resolve on the 250 ms mining tick against `tokio::time`
  deadlines (tested under a paused clock). Each hit rolls the **yield
  table**: every `category: "ore"` item with an `oreWeight` column, weighted
  `oreWeight + (level + altitude_bonus) × rarityTier`. Skill and altitude
  both shift the table toward rich ore without ever emptying the stone —
  `altitude_weight_bonus` grants one point per 25 m of vein elevation
  (capped at 5): the high peaks are where the silver lives.
- **Yield**: the ore stacks into the bag via the normal `InventoryUpdated`,
  or spills as a ground item when the bag can't take the weight — never
  silently lost (fishing's rule). Strikes, depletion, and respawn broadcast
  to everyone near the vein (`EVENT_DELIVERY_RADIUS`), so mining is visible
  to passers-by.
- **Depletion**: after its 2–5 ore the vein crumbles (clients render it
  sunken and dim) and respawns 5 minutes later (`MiningNodeRespawned`).
  A player who walks up later simply sees the intact rock and learns the
  truth on their first swing — the server refuses a spent vein.

## The ore ladder

| ore | tier | weight @ lvl 0 | basePrice | sells (40%) |
|---|---|---|---|---|
| Chunk of Stone | 1 | 45 | 8c | ~3c |
| Copper Ore | 2 | 30 | 20c | 8c |
| Iron Ore | 3 | 16 | 45c | 18c |
| Silver Ore | 4 | 7 | 120c | 48c |
| Gold Ore | 5 | 2 | 400c | 160c |

Sellable through the existing merchant flow; not edible, not equipment —
raw material for a future smithing line. **Economy guardrail as a test**
(the fishing pattern): `expected_ore_value_stays_in_the_coin_pile_economy`
locks the level-0 expected sell value per broken ore to the 5–25c coin-pile
band (~13c today). A future ore that turns mining into a money printer
fails the suite. `oreWeight` is its own CSV column precisely so ore can
never leak onto a fishing hook (and `catchWeight` never into a vein) —
locked by test.

## Skill

Each broken ore grants mining XP: `3 × rarity²` (3 for stone, 75 for gold
ore) — smaller per item than fishing's `10 × rarity²` because ore lands
every few strikes while a catch takes a whole cast cycle; the *rates*
match. Misses grant nothing. No character XP — combat balance untouched.
Level effects today: faster swings (2%/level, floor 60%), better hit odds
(`d20 + level/2`, nat 1 always misses), richer table weights. Shares the
`character_skills` persistence, `SkillsUpdate`/`SkillXpGained` messages and
the character-panel Skills section — adding `SkillId::Mining` touched no
storage code.

## Agent parity

Nothing to react to *by design*: after `MiningStart` the server swings
until the vein dies or the miner leaves. There is no reflex layer to write
— the loop is equally effortless for a human (click, watch, ESC to stop)
and an agent (`{"type": "mine"}` / `{"type": "stop_mining"}`, then a
single `[Mining]` outcome event; strikes are classified as noise so mining
costs no extra LLM calls). Strike cadence and hit rolls are
server-authoritative, so neither a fast human nor a fast bot can swing
faster than the timer.

## Deferred by design (v2 lines)

- **Pickaxe swing animation + SFX** — reuses idle/attack poses today; a
  Mixamo swing clip and CC0 pick-on-rock cues follow the fishing art
  pipeline (`doc/ART`), and ore/pickaxe icons currently reuse placeholder
  art (`sword.png` / the spear icon) exactly as the first fishing PR did.
- **Smelting / smithing** — ores are deliberately raw materials with no
  consumer yet; a furnace profession is the natural next skill.
- **Gem finds** — a rare bonus roll on high-tier veins.
- **Depletion visibility on arrival** — clients render depletion only if
  they saw the broadcast; a snapshot-on-join (the ground-item pattern)
  is a small follow-up if the ghost-rock moment proves annoying.
- **Pickaxe tiers** — same shape as rod tiers.
