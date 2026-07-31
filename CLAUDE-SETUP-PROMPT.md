# Driving the local boat playtest with Claude Code

Run Claude Code ON the playtest machine and it does the setup itself —
no more relaying terminal steps through chat. Install the Windows CLI or
desktop app, then:

```cmd
cd %USERPROFILE%\OpenMMO
claude
```

and paste the handoff prompt below. It contains everything the cloud
session learned the hard way; a fresh local session starting from it
skips a week of rediscovery.

---

> I'm testing the boats feature for OpenMMO locally on Windows. You have
> my terminal — do the work yourself rather than telling me the steps.
> Everything below was established by a previous session; trust it before
> re-deriving.
>
> **Branches** (remote `fork` = github.com/adamxgsb-hub/OpenMMO):
> - `boats/art-pass` — the complete boats feature: server mechanics,
>   rowboat model, deed icon, sit/row animations, deep-water login
>   rescue. This is what we're testing. My local branch `playtest`
>   tracks it.
> - `scratch/rowboat-plain` — carries `client/public/models/objects/
>   rowboat.glb` (836,492 B) and `client/public/models/animations/
>   boat.glb` (130,972 B) as PLAIN git blobs. Never merge it.
> - `claude/mmo-pr-progress-4qgoig` — notes + this file +
>   `playtest.ps1` + `tools/mirror-housing.py`.
>
> **The LFS trap**: the upstream repo's LFS budget is exhausted, so any
> checkout that smudges fails with "This repository exceeded its LFS
> budget". Always `set GIT_LFS_SKIP_SMUDGE=1` around checkouts/merges,
> then `git lfs checkout` to fill from the local cache (it is fully
> populated except the two files above — restore those from
> `scratch/rowboat-plain` via `git checkout FETCH_HEAD -- <path>`; the
> "should have been a pointer" warning is expected and correct).
>
> **The world**: `data/terrain/` is gitignored — a clone has no world.
> Jake's world is **seed 42** (doc/TERRAIN_GENERATION.md — the CLI
> default of 7 is a DIFFERENT planet; never use it). Bake with:
> `target\release\terrain-gen.exe bake --seed 42 --region-x-min -3
> --region-x-max -2 --region-z-min 4 --region-z-max 4`
> (Aldermark's coast, ~324 MB, ~8.5 min; the full PR0 corridor is
> x -4..9, z -9..4, ~16 GB). Baking is incremental across runs.
> Towns have no buildings after baking — houses are operator content;
> mirror them from the live server with
> `python tools\mirror-housing.py aldermark` then
> `cargo run --release -p terrain-gen -- apply-houses`.
> NPCs (Rica/Karl) are agent-client processes, not server spawns — they
> exist only if `cargo run -p agent-client` is running with an LLM key.
>
> **The fast path**: `playtest.ps1` (repo root, from the notes branch)
> already automates all of the above:
> `powershell -ExecutionPolicy Bypass -File playtest.ps1 -Character <name>`
> — merge, asset restore, seed-42 bake if missing, housing mirror,
> server build, character seeding (admin_role=1 + teleport to the shore
> at −2844, 4524 + boat_deed in bag), and launches server + client.
> Prefer running it over re-implementing it; fix it if it breaks.
>
> **Auth facts**: browser login needs GOOGLE_CLIENT_ID on the server and
> VITE_GOOGLE_CLIENT_ID in client/.env.local (same Web client ID, origin
> http://localhost:10004). Admin needs BOTH --admin-emails AND
> admin_role>0 on the character row (defaults 0, only settable in the
> DB, read at EnterGame). Headless testing needs no Google at all:
> `AuthenticateNpc` with the token from `data/npc_token`.
>
> **Sailing from the seeded spot**: use the Boat Deed from the bag at
> the shore; steer WEST (north is land within 40 m; depth reaches 1.3 m
> at x≈−2920). Click water to sail — pilot rows, passengers sit; click
> land to step ashore; deed again (stopped, alone, near shore) stows.
>
> **What to capture for the upstream PR**: a GIF of two characters
> riding one boat, and honest notes on feel — hull scale beside a
> character, the 3 s stroke against 6 m/s hull speed, camera while
> under way, seat alignment on the benches. Those judgements are the
> whole reason for playing; automated suites are already green
> (629 Rust + 338 client at tip).
>
> Do not push to any branch from this machine unless I ask. First: run
> `git log --oneline -5` on `playtest` and confirm it matches
> `fork/boats/art-pass`, then run playtest.ps1 and take it from there.

---

## Notes for the human, not the agent

- The local session is a sibling of the cloud one, not a continuation —
  this file IS the handoff. Keep it current when big things change.
- Approve commands as it works; it acts with your permissions.
- The Google sign-in in the browser stays yours.
- **Windows:** if npm scripts fail on `rm -rf`, either run from Git Bash
  or `npm config set script-shell "C:\Program Files\Git\bin\bash.exe"`.
- Division of labour that has worked: the cloud session for pushing
  branches, headless server tests, asset processing and PR drafting;
  the local one for anything that needs your GPU, your browser, or
  your eyes.
