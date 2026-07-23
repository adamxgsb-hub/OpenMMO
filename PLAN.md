# Fishing system for OpenMMO (Julian-adv/OpenMMO)

## Context

The user wants to collaborate with Jake Song's OpenMMO (source-available browser MMO: Rust/Tokio server, Svelte+Threlte client, MessagePack-over-WebSocket protocol, agent–human parity as the core design rule) by contributing a **fishing system**. They will fork the repo into their own GitHub account and develop there, targeting upstream PRs (the maintainer merges outside gameplay PRs regularly; license is PolyForm Noncommercial — fine for a hobby contribution, no commercial use).

Chosen design (user decisions): **cast + bite window with an ArcheAge-style struggle minigame**, fish that are **sellable, edible, and have rarity tiers/trophies**, and a **new per-character skill subsystem** with Fishing as its first skill. Agent parity is non-negotiable: LLM agents must be able to fish via the same protocol, with the reflex layer handled locally by the agent-client (same precedent as its built-in A* pathfinding).

Design was verified against the live repo (`master` branch) — key ground truths:
- Protocol = Rust enums `ClientMessage`/`ServerMessage` in `shared/src/messages.rs`, MessagePack (rmp-serde), reaching the TS client via `shared/src/wasm_api.rs` WASM bindings + hand-mirrored types in `client/src/lib/network/networkTypes.ts`.
- `data/items.json` is **generated** — new items go in `data-src/items.csv` (naive `split(',')` parser: no commas in fields; empty cells omitted; has an `icon` column, placeholder icons precedented).
- `UseEffect` is derived from item `category` in `server/src/item_defs.rs::use_effect()` — edible fish is one new match arm, no new enum variant.
- Server has **no water awareness** today; sea level is fixed Y=0 and `terrain/src/height.rs::HeightSampler::sample_height(x,z)` (async, tile-cached) enables "is this point water" = height < 0.
- No skill system exists; `Character` uses `#[serde(default)]` for backward-compat fields (the `gender` pattern to copy). SQLite persistence via additive `CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` in `server/src/auth.rs`; dirty-set flush in `save_batch` (DELETE+INSERT per character, one transaction).

## Setup (step 0)

- User forks `Julian-adv/OpenMMO` to their GitHub account; add the fork to a session via `add_repo`; clone; branch per PR below.
- Dev loop per repo README: `cargo watch` on server/shared/data-src; client on :10004; `npm run build:wasm` (or the documented `cargo watch -w shared -s 'npm run build:wasm --prefix client'`) whenever shared types change. Server WS :10006.

## Protocol (new shared types)

New `shared/src/fishing.rs`:
```rust
pub enum FishingAction { Hook, Reel, GiveLine }
pub enum FishState { Pulling, Tiring }   // Pulling → correct = GiveLine; Tiring → correct = Reel
pub enum FishingOutcome { Caught { item_def_id: String, size_cm: u16, trophy: bool }, Escaped, Aborted }
pub const MAX_CAST_DISTANCE: f32 = 8.0;
pub const BITE_WINDOW_MS: u32 = 2_500;
pub const STRUGGLE_BASE_WINDOW_MS: u32 = 3_000;  // generous: agent/human parity
pub const STRUGGLE_MIN_WINDOW_MS: u32 = 1_800;
pub const LATENCY_GRACE_MS: u32 = 500;
```

`ClientMessage` additions: `FishingCast { position }`, `FishingRespond { action }`, `FishingStop`.
`ServerMessage` additions: `FishingCasted { player_id, position }` (broadcast — others see the bobber), `FishingBite { player_id }`, `FishingStruggleRound { player_id, round, total_rounds, fish_state, respond_within_ms, tension_pct }` (broadcast; carries everything needed to respond — parity by construction), `FishingRoundResult { player_id, correct, tension_pct }`, `FishingEnded { player_id, outcome }`, `FishingError { message }` (direct, mirrors `InventoryError`). Skill PR adds direct `SkillsUpdate { skills }` + `SkillXpGained { skill, xp_amount, new_level, leveled_up }` (mirrors `XpGained`).

Caught fish arrive via existing `InventoryUpdated`; trophy announcements reuse existing `ServerNotice`.

**State machine** (server-authoritative, all timers server-side `Instant`s):
Cast (validate: rod in MainHand, target ≤8 m, terrain height < 0, not dead/trading; ≥1 s rate limit) → Casting 1 s → Waiting rand 4–12 s (skill shortens ~2%/level, floor 3 s) → Bite (must `Hook` within 2 500 ms + grace, else Escaped) → Struggle: rounds = 3 + rarity tier; each round server rolls `FishState`; window = clamp(3000 − 150·rarity + 60·skill, 1800, 3000); correct → tension −10, wrong/timeout → tension +30+5·rarity; tension ≥100 → Escaped; all rounds survived → Caught → skill XP, item to bag (weight-check; overflow drops as GroundItem). Species rolled at Bite, revealed on Caught. Any `PlayerMove`/`PlayerAttack`/shop/interact/disconnect/`FishingStop` → Aborted (broadcast so bobbers despawn). One session per player; late/duplicate responses ignored.

