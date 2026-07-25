# Testing the fishing branches locally

Verified end-to-end on 2026-07-25 against `fishing/pr9-hardening` — including
the one step upstream's README doesn't mention (terrain baking), without which
there is no water in the world and fishing cannot work at all.

**Total time:** ~20 minutes, most of it unattended compiling and baking.

---

## What you'll hit that the upstream README doesn't cover

1. **The world ships empty.** `data/terrain/` is gitignored, so a fresh clone
   has no height or water tiles. The server treats missing tiles as flat sea
   level — the world renders as a featureless plane and *there is no water to
   fish in*. You must bake terrain once (step 3). Upstream documents this only
   in a Korean design doc (`doc/MAP_DESIGN.md`), not the setup instructions.
2. **Login is Google-only, and it's cryptographically verified.** There is no
   guest or password login — the server validates the Google ID token's
   signature against Google's public keys and checks the audience matches
   `GOOGLE_CLIENT_ID`. You need your own OAuth client ID (free, ~5 min) and the
   server needs outbound internet.
3. **New characters have 0 gold and no rod.** The rod costs 3 silver from the
   merchant Rica — but NPCs are themselves agent-clients that only exist in the
   world if you run one (needs an Anthropic API key). For a quick test, grant
   the rod directly (step 6).
4. **`npm run build:wasm` uses `rm -rf`** — run npm from **Git Bash**, not
   cmd/PowerShell, or it fails on Windows.

---

## 1. Get the code

```bash
git clone https://github.com/adamxgsb-hub/OpenMMO.git
cd OpenMMO
git checkout fishing/pr9-hardening   # the full stack, PR1–PR9
```

## 2. Prerequisites

Rust, Node.js, and a C++ toolchain (MSVC Build Tools on Windows), plus:

```bash
cargo install wasm-pack     # needed by npm run build:wasm
```

## 3. Bake the terrain (REQUIRED — do this once)

```bash
cargo build --release -p terrain-gen
./target/release/terrain-gen bake \
  --region-x-min -2 --region-x-max -2 \
  --region-z-min 4 --region-z-max 4
```

Takes ~6 minutes: the world generation phases (continents, rivers, erosion)
run globally regardless of how many regions you bake, then the 256 tiles of
the spawn region take ~2 seconds. Writes ~150 MB into `data/terrain/`.

Region `(-2, +4)` is the one containing the spawn point. Bake neighbours too
if you want to roam (`--region-x-min -3 --region-x-max -1` etc.), but it isn't
needed for fishing — see below.

**Good news about the spawn point:** you spawn on a river bank at
`(-1475.2, 4741.6)`. I scanned the baked world with the server's own water
sampler: there are **794 fishable points within 12 m of spawn**, the nearest
**1 m away** (0.96 m deep), the deepest 2.2 m. You do not have to go looking
for water — it's at your feet.

## 4. Google sign-in

1. Go to https://console.cloud.google.com/apis/credentials
2. **Create Credentials → OAuth client ID → Web application**
3. Under **Authorized JavaScript origins** add: `http://localhost:10004`
   (Google permits plain `http` for `localhost`, so no TLS setup needed)
4. Copy the client ID (looks like `1234-abcd.apps.googleusercontent.com`).
   You do *not* need the client secret — the browser sends the signed token
   and the server verifies it against Google's public keys.

```bash
cd client
cp .env.example .env.local
# set VITE_GOOGLE_CLIENT_ID=<your client id>
# leave VITE_BACKEND_HOST / the TLS lines commented out or blank for local use
```

## 5. Run it

Three terminals, from the repo root:

```bash
# 1 — server (same client ID; your email for admin commands)
GOOGLE_CLIENT_ID=<your client id> ADMIN_EMAILS=<your gmail> cargo run -p onlinerpg-server

# 2 — client (Git Bash on Windows!)
cd client && npm install && npm run dev -- --port 10004
```

**Windows PowerShell** sets env vars differently — the `VAR=x cmd` form above
is bash-only and will fail:

```powershell
$env:GOOGLE_CLIENT_ID='<your client id>'; $env:ADMIN_EMAILS='<your gmail>'; cargo run -p onlinerpg-server
```

Open **http://localhost:10004**, sign in with Google, create a character.

| Port | What |
|---|---|
| 10004 | the game in your browser |
| 10006 | server WebSocket (loopback; Vite proxies `/ws`) |
| 10007 | terrain/housing REST (loopback; Vite proxies `/api`) |

