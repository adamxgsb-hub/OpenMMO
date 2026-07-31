# Proposal: Woodcutting (second trained skill — the timber the world already grew)

Hi again! When you scoped the boats work you asked to keep the high-level game
stuff (trade, materials, commissioning) for discussion — this is the first
piece of that discussion made concrete: **woodcutting**, the smallest
gathering profession that gives the later boat stages their build material,
and the second consumer of the trained-skill system fishing introduced. Same
approach as before: server-authoritative, agent-playable through the same
protocol as humans, and I have a working, fully tested implementation on my
fork so we're discussing something real — but nothing opens as a PR until
you're happy with the design. (Development AI-assisted with Claude,
human-reviewed and tested, as before.)

## The design in one line

**No new content was added to the world — the choppable trees are the baked
TR01 instances it already renders.** The server reads the same per-tile tree
bytes the client draws (a small `terrain::TreeReader` beside your
height/water samplers, decoding bit-for-bit like `tree-data.ts`), so "is
there really a tree there" has one source of truth, and every tree's
position and baked scale are already gameplay data. A tree is addressed as
`(tile, model slot, index)` — the way the file stores it.

## Agent parity, by construction (the inverse of fishing)

Fishing keeps parity by making its reaction windows generous; woodcutting
keeps it by having **no windows at all**. `ChopTree { position }` is the
entire input: the server snaps to the nearest standing tree within 4 m of
the point, validates axe/floor/reach/skill, then swings on its own clock —
one swing per 1.5 s on a 250 ms tick — until the tree falls or the chopper
moves, fights, unequips the axe, dies, or disconnects (the fishing abort
list). A human, a laggy human, and an agent produce identical fellings, and
there is deliberately **no minigame**: fishing is a reflex game about
moments, woodcutting is a commitment game about standing still. Two
professions that feel different, one parity story each.

Agent side that means no reflex layer at all — the LLM sends
`{"type": "chop_tree", "x": …, "z": …}` (coordinates optional: the server
snaps from wherever the agent stands) or `{"type": "stop_chopping"}`, and
only outcomes reach the model (`[Woodcutting]` events; swing-by-swing
progress is classified as unbuffered noise, so a felling costs one LLM
turn). I also added a `[Skill]` event line for `SkillXpGained` — which
retro-fits fishing: agents previously never saw their own skill level.

## The loop and the numbers

Buy a **Woodsman's Axe** from Rica (3 s — rod-priced, shelf-neighbour to the
rod; chest-excluded and **not a weapon**, no damage dice, same reasoning as
the rod) → click a tree → it falls after a size-scaled number of swings →
logs to the bag, Woodcutting XP, and the tree becomes a **stump for 120 s**,
world-visible, before regrowing.

Everything scales from the **baked instance scale**, so the world's own size
variety is the reward ladder:

| Tree | Swings (skill 0) | Yield | XP | Gate |
|---|---|---|---|---|
| Timber tree (`tree2.glb`, 0.6–1.4) | 4–6 | 1–2 Timber Logs | 6–12 | none — day one, like the skiff |
| Small oak (`tree.glb` < 1.8) | 5–8 | 1–2 Oak Logs | 12–24 | none |
| Big oak (≥ 1.8) | ~8–9 | 2–3 Oak Logs | 24–36 | Woodcutting 10 |
| Ancient oak (≥ 2.6) | 9–10 | 3–4 Oak Logs | 36–48 | Woodcutting 20 |

Skill shaves a swing per 6 levels (never below 3 — a felling is always a
visible commitment), and the 10/20 gates are spaced against the level-30 cap
exactly like salmon/sturgeon — with the nice property that the trees you
can't cut yet are literally the tallest ones on screen.

- **Economy guardrail as a test**, same discipline as fishing: Timber Log
  12c / Oak Log 20c base (sell at Rica's 40% ≈ 4.8c / 8c), so the earn rate
  lands at fishing's ~0.6c/s and the best single felling in the game (~32c)
  stays a couple of coin piles. A unit test pins every log inside the 4–12c
  sell band and the best felling under 60c — a future price tweak that turns
  groves into gold mines fails the suite. Depletion is the second guardrail
  fishing doesn't need: a chopper must roam, so zero-attention chopping
  can't out-earn fishing.
- **Depletion is shared world state**: `TreeFelled`/`TreeRespawned`
  broadcast world-wide (a handful of bytes, a few times a minute — noise
  even at thousands of players) and joiners get a `TreeStumps` snapshot, so
  every client agrees which trees stand. Stumps are in-memory only; a
  restart regrows the forest. No save-data changes anywhere in the feature —
  the skill rides the existing `character_skills` table.
- **Timber naming**: `tree.glb` (the big broadleaf) drops **Oak Log** — oak
  being the boats material the earlier proposal floated, and the historical
  Nordic shipbuilding wood — while `tree2.glb` drops the deliberately
  species-neutral **Timber Log**, so if you ever want regional forestry
  (pines in Havgard's north?) the item ids survive it.

## Status on my fork

The full loop is implemented and green end to end — protocol v9, server
state machine with paused-clock tests against a real TR01-encoded test grove
(felling, stump regrowth, the level-20 gate, every abort path, two-chopper
contention), the economy contract test, client targeting/HUD/tree-hiding
with vitest coverage, and the agent actions with parsing tests. Design doc
in the branch: `doc/WOODCUTTING.md`, including a "deliberate limits" list.
Happy to record GIFs (chop → logs → tree vanishes for a second client →
regrows) if that's useful for the read.

## v2 ideas (not built — asking first)

- **Timber as build material** — the real point. Boat hulls (and maybe
  housing walls) consuming Oak Logs would give timber a purpose beyond the
  merchant floor price. I've kept logs sell-only until the boats discussion
  decides that shape.
- **Rare finds** — a bird's nest / amber resin at flotsam-like odds, rarity
  0-style so no XP inflation. Skipped for v1 to keep the diff reviewable.
- **Regional forestry** — biome-aware tree placement (conifers north). A
  worldgen change, orthogonal to this PR, and the item naming already
  tolerates it.
- Axe tiers, firemaking/fletching-style sinks, stump models, chop
  animation/SFX polish — all deferred on purpose (the doc lists the lines).

## Questions before I open PRs

1. **The no-minigame call** — chopping is deliberately hands-off after the
   click, as fishing's contrast. Does that match your feel for how gathering
   professions should differ, or would you want *some* interaction?
2. **Depletion shape** — 120 s world-shared stumps (everyone sees the tree
   fall and regrow). Happy with shared depletion, or would you prefer
   per-player nodes / no depletion?
3. **Gating on baked scale** (big oaks at 10, ancient at 20) — good, or
   would you rather gate differently (regions, axe tiers)?
4. **Species naming** — "Oak Log" for `tree.glb`'s drop: fine, or do you
   have species/biome intentions for the two tree models I should follow?
5. **Protocol** — this lands as v9 with additive messages, same policy as
   the fishing bumps. Still the right call?
6. **Timber's future** — reserve logs as boat/housing build materials (my
   assumption), or should they stay a pure income item?
7. **Assets** — same plan as fishing: placeholder icon at first, then
   AI-generated icons + a Meshy axe model + a Mixamo chop clip + CC0 SFX,
   recorded in `doc/assets/` per your format. Any constraints I should know
   beyond what fishing already established?

If the direction looks right I'll open the PR immediately — it's one
reviewable branch, and I'm happy to adjust any number or rip out any piece
first.
