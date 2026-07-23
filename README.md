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
| `fishing/pr7-rod` | PR7 (stacked on PR6): **rod obtainable** — sold by the general merchant (Rica, 2500g), excluded from dungeon-chest loot, + its own icon (was spear_icon.png) |
| `main` | This notes branch only (proposal + plan) |

**All four implementation stages are complete and verified** — 456 Rust
tests + 279 client tests green, and a full live catch executed against a
running server over the real protocol (cast → bite → hook → 5-round
struggle → `raw_trout ×1` in the bag, +90 fishing XP). Deferred by design:
SFX/animations polish, bait, rod tiers (`doc/FISHING.md`).

**River fix (PR5):** the initial water check (`terrain height < 0`) only
recognized the ocean — rivers carve channels whose beds stay *above* sea
level, so every inland river read as land. PR5 adds a server-side
`WaterSampler` over the baked unified water field (WFD1), testing
`waterSurface − terrainBed > 0` so ocean and rivers both fish. Verified live:
ocean catch, river catch (bed at +5 m), and land correctly refused.

## Next steps

1. Post `PR0-fishing-proposal.md` as an issue on the upstream repo (owner's
   account) and get Jake Song's read on the skill-system design.
2. When ready to open upstream PRs, create a true GitHub *fork* of the
   upstream repo and push the `fishing/*` branches there (GitHub PRs require
   a fork; this repo preserves the work but can't open PRs against upstream).
