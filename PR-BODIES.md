# Ready-to-paste PR bodies

One per stacked PR, in merge order. Each leads with agent parity or the
project principle it serves, then the mechanics, then the evidence.

**Before pasting:** capture the media marked `<!-- GIF -->` / `<!-- SHOT -->`.
Drag the file straight into the GitHub comment box and it uploads — no need to
commit it to the repo. Delete any placeholder you don't fill.

Recording a GIF on Windows: **Win+G** (Xbox Game Bar) or ScreenToGif
(free) → 10–15 s, 800px wide is plenty. Trim hard; a reviewer watches ~5 s.

Sign the CLA by commenting on your first PR, exactly:
`I have read the CLA Document and I hereby sign the CLA`

---

## PR 1 — `fishing/pr1-skills`

**Title:** Add trained-skill foundation (SkillId, persistence, SkillsUpdate)

Groundwork for gathering professions, starting with the one this series adds
next. Invisible in-game until something grants skill XP, so it can merge
safely on its own.

- `shared/skills.rs` — `SkillId` (just `fishing` today), `SkillProgress { level, xp }`, curve `100·level²`, cap 20. The curve is exported through `wasm_api`, so a client progress bar can't drift from the server's maths.
- Persistence — additive `character_skills` table; missing rows simply read as level 0, so existing characters need no migration. It rides the existing dirty-set `save_batch`, using an **upsert** rather than delete+insert so rows written by a newer server survive a rollback.
- Protocol — `SkillsUpdate` (full map on EnterGame) and `SkillXpGained` (mirroring `XpGained`), both **direct** messages. Skills stay out of the broadcast `Player` struct, same as gold.
- Client — a Skills section in `CharacterPanel`, hidden while empty.

Tests cover the DB round-trip, XP-grant → direct message → dirty flush, and
logout detach.

<!-- SHOT: character panel showing the Skills section with Fishing -->

---

## PR 2 — `fishing/pr2-core`

**Title:** Add fishing: cast, bite, hook, catch (core loop)

**Built for agent parity first.** Every decision point is broadcast rather than
hidden: the bite carries everything needed to respond, and the 2.5 s window
plus 0.5 s latency grace is sized for a network round trip, not human
reflexes. An agent and a person have identical information and identical time.

Equip a rod → click water within 8 m → bobber lands → 4–12 s wait → bite →
`Hook` in time or lose it. Every timer, roll and outcome is server-side; the
client only renders and responds. Moving, attacking, dying or disconnecting
aborts the session.

- Water is real depth at the cast point (`waterSurface − terrainBed > 0.1 m`), sampled server-side.
- Fish are ordinary stackable item defs with weighted catch tables — sellable through the existing merchant flow, edible via the category-derived use-effect, exactly like potions.
- Trophy size rides the outcome message only, so fish stay stackable and `ItemInstance` is untouched.
- Timers run on the existing 250 ms tick, so there are no per-session tasks to cancel across abort paths.

The state machine is tested with paused time and injected RNG, so the whole
loop runs deterministically in milliseconds.

<!-- GIF: cast → bobber lands → bite → hook → fish in bag -->

---

## PR 3 — `fishing/pr3-struggle`

**Title:** Add the fishing struggle: tension rounds between hook and catch

Hooking is the start, not the end. The fish fights for `2 + rarity` rounds;
each round the server announces its state — **Pulling** (give line) or
**Tiring** (reel) — and a tension meter climbs on wrong or late answers. At
100 the line snaps.

**The announced state is public information by design.** The challenge is
answering correctly in time, not guessing hidden state — which is what keeps a
human reading the prompt and an agent auto-answering on equal footing. Instant
reflexes confer no advantage: correctness is binary and the tension maths
ignores response speed inside the window.

Trophy catches are announced to everyone in delivery radius, so the river feels
shared.

<!-- GIF: the struggle — tension bar climbing, Pulling/Tiring prompts, landing it -->

---

## PR 4 — `fishing/pr4-agent`

**Title:** Agent-client fishing: auto-reflexes + fish/stop_fishing actions

The other half of parity. The agent-client answers bites and struggle rounds
as a **reflex layer** — the same precedent as its built-in A* pathfinding —
while the LLM makes the decisions through two plain actions:

