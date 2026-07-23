# Proposal: Fishing (first trained skill / gathering profession)

Hi! I run [MMOlist](https://mmolist.com), an MMORPG database site, and I'd love to
contribute a complete feature to OpenMMO: **fishing**, built the OpenMMO way —
server-authoritative, agent-playable through the same protocol as humans, and split into
small reviewable PRs. I have a working implementation of the first slice already and
wanted to get your read on the design before opening PRs. (Development is AI-assisted
with Claude, matching the project's own workflow; everything is human-reviewed and tested
before it reaches you.)

## The loop

Equip a **fishing rod** (main-hand item) → click water within 8 m → bobber lands, random
4–12 s wait → **bite** (bobber dips; 2.5 s + latency grace to hook) → a short **struggle**:
3+ rounds where the server announces the fish's state — *Pulling* (correct: give line) or
*Tiring* (correct: reel) — each with a 1.8–3 s response window. Wrong/late responses raise
a tension meter; tension ≥ 100 loses the fish; surviving all rounds catches it. Moving,
attacking, trading, or disconnecting aborts. Every timer and outcome is server-side; the
client only renders and responds.

- **Water** = terrain height < 0 at the cast point (sea level per `doc/WATER_SYSTEM.md`),
  sampled server-side via the `terrain` crate's `HeightSampler` — the server's first
  gameplay use of water, no new data needed.
- **Fish** are five stackable items in `data-src/items.csv` (minnow → golden carp) with
  weighted catch tables: sellable through the existing merchant flow, edible via the
  category-derived use-effect (heal dice, like potions). Catch rolls reuse the d20 idiom
  from `game/combat.rs` (a nat-20 quality roll doubles size → trophy + `ServerNotice`).
  Trophy size stays ephemeral (announcement only) so fish keep stacking — no
  `ItemInstance` changes.
- **Agent parity by construction:** the struggle broadcast carries the fish state — the
  same information the human UI renders — so the agent-client can auto-respond locally
  (like its built-in A* pathfinding) while the LLM decides where/when to fish. Planned MCP
  tools: `fish()` / `stop_fishing()`.

## Trained skills (the part I most want your buy-in on)

Fishing wants progression, and there's no skill system yet — so the first PR adds a
minimal one, designed to stay small but leave room for future gathering professions:

- `shared/skills.rs`: `SkillId` (just `fishing` for now), `SkillProgress { level, xp }`,
  curve `100·level²` per level, **cap 20** (the d20 ceiling, deliberately unlike the
  character curve). Curve exported through `wasm_api` so client bars can't drift.
- Persistence: additive `character_skills` table (missing rows = level 0), riding the
  existing dirty-set `save_batch` — with an **upsert** instead of delete+insert so rows a
  newer server wrote survive a rollback. No migration risk for existing characters.
- Protocol v3: `SkillsUpdate` (full map on EnterGame) + `SkillXpGained` (mirror of
  `XpGained`), both direct messages — skills stay out of the broadcast `Player`, like gold.
- Skill effects on fishing: shorter waits, slightly wider struggle windows, better rare
  weights. Fishing grants **skill XP only** — character XP/combat balance untouched.

## PR plan (each shippable, each behind the previous)

1. **Skill foundation** — everything above; invisible in-game until something grants
   skill XP. *(Implemented: 16 files, +842, unit/integration tests green — DB round-trip,
   XP-grant → direct message → dirty flush, logout detach.)*
2. **Core fishing loop** — protocol messages, cast/wait/bite/hook → catch (single round),
   rod + fish items, water check, minimal UI + bobber, `doc/FISHING.md`, state-machine
   tests with injected clock/RNG.
3. **Struggle + polish** — multi-round tension minigame, trophy roll + notice, SFX.
4. **Agent-client** — reflex layer + MCP tools + docs.

## Questions before I open PRs

1. **Skill system shape** — happy with a `HashMap<SkillId, SkillProgress>` on its own
   table, cap 20, `100·level²`? Anything you'd change while it's still one skill deep?
2. **Where can players fish?** Anywhere terrain < 0 (sea + lakes + rivers), or would you
   rather gate it to designated spots?
3. **Protocol:** I bumped `PROTOCOL_VERSION` per the comment in `shared/lib.rs` — right
   call for additive `ServerMessage` variants?
4. **Trophy size as announcement-only** (fish stay stackable) — acceptable, or would you
   want per-instance size stored?
5. **Assets:** planning Mixamo clips for cast/idle (v1 reuses existing clips), CC0 SFX,
   AI-generated icons like the rest of the project — any licensing constraints under
   PolyForm Noncommercial I should know about?
6. **Docs language:** `doc/FISHING.md` in English like the rest of `doc/`?

If the direction looks right I'll open PR 1 immediately — happy to adjust anything.
