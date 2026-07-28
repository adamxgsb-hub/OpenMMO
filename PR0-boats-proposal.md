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

Five pieces, each a separate PR stage, each useful without the next:

1. **Sailing** — pilot a boat across real water; a Sailing trained skill.
2. **Ports & ferries** — named harbors; pay a fare to cross without a boat.
3. **Cargo & port trade** — a hold, and per-port prices worth sailing for.
4. **Piracy & boarding** — agent-crewed pirates who can stop you and take
   what's in the hold — and only what's in the hold. Or be talked out of it.
5. **Tides** — the two moons pulling the sea on a schedule anyone can learn.

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
  choice: flee / fight / surrender / parley), sized for a network round trip
  like the fishing bite. No outcome depends on reaction speed.
- **Parley is parity's showcase**: the hail happens in chat and the pirate
  is an LLM, so a human trader and an agent trader negotiate the same way —
  in words. The server enforces whatever is agreed (an accepted toll moves
  real hold items; a failed bluff resumes the chase), so the model roleplays
  but can't cheat physics.
- Boarding resolves through the **existing combat system** on a stationary
  deck — no new combat mechanics for agents to learn.

## Boats (four tiers, Sailing-skill gated)

Following the fishing unlock ladder (salmon at 10, sturgeon at 20), tiers gate
on the Sailing skill, and each tier's identity comes from the worldbuilding:

<!-- IMAGE: proposal-assets/boat-tiers.png — the four tiers, side profiles,
     with the real Nordic reference vessels for the art pass -->

| Boat | Lore | Skill | Speed | Hold | Acquired |
|---|---|---|---|---|---|
| **River Skiff** | The flat-bottomed rowboat every Dulunar riverbank knows; Aldermark's carpenter knocks them together from Gray Plains timber | — | slow | none | Cheap at any port or the starting town (fishing-rod-priced: a new player can own one day one) |
| **Gullwing Sloop** | Single-sail coastal boat named for Gullisle's wheeling seabirds; the fisherman's and smuggler's favorite | 10 | fast | small | Sold by port shipwrights |
| **Brosund Cog** | The broad-beamed workhorse of the Brovik–Edra strait trade; most of Duluna's legitimate cargo crosses in one | 20 | medium — slow when laden | large | **Commissioned** at the strait yards (Brovik, Edra) — see below |
| **Silverbight Caravel** | Havgard's shipwrights are the finest in the world, and this is why; fast, tall-masted, built in Stenhavn's cliff yards | 30 | fastest | large | **Commissioned in Stenhavn only**, under a Council of Shipmasters license — see below |

The skiff is deliberately the rod of this system: no skill gate (anyone can
row), cheap enough that the feature is for everyone, day one — every Sailing
level thereafter is earned at your own tiller. The caravel is deliberately
the sturgeon: it tops out at the skill cap (30), you earn the right to buy
it, and buying it requires having crossed the sea already. Working price bands,
anchored to the income faucets (a coin pile is 5–25c, a guard earns 50s a
day, dungeon gear starts ≈20s, the rod is 3s):

- **Skiff ≈ 2–3s** — rod-priced, day one.
- **Sloop ≈ 50s** — a guard's full day's wage: the first purchase that
  stings, a small achievement in itself.
- **Cog ≈ 200s at the yard, ~300s all-in** — the two material loads cost
  real coin at their sources and cross pirate water, so part of the price
  is risk, not just gold.
- **Caravel ≈ 600s at the yard, ~1,000s all-in** — three loads plus the
  license record: weeks of trading, priced like the flagship it is.

The guardrail is payback expressed in the boat's own earnings — a cog
should pay for itself in roughly **ten trading hours**, a caravel in
roughly **thirty** — pinned by the same economy contract test, so
"significant" stays true even if the income faucets are later rebalanced.
All of it calibration, not design; I'll tune to whatever you think.

**The speed ladder is deliberately not straight**: the sloop is *faster*
than the cog. Stepping up to the cog trades speed for cargo — and marks you
as prey, since pirates fly sloops precisely because a laden cog can't shake
one. The caravel is the prize because it's the only hull that is both fast
and full: it outruns the wolves while carrying the fortune.

**Commissioning, not shopping** (cog and caravel): the big hulls cost more
than gold, but there is no ship-part grind — the build materials are
ordinary trade goods, and **each is sold only at its source**, so acquiring
them is a voyage in itself, hauled to the yard as real, visible deck cargo:

- **Valdran oak** — sold only in Valdran's timber country, then sailed
  north through the contested strait.
- **Clan iron** — the mountain clans' ore, sold only where they bring it
  down to Havgard's coast (the lore already says the clans feed the ports).

