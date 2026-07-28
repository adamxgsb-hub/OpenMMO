# Proposal: Boats — sailing, port trade, ferries, and piracy

Hi again! After fishing, I'd love to take on the TODO line that fishing kept
bumping into: **배를 구현한다** — boats. Same approach as before:
server-authoritative, agent-playable through the same protocol as humans,
built in small reviewable PRs, and I'm asking before building the parts that
touch worldbuilding and balance. (Development AI-assisted with Claude,
human-reviewed and tested, as before.)

The worldgen already commits to this feature: `min_strait_width_cells` cuts
land bridges "producing archipelagos that **require boats** to traverse," and
the sea-channel pass splits the continents on purpose. Meanwhile
`WORLD_BUILDING.md` has a whole maritime civilization waiting — Havgard the
sea-nation, the Council of Shipmasters, convoy fleets, privateers in the
Brosund, and islands written as sailing waypoints (Springisle's fresh water,
Wreckisle's reefs). This proposal tries to be the smallest system that makes
that lore playable.

## The shape of it

Four pieces, each a separate PR stage, each useful without the next:

1. **Sailing** — pilot a boat across real water; a Sailing trained skill.
2. **Ports & ferries** — named harbors; pay a fare to cross without a boat.
3. **Cargo & port trade** — a hold, and per-port prices worth sailing for.
4. **Piracy & boarding** — agent-crewed pirates who can stop you and take
   what's in the hold — and only what's in the hold.

## Agent parity, by construction

Same contract as fishing: nothing twitchy, nothing hidden.

- Steering is **waypoint sailing**, not real-time helm work: the pilot gives
  a destination, the server plots and follows a water route (the A* precedent,
  over the water mask instead of land). Same information, same control.
- The pilot's interface is the **tillerman** (the Ultima Online homage): a
  crewman at the helm of every sailed boat. A person clicks the sea or tells
  him in chat — "sail to Stenhavn"; an agent sends
  `{"type": "sail", "x": …, "z": …}`. Chat is already the one interface
  humans and agents genuinely share, so the boat's controls live in it. He
  acknowledges in kind ("Aye — Stenhavn, by the strait"), which doubles as
  the voyage log.
- Boat state (`position, heading, speed, hull`) is broadcast like player
  movement — spectators and agents see what the pilot sees.
- A pirate intercept is announced with a generous response window (hail →
  choice: flee / fight / surrender), sized for a network round trip like the
  fishing bite. No outcome depends on reaction speed.
- Boarding resolves through the **existing combat system** on a stationary
  deck — no new combat mechanics for agents to learn.

## Boats (four tiers, Sailing-skill gated)

Following the fishing unlock ladder (salmon at 10, sturgeon at 20), tiers gate
on the Sailing skill, and each tier's identity comes from the worldbuilding:

| Boat | Lore | Skill | Speed | Hold | Acquired |
|---|---|---|---|---|---|
| **River Skiff** | The flat-bottomed rowboat every Dulunar riverbank knows; Aldermark's carpenter knocks them together from Gray Plains timber | — | slow | none | Cheap at any port or the starting town (fishing-rod-priced: a new player can own one day one) |
| **Gullwing Sloop** | Single-sail coastal boat named for Gullisle's wheeling seabirds; the fisherman's and smuggler's favorite | 10 | medium | small | Sold by port shipwrights |
| **Brosund Cog** | The broad-beamed workhorse of the Brovik–Edra strait trade; most of Duluna's legitimate cargo crosses in one | 20 | medium | large | Sold in the two strait ports (Brovik, Edra) |
| **Silverbight Caravel** | Havgard's shipwrights are the finest in the world, and this is why; fast, tall-masted, built in Stenhavn's cliff yards | 30 | fast | large | **Stenhavn only**, and only to those the Council of Shipmasters will license — i.e. you have to sail there first on something lesser |

The skiff needs no skill at all — anyone can row — so the system is open
from level 0, and every level thereafter is earned at your own tiller.

The skiff is deliberately the rod of this system: no skill gate, cheap
enough that the feature is for everyone, day one. The caravel is deliberately
the sturgeon: it tops out at the skill cap (30), you earn the right to buy
it, and buying it requires having crossed the sea already. Exact prices anchored to the income faucets as before (and locked
with the same kind of economy contract test) — my working band is skiff ≈ a
few silver, caravel ≈ dungeon-gear territory, but that's calibration, not
design, and I'll tune it to whatever you think.

A boat is owned as a **deed** (the Ultima Online pattern): place it at a dock
or shore to launch, dry-dock it back into a rolled deed in your bag when
done. No abandoned hulls silting up Edra's harbor, no lost-boat support
burden, and persistence rides the existing item system instead of a new
table. One hull afloat per player at a time.

**Sailing skill**: second `SkillId` on the system fishing added. XP from
distance sailed and first-dockings at new ports; levels unlock tiers and add
a small speed bonus. Same curve, same cap, same UI — the foundation PR was
built for this moment.

## Ports & the minimum route

Your map has already placed everything this needs — Aldermark, Edra, Brovik,
and Stenhavn are real sites on `doc/map.png` with continuous water between
them. So v1 is one line drawn on your own map:

<!-- MAP: doc/map.png overlay showing the route (attached) -->

- **Aldermark → Edra**: the existing road (~8 km) — or row the spawn river
  in a skiff. No new content needed.
- **Edra ⇄ Brovik ferry** (~3.5 km across the Brosund): the lore's official
  crossing, and the boat-less player's way over.
- **Edra → Stenhavn sail** (~6 km, measured off the map render — the baked
  water field is authoritative): east out of the strait, north up the channel,
  into the Silverbight arm, docking under the **Council of Shipmasters** —
  where the caravel license lives. This single A→B exercises everything the
  system has: open-water sailing, contested water in the strait, and a
  destination that makes Sailing 30 worth the voyage.

A v1 **port** is deliberately just furniture: a dock prop, a shipwright
merchant, a ferry post. Two of them — Edra and Stenhavn — plus the ferry
landing at Brovik. **The towns themselves, and every NPC's name, face, and
personality, are yours** — I'd stub neutral placeholders (a shipwright, a
ferry captain) for you to rewrite or replace, and whether Brovik, Frihavn,
Riftmark, or Mistfall ever get working docks is entirely your call.