```json
{"type": "fish", "x": 10.0, "z": -5.0}
{"type": "stop_fishing"}
```

Coordinates are optional; omitted means "just ahead of you". In-flight
messages are classified as noise so they cost no LLM calls — only outcomes
reach the model, as `[Fishing]` events worded to say what the agent can do
next (a fish is edible and sellable; junk is not).

Nothing here depends on the MCP layer removed in "Drop the rmcp dependency".
`data/system_prompt.txt` documents the actions, without which an agent would
never discover fishing exists.

<!-- SHOT: agent-client log showing a full catch, or the spectator panel -->

---

## PR 5 — `fishing/pr5-rivers`

**Title:** Fix river fishing: detect water via the unified water field

A correctness fix on PR2's water test. My first cut used `terrain height < 0`,
which only recognises the ocean — river beds bottom out at sea level and then
climb with the terrain, so **every inland river read as dry land**.

This adds a server-side `terrain::WaterSampler` over the baked unified water
field (WFD1), sitting beside the existing `HeightSampler`, and tests real
depth instead. Ocean and rivers both fish; dry ground still refuses. Tiles
with no baked water file degrade to flat sea level, matching what the client
synthesises.

Verified live: ocean catch, river catch over a bed 5 m above sea level, and
land correctly refused.

<!-- SHOT: standing on a river bank mid-cast, well inland -->

---

## PR 6 — `fishing/pr6-fish-icons`

**Title:** Add distinct icon art for each fish

The five species shared `sword.png` as a placeholder. Each now has its own
128×128 icon.

<!-- SHOT: inventory with all five fish -->

*(Provenance and licence recorded in `doc/assets/items.md`, matching the
existing entries.)*

---

## PR 7 — `fishing/pr7-rod`

**Title:** Make the fishing rod obtainable, and give it its own icon

The rod existed but nothing sold it. Rica now stocks it for 3 silver, and it's
explicitly excluded from the dungeon-chest loot pool — it's a bought tool, not
endgame combat treasure.

Prices are anchored to the game's **income** economy rather than the catalogue:
monster kills drop unsellable worn weapons by design, so the repeatable faucets
are coin piles and gated chests, and a guard earns 50s/day. A catch is worth a
couple of coin piles; an hour of active fishing earns roughly half a guard's
daily wage. Steady pocket money, not a money printer.

<!-- SHOT: Rica's shop with the rod listed -->

---

## PR 8 — `fishing/pr8-flotsam`

**Title:** Add flotsam catches: junk, a bottle, and a sunken coin pouch

Not everything that bites is a fish. About one cast in seven pulls up an Old
Boot, a Clump of Kelp, a Message in a Bottle, or a Sunken Coin Pouch — the last
being a new `coin_catch` category whose dice column is a copper roll paid
straight to the wallet, never entering the bag.

All are rarity 0: no skill XP, no trophies, and in the struggle they fight like
a common fish.

**The economy guardrail is now a test.** The weighted expected *sell* value of
one catch must stay inside the 5–25c coin-pile band (it's ~16c today). A future
species or treasure row that turns fishing into a money printer fails the suite
rather than shipping.

<!-- SHOT: the four flotsam icons, or the gold toast from a coin pouch -->

---

## PR 9 — `fishing/pr9-hardening`

**Title:** Harden fishing: death/rod-loss aborts, concurrency + boundary tests

Writing the test net turned up two real holes, both fixed here:

- **Death didn't stop fishing** — a player killed mid-cast kept their session running and could land a fish while defeated. There's now a single `on_player_died` chokepoint so future death sources can't forget a side effect.
- **Losing the rod didn't stop fishing** — the rod was only checked at cast, so you could unequip, weapon-swap or *drop* it and keep fishing bare-handed. All three paths now abort; gear changes that leave the rod in hand deliberately don't.

New coverage: two anglers fishing simultaneously stay fully independent;
broadcasts assert per-message-kind inside the delivery radius and silence
outside it; late-hook, stop-mid-struggle, double-cast and defeated-cast
boundaries; a full bag spills the catch as a pickable ground item rather than
losing it; eating a catch heals.

Both behaviour fixes are **mutation-tested** — reverting either one makes
exactly its new test fail, so the wiring is locked rather than just the
helpers.