The Brovik or Edra yard lays a cog's keel once you've delivered two loads
(oak + iron) to its dock and kept **five sealed contracts** — in Havgard,
your ledger is your character reference. The caravel's Council license
reads a sailor's whole record: **first dockings at ten named harbors,
twelve contracts kept unbroken**, and three source-bound loads delivered to
Stenhavn's cliff yard. Crafting cost *is* trade gameplay: every component
crosses pirate water and can be stolen off your deck on the way. By levels
20 and 30 most of this record exists naturally — the feats formalize the
journey rather than lengthen it.

Deliberately **not** in this proposal: harvesting the materials yourself.
That's a gathering-professions system (Woodcutting, Mining — new `SkillId`s
on the same foundation), and it deserves its own proposal rather than
riding in a boats PR. The seam is designed, though: the material items
exist from day one, so a future gathering PR can add a harvest path to the
same ids — fell the oak yourself instead of buying it, cheaper but slower.
Boats create the demand; gathering, if you want it later, supplies it.

A boat is owned as a **deed** (the Ultima Online pattern): place it at a dock
or shore to launch, dry-dock it back into a rolled deed in your bag when
done. No abandoned hulls silting up Edra's harbor, no lost-boat support
burden, and persistence rides the existing item system instead of a new
table. One hull afloat per player at a time.

