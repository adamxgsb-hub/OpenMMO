# The single-PR body

Paste this as the PR description when opening `fishing/complete` against
`Julian-adv/OpenMMO:master` from the true fork. Replace the `<!-- GIF -->` /
`<!-- SHOT -->` markers with real captures before posting (a 10–20 s catch GIF
is the one thing that sells the whole PR — record it before anything else).

Title:

```
Add fishing: trained skills, catch loop, struggle minigame, agent parity
```

Body:

---

Implements the fishing system proposed in the design issue — built the OpenMMO
way: server-authoritative, agent-playable over the same protocol as humans,
and economy-safe by contract test.

<!-- GIF: casting at the spawn river → bite → struggle panel → catch lands in bag -->

## Agent parity, by construction

Every decision point is **broadcast, not hidden**. The bite and each struggle
round carry the fish's state (*Pulling* / *Tiring*) — exactly what the human
UI renders — so an agent reads the same information a person does. Response
windows (2.5 s bite, 1.8–3 s per round, +0.5 s latency grace) are sized for a
network round trip, not human reflexes, and correctness is binary: answering
faster confers nothing. A bot and a person fish equally well.

The agent-client answers the reflex layer locally (the A* pathfinding
precedent) while the LLM decides through two plain actions:
`{"type": "fish", "x": …, "z": …}` and `{"type": "stop_fishing"}`. In-flight
messages are classified as noise — only outcomes reach the model, so fishing
costs no extra LLM calls.

## What's in the box

- **Trained skills foundation** — `shared/skills.rs` (`SkillId`,
  `SkillProgress`, curve `100·level²`, cap 20), additive `character_skills`
  table riding the existing dirty-set flush (upsert, no migration risk),
  protocol `SkillsUpdate` + `SkillXpGained` direct messages, Skills section in
  the character panel. Fishing grants **skill XP only** — character XP and
  combat balance untouched.
- **The loop** — equip rod → click water within 8 m → bobber, 4–12 s wait →
  bite (2.5 s to hook) → 3+ struggle rounds (respond per the fish's state;
  wrong/late raises tension, 100 snaps the line) → catch stacks into the bag.
  Moving, attacking, trading, dying, or losing the rod (unequip/swap/drop)
  reels the line in. All timers server-side; the client renders and responds.
- **Water = the baked water field** (WFD1 sea + rivers) via a new
  `terrain::WaterSampler`: fishable where `waterSurface − terrainBed > 0.1 m`.
  (A `terrain height < 0` check only matches the ocean — river beds sit above
  sea level. Verified live in both: ocean catch, river catch at +5 m bed.)
- **Five fish** suited to Dulunar's temperate waters (minnow → golden
  sturgeon), stackable, sellable through the existing merchant flow, edible
  via the category-derived heal (potion idiom). d20 quality roll on the catch;
  nat 20 doubles size → trophy `ServerNotice`. Trophy size is
  announcement-only so fish keep stacking — no `ItemInstance` changes.
- **Flotsam** (~15 % of casts): Old Boot, Clump of Kelp (gag junk), Message
  in a Bottle (15c token), Sunken Coin Pouch (3d8 copper straight to the
  wallet via the coin-pile flow). Rarity 0 — no XP, no trophies.
- **Economy guardrail as a test** — prices anchored to existing income
  faucets; a contract test locks per-catch expected sell value to the 5–25c
  coin-pile band (~16c today, flotsam included). A future species that turns
  fishing into a money printer fails the suite.
- **Rod obtainable** — sold by Rica (3 s), excluded from dungeon-chest loot
  (tested), own icon.
- **Art** — 10 hand-made 128×128 icons (concept renders archived in
  `doc/images/`, credited in `doc/assets/items.md`, same pipeline as the
  project's other items).

<!-- SHOT: inventory with the fish + flotsam icons -->
<!-- SHOT: character panel with the Fishing skill bar -->

## Protocol & compatibility

- `PROTOCOL_VERSION` → 8 (6 skills, 7 fishing core, 8 struggle), per the
  bump-on-additive-variant comment in `shared/lib.rs`.
- DB changes are additive only (`character_skills` table; missing rows =
  level 0). Existing characters and saves unaffected.
- `doc/FISHING.md` documents the mechanic, tuning constants, and the
  deliberately deferred v2 lines (bait, rod tiers, hot-spots).

## Tests

512 server/shared tests + 290 client tests green, including: state-machine
transitions under an injected paused clock, weighted-table distribution,
tension math (all-wrong play always loses within the round count), death and
rod-loss aborts (found by test-writing — `drop_item` was a real hole),
two-angler concurrency, broadcast radius, stop/late-hook boundaries,
bag-overflow spill, eat-a-fish healing, and the economy EV contract above.
Key wiring is mutation-tested (reverting the hook makes the test fail).

Happy to split this into the original 9-PR stack instead if that reviews
easier — the branch history is already structured that way, one feature slice
per commit.

---

*(sign the CLA by commenting as instructed by the bot; the allowlist already
covers Claude co-author trailers)*
