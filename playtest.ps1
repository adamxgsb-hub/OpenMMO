# playtest.ps1 — one-shot boat playtest setup for Windows.
#
# Pulls the latest boats branch, works around the exhausted upstream LFS
# budget, bakes Jake's real world (seed 42) around Aldermark's coast,
# mirrors the town buildings from the live server, seeds your character
# with admin + a boat deed at the water's edge, and launches the server
# and client in their own windows.
#
#   .\playtest.ps1                          # first run / update + launch
#   .\playtest.ps1 -Character Adam          # also make 'Adam' admin, teleport
#                                           #   to the shore, grant a deed
#   .\playtest.ps1 -FullRoute               # bake the whole PR0 corridor
#                                           #   (Aldermark-Edra-Stenhavn, ~16 GB)
#   .\playtest.ps1 -Rebake                  # force a fresh terrain bake
#   .\playtest.ps1 -NoLaunch                # prepare everything, launch nothing
#
# One-time prerequisites this script cannot do for you:
#   - client\.env.local containing VITE_GOOGLE_CLIENT_ID=<your web client id>
#   - create your character once in the browser before using -Character
param(
    [string]$Character = "",
    [switch]$FullRoute,
    [switch]$Rebake,
    [switch]$NoLaunch
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repo

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }

# ---- 1. code: latest boats branch, LFS smudge kept out of the way ----------
Step "Fetching the latest boats branch"
$env:GIT_LFS_SKIP_SMUDGE = "1"
git fetch fork
git merge --ff-only fork/boats/art-pass 2>$null
if ($LASTEXITCODE -ne 0) {
    git merge fork/boats/art-pass
    if ($LASTEXITCODE -ne 0) { throw "Merge conflict - resolve it, then re-run." }
}
$env:GIT_LFS_SKIP_SMUDGE = ""

# ---- 2. assets blocked by the upstream LFS budget: pull plain blobs --------
Step "Restoring LFS-blocked assets from the scratch branch"
git fetch fork scratch/rowboat-plain
git checkout FETCH_HEAD -- client/public/models/objects/rowboat.glb 2>$null
git checkout FETCH_HEAD -- client/public/models/animations/boat.glb 2>$null
$rb = (Get-Item client/public/models/objects/rowboat.glb).Length
$bp = (Get-Item client/public/models/animations/boat.glb).Length
if ($rb -lt 100000 -or $bp -lt 100000) {
    throw "Asset restore failed: rowboat.glb=$rb boat.glb=$bp bytes (want 836492 / 130972)"
}
Write-Host "rowboat.glb $rb bytes, boat.glb $bp bytes - OK"

# ---- 3. terrain: Jake's world is seed 42 (doc/TERRAIN_GENERATION.md) -------
$box = if ($FullRoute) { @("-4", "9", "-9", "4") } else { @("-3", "-2", "4", "4") }
$wg = "data/terrain/worldgen.json"
$haveWorld = (Test-Path $wg) -and
    ((Get-Content $wg -Raw | ConvertFrom-Json).seed -eq 42) -and
    (Test-Path "data/terrain/height/r-03_+04")
if ($Rebake -or -not $haveWorld) {
    Step "Baking seed-42 terrain (regions x $($box[0])..$($box[1]), z $($box[2])..$($box[3]))"
    if (Test-Path data/terrain) { Remove-Item -Recurse -Force data/terrain }
    git checkout -- data/terrain/zones 2>$null
    cargo build --release -p terrain-gen
    if ($LASTEXITCODE -ne 0) { throw "terrain-gen build failed" }
    & target/release/terrain-gen.exe bake --seed 42 `
        --region-x-min $box[0] --region-x-max $box[1] `
        --region-z-min $box[2] --region-z-max $box[3]
    if ($LASTEXITCODE -ne 0) { throw "bake failed" }
} else {
    Step "Seed-42 terrain already baked - skipping (-Rebake to force)"
}

# ---- 4. town buildings from the live server's public read API --------------
Step "Mirroring town buildings from the live server"
if (Test-Path tools/mirror-housing.py) {
    python tools/mirror-housing.py aldermark
    if ($LASTEXITCODE -eq 0) {
        cargo run --release -p terrain-gen -- apply-houses
    } else {
        Write-Host "mirror failed (offline?) - continuing without buildings" -ForegroundColor Yellow
    }
} else {
    Write-Host "tools/mirror-housing.py not found - skipping buildings" -ForegroundColor Yellow
}

# ---- 5. builds -------------------------------------------------------------
Step "Building the server (item registry is compiled in)"
cargo build --release -p onlinerpg-server
if ($LASTEXITCODE -ne 0) { throw "server build failed" }
if (-not (Test-Path client/node_modules)) {
    Step "Installing client dependencies"
    Push-Location client; npm ci; Pop-Location
}

# ---- 6. seed the character: admin + shore teleport + boat deed -------------
if ($Character -and (Test-Path data/game_data.db)) {
    Step "Seeding '$Character': admin, shore teleport, boat deed"
    $py = @"
import sqlite3, sys
name = sys.argv[1]
c = sqlite3.connect('data/game_data.db')
row = c.execute('select id from characters where character_name=?', (name,)).fetchone()
if not row:
    print(f'character {name!r} not found - create it in the browser first'); sys.exit(1)
cid = row[0]
c.execute('update characters set admin_role=1, last_x=-2844, last_y=0.15, last_z=4524 where id=?', (cid,))
have = c.execute('select 1 from character_items where character_id=? and item_def_id=?', (cid, 'boat_deed')).fetchone()
if not have:
    c.execute('insert into character_items (character_id, item_def_id, quantity, equip_slot, enchant) values (?,?,?,?,?)', (cid, 'boat_deed', 1, None, 0))
c.commit()
print(f'{name}: admin, at the shore (-2844, 4524), deed in bag')
"@
    python -c $py $Character
} elseif ($Character) {
    Write-Host "No data\game_data.db yet - create your character first, then re-run with -Character" -ForegroundColor Yellow
}

# ---- 7. launch -------------------------------------------------------------
if (-not $NoLaunch) {
    $envFile = "client/.env.local"
    $gcid = ""
    if (Test-Path $envFile) {
        $m = Select-String -Path $envFile -Pattern '^VITE_GOOGLE_CLIENT_ID=(.+)$'
        if ($m) { $gcid = $m.Matches[0].Groups[1].Value.Trim() }
    }
    if (-not $gcid) {
        Write-Host "WARNING: no VITE_GOOGLE_CLIENT_ID in client\.env.local - login will fail" -ForegroundColor Yellow
    }
    Step "Launching server and client in their own windows"
    Start-Process cmd -ArgumentList '/k', "cd /d $repo && set GOOGLE_CLIENT_ID=$gcid&& cargo run --release -p onlinerpg-server"
    Start-Process cmd -ArgumentList '/k', "cd /d $repo\client && npm run dev"
    Write-Host @"

Open http://localhost:10004 when Vite is ready.
  - You are at the water's edge; use the Boat Deed from your bag.
  - Steer WEST (deep water ~1.3 m at x=-2920); north is land within 40 m.
  - Click open water to sail (you row), click land to step ashore.
  - A second character clicks the hull to ride along (they sit).
"@
} else {
    Step "Prepared. Launch skipped (-NoLaunch)."
}
