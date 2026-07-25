# Driving the local setup with Claude Code

The fastest way to get a playable local server: clone, check out the fishing
branch, run `claude`, and paste the prompt below. It handles the long,
fiddly parts (terrain baking, env files, builds, the rod grant) and stops to
let you do the two things it can't: create a Google OAuth client ID, and
actually play.

```bash
git clone https://github.com/adamxgsb-hub/OpenMMO.git
cd OpenMMO
git checkout fishing/pr9-hardening
claude
```

Then paste this:

---

> I want to run this OpenMMO server locally and test the fishing feature by
> logging in with my browser. Set it up for me.
>
> There is a verified walkthrough on the repo's `main` branch — read it first
> with `git show main:LOCAL-TESTING.md` (it is not in this branch's working
> tree). Follow it, but do the work yourself rather than telling me to.
>
> Key things that guide covers and that are easy to get wrong:
> - `data/terrain/` is gitignored, so this clone has **no world at all** —
>   you must bake terrain with `tools/terrain-gen` or there is no water and
>   fishing cannot work. This takes ~6 minutes; just run it.
> - Login is Google-only and cryptographically verified. I have to create the
>   OAuth client ID myself, so when you get to that step, stop and give me the
>   exact click-path, then continue once I paste the client ID back to you.
> - New characters start with 0 gold and no rod, so after I create a character
>   you'll need to grant one by editing `data/game_data.db` (stop the server
>   first).
>
> Please:
> 1. Check my prerequisites (Rust, Node, wasm-pack, a C++ toolchain) and
>    install whatever is missing.
> 2. Bake the spawn region's terrain.
> 3. Pause for my Google OAuth client ID, then write `client/.env.local`.
> 4. Build the server and install client dependencies.
> 5. Start the server and the client dev server in the background, and tell me
>    when to open http://localhost:10004 and make a character.
> 6. Once I say the character exists, stop the server, grant that character a
>    fishing rod (equipped in the main hand), restart, and tell me where the
>    water is relative to spawn.
> 7. Tell me the controls for the bite and the struggle minigame.
>
> Do not commit anything, do not push, and do not modify any tracked source
> files — this is a local test setup only. If something fails, diagnose and fix
> it rather than handing the error back to me.

---

## Notes

- **Windows:** run `claude` from **Git Bash**, not cmd/PowerShell — the
  client's `build:wasm` script uses `rm -rf`. (Alternatively there are
  `test-fishing-locally.ps1` and `grant-fishing-rod.ps1` on `main` that do
  steps 1–4 and 6 without Claude.)
- **It will take a while.** The terrain bake is ~6 minutes and the first Rust
  build is several more. That's normal, not a hang.
- **Verifying without playing:** you don't need any of this to confirm the code
  is sound — the `ci/fishing-tests` branch runs the full suite (512 Rust + 290
  client tests) in GitHub Actions on every push. Check the Actions tab.
