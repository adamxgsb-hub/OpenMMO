# test-fishing-locally.ps1 — set up a local OpenMMO with the fishing branches.
#
#   powershell -ExecutionPolicy Bypass -File .\test-fishing-locally.ps1 -GoogleClientId "1234-abc.apps.googleusercontent.com"
#
# Assumes Rust, Node and the MSVC C++ toolchain are already installed (see
# setup-openmmo.ps1). Every step is re-runnable and skips itself if done.
# Full walkthrough and troubleshooting: LOCAL-TESTING.md

param(
    [Parameter(Mandatory = $true)]
    [string]$GoogleClientId,

    [string]$RepoDir = (Join-Path $HOME "OpenMMO"),
    [string]$Branch  = "fishing/pr9-hardening",

    # Bake extra regions around spawn so you can roam. Fishing only needs the
    # spawn region: you spawn on a river bank with water ~1 m away.
    [switch]$WideBake
)

$ErrorActionPreference = "Stop"

function Step($n, $msg) { Write-Host "[$n] $msg" -ForegroundColor Cyan }
function Note($msg)     { Write-Host "     $msg" -ForegroundColor DarkGray }

# --- 1. Code -----------------------------------------------------------------
Step 1 "Fetching the code"
if (-not (Test-Path $RepoDir)) {
    git clone https://github.com/adamxgsb-hub/OpenMMO.git $RepoDir
}
Set-Location $RepoDir
git fetch origin $Branch
git checkout $Branch
git pull --ff-only origin $Branch
Note "on $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)"

# --- 2. wasm-pack ------------------------------------------------------------
Step 2 "Checking wasm-pack"
if (-not (Get-Command wasm-pack -ErrorAction SilentlyContinue)) {
    Note "installing from crates.io (a few minutes)"
    cargo install wasm-pack
} else { Note "already installed" }

# --- 3. Terrain --------------------------------------------------------------
# REQUIRED: data/terrain is gitignored, so a fresh clone has no world. Without
# this the map is a flat plane at sea level and there is no water to fish in.
Step 3 "Baking terrain (once; ~6 min)"
$spawnTile = Join-Path $RepoDir "data\terrain\water-field\r-02_+04\wf_-0023_+0074.bin"
if (Test-Path $spawnTile) {
    Note "spawn region already baked - skipping"
} else {
    cargo build --release -p terrain-gen
    $bake = @("bake")
    if ($WideBake) {
        $bake += @("--region-x-min","-3","--region-x-max","-1","--region-z-min","3","--region-z-max","5")
        Note "wide bake: 9 regions, noticeably slower"
    } else {
        $bake += @("--region-x-min","-2","--region-x-max","-2","--region-z-min","4","--region-z-max","4")
    }
    & (Join-Path $RepoDir "target\release\terrain-gen.exe") @bake
    if (-not (Test-Path $spawnTile)) { throw "bake finished but the spawn tile is missing: $spawnTile" }
    Note "spawn region baked"
}

# --- 4. Client env -----------------------------------------------------------
Step 4 "Writing client\.env.local"
$envLocal = Join-Path $RepoDir "client\.env.local"
"VITE_GOOGLE_CLIENT_ID=$GoogleClientId" | Set-Content -Path $envLocal -Encoding utf8
Note "wrote $envLocal"
Note "make sure http://localhost:10004 is an Authorized JavaScript origin for that client ID"

# --- 5. Client deps + wasm ---------------------------------------------------
# npm's build:wasm uses `rm -rf`, so it needs a POSIX shell. Git ships one.
Step 5 "Installing client dependencies"
Set-Location (Join-Path $RepoDir "client")
$bash = Get-Command bash -ErrorAction SilentlyContinue
if ($bash) {
    npm config set script-shell $bash.Source | Out-Null
    Note "npm script-shell -> $($bash.Source) (build:wasm needs rm -rf)"
} else {
    Write-Warning "bash not found. 'npm run build:wasm' will fail on cmd.exe - install Git for Windows, then re-run."
}
npm install
Set-Location $RepoDir

# --- 6. Server build ---------------------------------------------------------
Step 6 "Building the server"
cargo build -p onlinerpg-server

# --- 7. What to do next ------------------------------------------------------
$gmail = "<your-google-email>"
Write-Host ""
Write-Host "== Ready. Two terminals: ==" -ForegroundColor Green
Write-Host ""
Write-Host "  # server (repo root)" -ForegroundColor Yellow
Write-Host "  `$env:GOOGLE_CLIENT_ID='$GoogleClientId'; `$env:ADMIN_EMAILS='$gmail'; cargo run -p onlinerpg-server"
Write-Host ""
Write-Host "  # client (Git Bash preferred)" -ForegroundColor Yellow
Write-Host "  cd client; npm run dev -- --port 10004"
Write-Host ""
Write-Host "Then open http://localhost:10004, sign in with Google, create a character." -ForegroundColor Green
Write-Host ""
Write-Host "To get a rod (new characters have 0 gold), stop the server and run:" -ForegroundColor Green
Write-Host "  .\grant-fishing-rod.ps1 -CharacterName 'YourCharacter'"
Write-Host ""
Write-Host "You spawn on a river bank - water is about 1 m away. Click it with the" -ForegroundColor Green
Write-Host "rod equipped in your main hand. SPACE hooks and reels, S gives line." -ForegroundColor Green