A boat also carries **crew**: other players can step aboard and ride your
deck — positions attached to the hull, swords very much their own when
boarders come over the rail. This is deliberately boat-local and *not* a
party system (that's your own TODO line, left untouched) — but it makes a
trade run something friends do together.

**Sailing skill**: second `SkillId` on the system fishing added — same
`100·level²` curve, same cap 30, same UI. XP sources and what they pay:
**150 XP/km under way**, **+500** per voyage (docking ≥2 km out), **+2,000**
the first time you ever dock at each named port or island (~20 sites — a
one-time ~40k discovery pool), **+2,000** per sealed contract delivered,
**+750** for surviving a pirate encounter. In practice: an Edra→Stenhavn run
pays ~1,400 XP (~3,400 with a contract), so an active trader earns roughly
9k XP/hour.

Against the curve (38.5k / 287k / 945.5k cumulative to levels 10/20/30),
the gates land where I want them to *feel*: the **sloop** is earned by
exploring — the discovery pool alone nearly funds level 10; the **cog** is
a mid-term achievement (~30 hours of strait trading — whoever docks one has
run the Brosund for weeks); the **caravel** is prestige, ~100 trading hours
with the final level alone costing 90k — which is what a license from the
Council of Shipmasters *should* cost. That pace is consistent with (in fact
slightly faster than) fishing's own road to 30. If playtesting says 30
feels punishing, the levers are the contract and distance rates, never the
curve — it's shared with fishing and shouldn't fork — and a contract test
pins the hours-to-gate bands the same way the economy test pins profit.

## Ports & the minimum route

Your map has already placed everything this needs — Aldermark, Edra, Brovik,
and Stenhavn are real sites on `doc/map.png` with continuous water between
them. So v1 is one line drawn on your own map:

<!-- IMAGE: proposal-assets/route-min.png — the v1 route drawn on doc/map.png
     (proposal-assets/route-world.png for full-world context) -->

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
- **Sealed contracts** (straight from the lore: "ledgers and sealed oaths
  are law"): port notice boards post delivery runs — these goods, that port,
  a deadline, a bonus for arriving under seal. Lose the seal to pirates and
  the notice board remembers. Trade gains a verb beyond arbitrage, and
  pirates gain targets worth bragging about.
- Economy guardrail as a contract test, like fishing's: expected profit per
  hour of sailing stays within a band of the game's income faucets, so a
  route can't become a money printer without failing the suite.

## Tides (the two moons, working)

Duluna has two moons — Eldor and Serin — and your tavern astronomers already
argue about how they move. Tides make the argument *matter*: the water
surface rises and falls on a deterministic schedule (two summed sine waves
over the existing synced game clock), applied as a single offset inside the
`WaterSampler` that every water query already passes through.

- **High tide** opens the shallow ways — reef passages (Wreckisle's ring)
  and river mouths a cog only clears when Eldor stands high.
- **Low tide** bares the flats — shortcuts and salvage grounds for a
  skiff's draft only.
- A **tide table is knowledge, not reflexes**: the schedule is exact and
  forecastable, the client displays it, agents compute it — parity by
  construction. And it makes the two moons *gameplay*, which I don't know
  of any MMO ever doing with a real orbital schedule.
- Amplitude stays bounded so no dock or ferry route ever strands — pinned
  by a contract test, like the economy band.

<!-- IMAGE: proposal-assets/tide-chart.png — one day of the two-moon tide
     schedule with the high/low gameplay thresholds -->

## Piracy & boarding

The lore already says the Brosund crawls with privateers and smugglers — this
makes it true, and it's what makes cargo interesting rather than just a
slower merchant flow.

- **Pirate crews are agent-clients** on sloops/cogs, patrolling contested
  water. They spot a laden boat, give chase (speed matters: sloops outpace
  a laden cog — which is why pirates fly them — and a caravel outruns
  everything), and if they close, hail:
  **flee / fight / surrender / parley**.
  - **Flee**: a chase resolved by boat speed, Sailing skill, and a d20 roll —
    escape leaves everyone where they were.
  - **Fight**: grapple → boarding → normal melee combat on the joined decks,
    your crew fighting beside you. Win and their hold is yours to loot.
  - **Surrender** (or lose the fight): they take the **hold cargo only** —
    never your bag, never equipment, never the boat. You sail on lighter.
  - **Parley**: the pirate is an LLM and the hail is a chat window — so
    *talk*. Bluff an escort over the horizon, plead a hold full of
    worthless kelp, or haggle a toll ("half my cargo and you never saw me")
    through the same offer machinery the merchants already use. The captain
    decides in character; the server enforces the bargain — an accepted
    toll moves real crates, a failed bluff resumes the chase. I don't think
    any MMO has ever shipped this, because no other MMO's pirates can
    actually be reasoned with.

<!-- IMAGE: proposal-assets/hail-panel.png — mockup of the four-way hail
     panel (FishingPanel pattern) -->
<!-- IMAGE: proposal-assets/parley-chat.png — mockup of a parley: the
     captain remembers a past encounter; the toll is server-enforced -->

- **Captains, not mobs**: pirate crews are led by *named* captains, and the
  agent memory system already persists NPC memories across sessions — so
  the captain who took your kelp last week remembers, and the one you
  bluffed once won't fall for it twice. Reputation on the Brosund emerges
  from actual memories, not a faction meter.
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

1. **Boat movement core** — boat entity, board/disembark for pilot *and*
   passengers, waypoint sailing on the water mask, the River Skiff, protocol
   messages, state-machine tests with injected clock/RNG. Rivers and coast
   become traversable.
2. **Sailing skill + tiers** — second `SkillId`, XP sources, tier gating,
   sloop/cog/caravel deeds + shipwright merchants, the tillerman at the helm
   of every sailed boat.
3. **Ports & ferries** — the two v1 docks (Edra, Stenhavn) + the Brovik
   ferry landing, ferry posts, agent-client ferry captains, fares.
4. **Cargo & port trade** — the hold, visible deck crates, per-port pricing,
   sealed contracts, economy contract test.
5. **Piracy & boarding** — intercepts, the four-way hail (flee / fight /
   surrender / parley), named captains with persistent memory, boarding
   combat, hold-only loss rule, safe/contested water zones.
6. **Tides** — the two-moon schedule, the `WaterSampler` offset, tide table
   in the client + computable by agents, the no-stranding contract test.
7. **Agent-client sailing** — `sail` / `dock` / responses to a hail
   (including parley in chat) as LLM actions, reflexes local, docs. (Built
   alongside 1–6; listed separately for review.)
8. **Art pass** — boat models and icons per the house pipeline
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
- **Relic smuggling** — the lore's central conflict (the Eye of Garath wants
  every relic registered; Havgard's markets sell them openly) as gameplay:
  run dungeon relics past Edra's inspectors to Stenhavn's stalls. It would
  connect dungeons → sea trade → factions — but it's the beating heart of
  your worldbuilding, so it's yours to green-light or veto outright.
- **A ship's log** — a journal of first dockings and discoveries across the
  fifteen named islands; pairs naturally with the first-docking XP.
- **A ghost ship** in the Mistward fog, beside the sea serpent.
- **Sailing music** — the "Blood and Bronze (1) during combat" precedent
  suggests the sails filling deserves a tune of their own.
- **Weather/wind** affecting speed — flagged early because it tempts real-time
  steering, which would break the parity contract; I'd only do it as route
  modifiers.

## Questions before I build

1. **Scope check** — five systems is a lot even staged. If you want a
   subset, my cut order is: tides first to go, then piracy, trade before
   ferries, sailing always. Which pieces do you actually want?
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
7. **Pricing** — bands above anchored to the same faucets as fishing, and
   the commissioning requirements (loads hauled, contracts kept, harbors
   visited) are tunable the same way; any targets you'd set differently?
8. **Parley stakes** — comfortable with LLM captains negotiating over real
   cargo? Every outcome is server-enforced and capped at the hold (the same
   hold-only rule), but the words are a model's — happy to gate parley
   behind a config flag if you'd rather watch it in the wild first.
9. **Tides** — yes or no on the world-sim itself; and if yes, amplitude
   bounds you're comfortable with (the contract test pins "no dock or ferry
   route ever strands").

If the direction looks right I'll start with PR 1 — happy to adjust anything,
including cutting whole systems from the plan.