**Ferries** are how the boat-less cross: pay a fare at the post, and an
NPC ferry carries you along the fixed route. Ferry captains are
**agent-clients** like every other NPC — they sail with the same protocol
players do, which keeps parity honest and gives the world moving ships that
aren't players. Fares priced like a coin pile or two: travel should be
accessible; *cargo* is where boats earn their keep.

## Cargo & simple trade

- A piloted boat (sloop and up) has a **hold** — a server-side inventory tied
  to the boat, loaded and unloaded only while docked or anchored. Your bag
  and equipment stay yours; the hold is the thing at sea-risk.
- **Cargo is visible** (the ArcheAge lesson): crates stack on the deck as
  the hold fills, so anyone — player or agent — can see who's carrying
  value. Risk stays honest and consensual-by-behavior: pirates chase laden
  boats on sight and let empty ones pass, and "carry nothing, lose nothing"
  is something you can *see*, not just read in a doc.
- **Port trade v1 is intentionally simple**: each port's merchant stocks a
  local commodity cheap and pays over the odds for far ones. The minimum
  route needs only its two ends — Stenhavn sells Havgard furs and ore cheap,
  Edra sells Valdran catalog goods, each paying well for the other's. Buy
  low, sail, sell high; profit scales with distance and hold size. No new
  trade UI — it's the existing merchant flow with per-port price modifiers.
  (Saltisle salt and the rest of the island goods are the expansion, not
  the start.)
- Economy guardrail as a contract test, like fishing's: expected profit per
  hour of sailing stays within a band of the game's income faucets, so a
  route can't become a money printer without failing the suite.

## Piracy & boarding

The lore already says the Brosund crawls with privateers and smugglers — this
makes it true, and it's what makes cargo interesting rather than just a
slower merchant flow.

- **Pirate crews are agent-clients** on sloops/cogs, patrolling contested
  water. They spot a laden boat, give chase (speed matters: a caravel can
  outrun a cog), and if they close, hail: **flee / fight / surrender**.
  - **Flee**: a chase resolved by boat speed, Sailing skill, and a d20 roll —
    escape leaves everyone where they were.
  - **Fight**: grapple → boarding → normal melee combat on the joined decks.
    Win and their boat's hold is yours to loot.
  - **Surrender** (or lose the fight): they take the **hold cargo only** —
    never your bag, never equipment, never the boat. You sail on lighter.