## Server

- New `server/src/game_state/fishing.rs`: `FishingSession { player_id, bobber_pos, phase, deadline, rolled_fish, tension_pct, round, responded_this_round, skill_level }` + **pure transition functions with injected clock/RNG** (unit-testable).
- `GameState` (`server/src/game_state/mod.rs`): add `fishing_sessions: RwLock<HashMap<PlayerId, FishingSession>>` + `height_sampler: Arc<HeightSampler>` (wired in `main.rs` beside existing `TerrainIO`).
- `server/src/connection.rs`: three new match arms; hook the move/attack/disconnect paths to `cancel_fishing_if_active`.
- **Timers via a 250 ms fishing tick** through the existing `run_ticks` helper (codebase idiom; no per-session tokio tasks to cancel across abort paths; 250 ms jitter absorbed by the grace window). Water check (`sample_height(x,z).await < 0.0`) happens only in the async cast handler, never in the tick.
- Rolls reuse the d20 idiom in `server/src/game/combat.rs`: weighted species pick over `category=="fish"` defs by `catchWeight` (skill scales rare weights); size from `sizeDice` + d20 quality roll (nat 20 doubles size → trophy; also trophy if size ≥ `trophyCm` or rarity ≥ rare).
- XP: fishing **skill** XP only (10·rarity² caught, 2 escaped) — no character XP, leaves combat balance untouched (flag to maintainer).

## Skill subsystem (foundation PR)

- `shared/src/skills.rs`: `enum SkillId { Fishing }` (extensible: future Herbalism/Mining = new variants), `SkillProgress { level: u32, xp: u64 }`, `Skills { map: HashMap<SkillId, SkillProgress> }`; cap 20 (d20 feel); curve `xp_for_next_level(l) = 100·l²`.
- `Character`: `#[serde(default)] pub skills: Skills` (the proven `gender` pattern — old rows/clients unaffected).
- SQLite (in `AuthService::new()`, house idiom): `CREATE TABLE IF NOT EXISTS character_skills (character_id INTEGER NOT NULL, skill_id TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 0, xp INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(character_id, skill_id), FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE)`. Missing rows = level 0.
- Flush: new `dirty_skills` set; extend `save_batch` with a skills slice (same DELETE+INSERT pattern as `replace_inventories()`); load beside `load_inventory` on EnterGame. Delivery: direct `SkillsUpdate` on EnterGame (avoids touching the broadcast `Player` struct).
- Client: "Skills" section in `CharacterPanel.svelte` (name/level/xp bar), hidden when empty — this PR ships invisible.

## Items (`data-src/items.csv` — no commas in any field)

- `fishing_rod`: main_hand equip, category `fishing_rod`, basePrice 2500.
- Five stackable fish (category `fish`): `raw_minnow` (1d3 heal / 150), `raw_perch` (1d6/400), `raw_trout` (2d4/1200), `river_salmon` (2d6/4000), `golden_carp` (4d6/20000).
- New appended columns `rarityTier,catchWeight,sizeDice,trophyCm` (empty for non-fish; generator omits empties), mirrored as `#[serde(default)] Option<..>` on `ItemDefinition` — single data source, existing loader.
- Edible: one arm in `use_effect()` — `"fish" => self.dice.clone().map(UseEffect::Heal)`. Sellable: `basePrice` + existing SellItem flow, untouched.
- **Trophy size is ephemeral** — lives only in `FishingOutcome::Caught` + the `ServerNotice`. (Rejected: reusing `enchant` — semantically wrong, breaks stacking; a new `ItemInstance` field — forces fish non-stackable, touches trading. Follow-up option: distinct non-stackable `*_trophy` item ids.) Bait: deferred to v2, documented.

## Client

