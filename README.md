# OpenMMO — fishing contribution workspace

Working copy of [Julian-adv/OpenMMO](https://github.com/Julian-adv/OpenMMO)
(Jake Song's open MMO; PolyForm Noncommercial license) for developing a
**fishing system** contribution.

## Branches

| Branch | Contents |
|---|---|
| `master` | Upstream `Julian-adv/OpenMMO@master`, full history (as of 2026-07-23) |
| `fishing/pr1-skills` | PR1: trained-skill foundation (SkillId, persistence, SkillsUpdate) — implemented + tested |
| `fishing/pr2-core` | PR2 (stacked on PR1): fishing core loop — cast/bite/hook/catch, rod + fish items, water detection, client UI, `doc/FISHING.md` — implemented + tested |
| `fishing/pr3-struggle` | PR3 (stacked on PR2): ArcheAge-style struggle — tension rounds (Pulling/Tiring), per-round windows, struggle HUD panel, bystander trophy shout-outs — implemented + tested |
| `fishing/pr4-agent` | PR4 (stacked on PR3): agent-client fishing — auto-hook/struggle reflexes, `fish`/`stop_fishing` LLM actions, `[Fishing]` outcome events — implemented + tested |
| `fishing/pr5-rivers` | PR5 (stacked on PR4): **river fishing fix** — detect water via the unified water field (WFD1) server-side, so rivers (beds above sea level) are fishable, not just ocean — implemented + tested + live-verified |
| `fishing/pr6-fish-icons` | PR6 (stacked on PR5): distinct 128×128 icon art for each of the five fish (were reusing sword.png) — minnow, perch, trout, salmon, golden carp |
| `fishing/pr7-rod` | PR7 (stacked on PR6): **rod obtainable** — sold by the general merchant (Rica, 3 silver), excluded from dungeon-chest loot, its own icon, and fish/rod prices anchored to the income economy — a catch ≈ a couple of coin piles (minnow 10c … golden carp 15s) |
| `fishing/pr8-flotsam` | PR8 (stacked on PR7): **junk & coin catches** — Old Boot / Clump of Kelp (worthless gag junk), Message in a Bottle (15c), Sunken Coin Pouch (`coin_catch`: 3d8 copper straight to the wallet); all rarity 0 = no XP, no trophies; per-catch sell EV ~16c locked by a contract test (5–25c band); four new icons |
| `fishing/pr9-hardening` | PR9 (stacked on PR8): **hardening** — death and rod-loss (unequip/swap/drop) now abort the session (two real holes found by test-writing); two-angler concurrency, broadcast-radius, stop/late-hook boundary, bag-spill, eat-fish tests; key wiring mutation-tested |
| `ci/fishing-tests` | **Fork-only CI** (stacked on PR9): GitHub Actions running rustfmt + build + all Rust tests + client check/vitest on every push. Never include in an upstream PR — upstream has no test CI |
| `main` | This notes branch only (proposal + plan) |

**Rebased onto upstream `fdca62c1` (25 Jul, +36 commits)** — upstream had
independently bumped `PROTOCOL_VERSION` to 5 (ours now 6/7/8), removed
`InventoryError` in favour of `SystemMessage`, and changed
`DungeonDefs::load()`'s signature; all resolved. Every branch builds standalone
and `cargo fmt --all --check` is clean. Note upstream also added a **CLA**
(`CLA.md`) that must be signed by comment on any PR — read it first, it grants
commercial/relicensing rights.

**All implementation stages are complete and verified** — 512 Rust
tests + 290 client tests green, and full live catches executed against a
running server over the real protocol (fish into the bag with XP; junk
into the bag with 0 XP; coin pouch paying copper via `GoldGained`).
Deferred by design: SFX/animations polish, bait, rod tiers
(`doc/FISHING.md`).

**River fix (PR5):** the initial water check (`terrain height < 0`) only
recognized the ocean — rivers carve channels whose beds stay *above* sea
level, so every inland river read as land. PR5 adds a server-side
`WaterSampler` over the baked unified water field (WFD1), testing
`waterSurface − terrainBed > 0` so ocean and rivers both fish. Verified live:
ocean catch, river catch (bed at +5 m), and land correctly refused.

## Testing it yourself

**[CLAUDE-SETUP-PROMPT.md](CLAUDE-SETUP-PROMPT.md)** — the fastest route: a
paste-ready prompt that has Claude Code do the whole local setup for you.

**[ART-PIPELINE.md](ART-PIPELINE.md)** — how to make models, icons and
animations that match Jake's house style, following his own documented
workflow (Meshy → Blender → glb, and Mixamo → animation packs).

**[LOCAL-TESTING.md](LOCAL-TESTING.md)** — verified step-by-step for running
the fishing branches locally, including the terrain-bake step upstream's README
omits (without it there is no water in the world). Windows helpers:
`test-fishing-locally.ps1` (setup) and `grant-fishing-rod.ps1` (a rod for a
0-gold character).

## Next steps

1. Post `PR0-fishing-proposal.md` as an issue on the upstream repo (owner's
   account) and get Jake Song's read on the skill-system design.
2. When ready to open upstream PRs, create a true GitHub *fork* of the
   upstream repo and push the `fishing/*` branches there (GitHub PRs require
   a fork; this repo preserves the work but can't open PRs against upstream).