- Risk is opt-in and legible: carry nothing, lose nothing. The **Silverbight
  is patrolled and safe** (Havgard's convoy fleets, per the lore), the
  Brosund is contested, the open Dawnward and Mistward seas are wildest.
  Safe-route-vs-rich-route becomes a real decision.
- Because pirates are ordinary agent-clients, players who want to fight back
  can — and a **Freeblade escort** (the mercenary lore writes itself) is a
  natural hireable-NPC follow-up.
- **PvP piracy**: player-initiated boarding is deliberately a question below,
  not an assumption. v1 works with NPC pirates only.

## PR plan (each shippable, each behind the previous)

1. **Boat movement core** — boat entity, board/disembark, waypoint sailing on
   the water mask, the River Skiff, protocol messages, state-machine tests
   with injected clock/RNG. Rivers and coast become traversable.
2. **Sailing skill + tiers** — second `SkillId`, XP sources, tier gating,
   sloop/cog/caravel deeds + shipwright merchants, the tillerman at the helm
   of every sailed boat.
3. **Ports & ferries** — the two v1 docks (Edra, Stenhavn) + the Brovik
   ferry landing, ferry posts, agent-client ferry captains, fares.
4. **Cargo & port trade** — the hold, per-port pricing, economy contract test.
5. **Piracy & boarding** — intercepts, the three-way hail, boarding combat,
   hold-only loss rule, safe/contested water zones.
6. **Agent-client sailing** — `sail` / `dock` / responses to a hail as LLM
   actions, reflexes local, docs. (Built alongside 1–5; listed separately
   for review.)
7. **Art pass** — boat models and icons per the house pipeline
   (`ART-PIPELINE` workflow: Meshy → Blender → glb), SFX (creaking hull,
   sail snap, gull cries — CC0 like the fishing set).

## v2 ideas (not built — asking first)

- **Naming your boat**, visible to other players (pure flavor, pure joy).
- **SOS wrecks** — upgrade fishing's Message in a Bottle from a 15c token to
  a chance of carrying wreck coordinates: sail there, anchor, and fish up
  salvage from the deep. Wreckisle's reef graveyard finally pays out, and
  fishing and sailing start feeding each other through one item change.
- **A sea serpent** in deep water — the existing monster/combat system,
  spawned at sea. Gives the Mistward fog something to hide.
- **Fishing from a deck** — deep-water species only reachable by boat; the
  `WaterSampler` already knows depth.
- **Circumnavigation** — the world is a cylinder; the first player to sail
  east and arrive from the west deserves a `ServerNotice`. Cheap and very
  much in the spirit of the colony-NPC lore.
- **Convoy escorts** — hire a Freeblade agent to sail with you.
- **Weather/wind** affecting speed — flagged early because it tempts real-time
  steering, which would break the parity contract; I'd only do it as route
  modifiers.

## Questions before I build

1. **Scope check** — four systems is a lot even staged. If you want a subset,
   my cut order is: piracy last, trade before ferries, sailing always. Which
   pieces do you actually want?
2. **Piracy at all?** Hold-only loss is designed to be the gentlest possible
   theft, but it's still theft — happy to ship trade with safe seas only and
   leave pirates behind a config flag or drop them entirely.
3. **PvP boarding** — should players ever be able to initiate against
   players, or is piracy NPC-only? (My default: NPC-only v1.)
4. **Port placement** — v1 adds dock props only at Edra and Stenhavn (your
   map's own sites), hand-placed via the map editor. Right call, or would you
   rather ports come out of worldgen's settlement pass?
5. **Boat persistence** — my plan is UO-style **deeds**: dry-dock to an item
   in your bag, place at water's edge to launch, one hull afloat per player.
   Rides the existing item system, leaves no abandoned hulls in harbors. OK —
   and is owning multiple deeds fine (they're just items), or cap ownership
   too?
6. **Towns & NPCs are yours** — this route puts the first working content in
   Edra and Stenhavn. I'd ship neutral placeholder NPCs (a shipwright, a
   ferry captain) and let you name, characterize, and re-dress them and the
   towns however you want — or hold the PR until you've written them. Which
   do you prefer?
7. **Pricing** — bands above anchored to the same faucets as fishing; any
   targets you'd set differently?

If the direction looks right I'll start with PR 1 — happy to adjust anything,
including cutting whole systems from the plan.