- `client/src/lib/managers/fishingController.ts` modeled on `combatController.ts`, plus `fishingController.test.ts` (vitest precedent exists). Never resolves outcomes locally.
- `inputHandler.ts`: new ClickIntent `cast_fishing` when MainHand category is `fishing_rod` and the clicked point's terrain height < 0 (client already knows sub-zero tiles from water-mesh generation); distance via shared `MAX_CAST_DISTANCE` through wasm. Keys: SPACE/click = Hook/Reel, S = GiveLine, ESC = stop.
- `components/FishingPanel.svelte` (TradeWindow panel pattern): tension bar, alternating prompts ("The fish pulls — give line!" / "It tires — reel!"), countdown ring from `respond_within_ms`, round pips, outcome toast. Only two struggle actions by design — fair for agents and colorblind players.
- `components/FishingBobber.svelte`: sphere at cast position (y≈0.05) + `THREE.Line` to caster; dips on Bite; despawns on Ended; renders for any player in interest radius (GroundItem precedent).
- Animations v1: reuse existing clips (slash1 at half speed as cast, idle2 waiting) to keep the PR asset-free; follow-up adds Mixamo Fishing Cast/Idle clips via `tools/` glb-editor + `doc/ANIMATION.md` workflow into `client/public/models/animations/fishing.glb`, registered in `types/animations.ts`.
- SFX: `preloadFishing/playSplash/playReel/playCatch` per the `sfxManager.ts` pattern, CC0 sources.
- Network: TS mirrors in `networkTypes.ts`, handlers in `messageHandlers.ts`, events in `networkEvents.ts`; regenerate WASM after shared changes.

## Agent-client

- New `agent-client/src/fishing.rs` + connection-loop wiring: auto-`Hook` on own `FishingBite`; on `FishingStruggleRound` send the correct action after 300–700 ms jitter (same info the human UI gets — `fish_state` is in the message). Session state in `src/state`.
- MCP tools: `fish()` — casts at nearest water point within 8 m (agent has terrain heights from A*; otherwise returns "no water in reach — move_to a shore first"), blocks until `FishingEnded` (45 s hard cap), returns a summary ("Caught raw_trout, 34 cm. Fishing 3→4"); `stop_fishing()`. LLM decides where/when/whether; reflexes local — exactly the A* precedent. Update `doc/AGENT_CLIENT.md`.

## Staged PRs (solo maintainer, no CI → small, each independently shippable)

- **PR0 — GitHub issue, no code**: condensed design proposal + maintainer questions (below). Get skill-system buy-in before building — it touches persistence and character data.
- **PR1 — Skill foundation**: `shared/skills.rs`, `Character.skills`, table + flush, Skills messages, CharacterPanel section, unit tests. Invisible in-game.
- **PR2 — Core loop**: protocol, `fishing.rs` with cast/wait/bite/hook→catch (single-round), HeightSampler wiring, items.csv + `use_effect` arm, fishing tick, skill XP, client controller/intent/bobber/minimal panel, `doc/FISHING.md` (COMBAT.md style), state-machine + weighted-table tests (seeded RNG, injected clock). Playable end-to-end.
- **PR3 — Struggle + polish**: multi-round struggle, tension UI, trophy roll + ServerNotice, SFX, optional animations. Purely additive protocol.
- **PR4 — Agent-client**: reflex handling + MCP tools + docs, smoke-tested with a real agent.

## Maintainer questions (raise in PR0)

Skill shape/cap and attribute interaction; fishing anywhere height<0 vs designated spots/rivers; protocol-version policy for new `ServerMessage` variants vs stale connected clients (rmp-serde fails on unknown variants — worst case gate fishing broadcasts on client version); ephemeral trophy size OK?; asset policy under PolyForm Noncommercial (Mixamo clips, CC0 SFX, AI-gen icons — AI assets are precedented in README); English `doc/FISHING.md` (doc/ is English, TODO.md Korean); skill-XP-only from fishing; trophy notice radius vs world-wide.

## Verification

- `cargo test -p onlinerpg-shared -p onlinerpg-server`: skill curve, fishing state machine (seeded RNG/injected clock: hook-timeout → Escaped, tension overflow → Escaped, full-round survival → Caught, move-cancels), weighted catch table distribution.
- Client: `fishingController.test.ts` via existing vitest setup.
- Manual browser script: debug-drop rod → equip → cast too far (error) → cast on land (error) → ignore bite (escape) → catch → eat (HP up) → sell to merchant → move mid-struggle with a second browser client watching (abort + bobber despawn on both) → temporarily weight `golden_carp` to force a trophy `ServerNotice` on the second client → disconnect mid-session (server cleans up).
- Agent smoke: run agent-client with prompt "walk to the lake and catch a fish"; verify `fish()` tool round-trip.
- PR assets: 10–20 s GIFs, pasted test output.

## Risks

- WASM regen + hand-mirrored TS types can drift — always rebuild wasm and update `networkTypes.ts` in the same commit as `messages.rs` changes.
- rmp-serde unknown-variant breakage for already-connected old clients when new broadcasts ship (mitigation above; ask maintainer in PR0).
- `data-src/items.csv` naive parser: no commas anywhere; never edit generated `data/*.json` directly.
- HeightSampler is async tile IO — confined to the cast handler, never the 250 ms tick.
- Save-data changes are additive-only (new table, `#[serde(default)]`) — no migration risk to existing characters.