## 6. Get a fishing rod

New characters start with 0 gold, so buying one isn't an option yet. Stop the
server, run one of these against `data/game_data.db`, then start it again.
(Windows: `winget install SQLite.SQLite` for the `sqlite3` CLI.)

**Option A — make yourself admin** (recommended; also unlocks `/time`, and
`/drop <item>` for anything else):

```sql
UPDATE characters SET admin_role = 1 WHERE character_name = 'YourCharacter';
```

Then in-game chat: `/drop fishing_rod` → the rod lands in front of you → walk
over it to pick it up → open the inventory and equip it in the main hand.
(Admin needs *both* this row **and** your email in `ADMIN_EMAILS`.)

**Option B — just hand yourself the rod, already equipped:**

```sql
INSERT INTO character_items (character_id, item_def_id, quantity, equip_slot, enchant)
SELECT id, 'fishing_rod', 1, 'main_hand', 0
FROM characters WHERE character_name = 'YourCharacter';
```

Add `UPDATE characters SET gold = 50000 WHERE character_name = 'YourCharacter';`
if you also want to test buying one from Rica later.

## 7. Fish

With the rod in your main hand, **click the water** near where you spawned.
Clicking water casts instead of walking; clicking dry ground still walks.

What to look for:

- **Cast → bobber** lands, a 4–12 s wait
- **Bite** — the bobber dips; press **SPACE** (or click the prompt) within
  2.5 s. Too early scares the fish; too late loses it (+2 consolation XP)
- **The struggle** — each round says *Pulling* (→ **S** to give line) or
  *Tiring* (→ **SPACE** to reel). Wrong or late answers raise the tension
  bar; 100 snaps the line
- **Catch** — the fish stacks into your bag with a combat-log line. Check the
  character sheet for **Fishing** skill XP
- **Flotsam** — roughly 1 cast in 7 pulls up an Old Boot, Kelp, a Message in a
  Bottle, or a Sunken Coin Pouch (coins go straight to your wallet with a gold
  toast, and never enter the bag). None of them grant XP
- **Eat a fish** from the bag to heal; **sell** it to a merchant
- **Abort paths** worth poking at: walk away mid-cast, get attacked, or
  unequip/drop the rod — each reels the line in

### Things I verified here so you don't have to guess

Running a headless client against a real server on the freshly baked terrain,
13 casts at the spawn river produced: 11 fish (XP 10/40/90 by rarity, one
trophy minnow), 1 Clump of Kelp (bagged, 0 XP), and 1 Sunken Coin Pouch
(**+15 copper via GoldGained**, 0 XP). The database afterwards showed the rod
still equipped, 27 fish stacked, gold 24, and Fishing at level 2 with 912 XP —
so persistence works too.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| World is a flat grey plane, no water anywhere | Terrain not baked — step 3 |
| Clicking water walks instead of casting | No rod in the **main hand** (off-hand doesn't count), or you're not on the overworld |
| "You need a fishing rod in your main hand." | Same — equip it in main hand |
| "That water is out of casting range." | Max cast is 8 m; step closer |
| Login screen errors about the client ID | `VITE_GOOGLE_CLIENT_ID` missing from `client/.env.local` (restart Vite after editing) |
| Login rejected server-side | Server started without a matching `GOOGLE_CLIENT_ID`, or it can't reach Google to fetch signing keys |
| `/drop` says you're not allowed | Needs **both** `admin_role = 1` in the DB **and** your email in `ADMIN_EMAILS` |
| `npm run build:wasm` fails with `rm: command not found` | Run it from Git Bash, or `npm config set script-shell bash` |
| Protocol version mismatch on connect | Client and server built from different commits — rebuild the wasm (`npm run build:wasm`) and restart both |

## Running the tests in CI instead (zero local setup)

The `ci/fishing-tests` branch carries a GitHub Actions workflow that runs the
whole suite — rustfmt, workspace build, all Rust tests, the client type-check
and vitest — on every push to a `fishing/**` or `ci/**` branch. Watch it under
the repo's **Actions** tab. It is deliberately **not** part of the upstream PR
stack (upstream runs no test CI); to test a different branch, rebase that
branch's work under it or push to a `ci/` branch.

## Running the automated tests locally instead

If you only want the evidence without playing:

```bash
cargo test --workspace          # 512 tests, includes the whole fishing suite
cd client && npm test           # 290 tests
cd client && npm run check      # type/svelte check
```
