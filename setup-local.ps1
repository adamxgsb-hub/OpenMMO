# setup-local.ps1 — one-shot local OpenMMO + fishing setup for Windows.
#
# Run from cmd (no need to be Administrator once Git/Node/Rust are installed):
#
#   powershell -ExecutionPolicy Bypass -File setup-local.ps1
#
# Or with your Google client ID already in hand:
#
#   powershell -ExecutionPolicy Bypass -File setup-local.ps1 -GoogleClientId "1234-abc.apps.googleusercontent.com"
#
# Safe to re-run: every step skips itself if already done. The long parts
# (LFS pull, cargo build, terrain bake) only happen once.

param(
    # Optional — you can run everything else first and add this later.
    [string]$GoogleClientId = "",

    [string]$RepoDir = (Join-Path $HOME "openmmo-game"),
    [string]$Branch  = "fishing/pr9-hardening"
)

$ErrorActionPreference = "Stop"
function Step($n, $m) { Write-Host "`n[$n] $m" -ForegroundColor Cyan }
function Note($m)     { Write-Host "      $m" -ForegroundColor DarkGray }
function Warn($m)     { Write-Host "      $m" -ForegroundColor Yellow }

# --- 0. Prerequisites ---------------------------------------------------------
Step 0 "Checking prerequisites"
$missing = @()
foreach ($t in @("git","node","npm","cargo")) {
    if (-not (Get-Command $t -ErrorAction SilentlyContinue)) { $missing += $t }
}
if ($missing.Count) {
    Write-Host "Missing: $($missing -join ', ')" -ForegroundColor Red
    Write-Host "Install them first (Administrator PowerShell):" -ForegroundColor Red
    Write-Host "  winget install --id Git.Git -e"
    Write-Host "  winget install --id OpenJS.NodeJS.LTS -e"
    Write-Host "  winget install --id Rustlang.Rustup -e"
    Write-Host "  winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override `"--quiet --add Microsoft.VisualStudio.Workload.VCTools`""
    throw "prerequisites missing"
}
git lfs version *> $null
if ($LASTEXITCODE -ne 0) { throw "Git LFS not available. Run: winget install --id GitHub.GitLFS -e --skip-dependencies" }
git lfs install | Out-Null
Note "git, node, npm, cargo, git-lfs all present"

$bash = Get-Command bash -ErrorAction SilentlyContinue   # Git Bash, for npm's rm -rf

# --- 1. Clone upstream (it owns the LFS binaries) -----------------------------
Step 1 "Getting the code"
if (-not (Test-Path (Join-Path $RepoDir ".git"))) {
    Note "cloning upstream into $RepoDir"
    git clone https://github.com/Julian-adv/OpenMMO.git $RepoDir
} else { Note "$RepoDir already exists - reusing" }
Set-Location $RepoDir

# The fishing work lives in a separate (non-fork) repo, so it has no LFS
# objects of its own. Upstream's pull below covers both.
if (-not (git remote | Select-String -Quiet '^fishing$')) {
    git remote add fishing https://github.com/adamxgsb-hub/OpenMMO.git
}
git fetch fishing --quiet
if (git rev-parse --verify --quiet "refs/heads/$Branch") {
    git checkout $Branch
} else {
    git checkout -b $Branch "fishing/$Branch"
}
Note "on $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)"

# --- 2. LFS binaries ----------------------------------------------------------
Step 2 "Fetching 3D models via Git LFS (large; one time)"
$probe = Join-Path $RepoDir "client\public\models\weapons\spear.glb"
if ((Test-Path $probe) -and ((Get-Item $probe).Length -gt 10kb)) {
    Note "models already present - skipping"
} else {
    git lfs pull
    if (-not ((Test-Path $probe) -and ((Get-Item $probe).Length -gt 10kb))) {
        throw "LFS pull did not produce real models (spear.glb is still a pointer)"
    }
    Note "models fetched"
}

# --- 3. wasm-pack -------------------------------------------------------------
Step 3 "Checking wasm-pack"
if (-not (Get-Command wasm-pack -ErrorAction SilentlyContinue)) {
    Note "installing (several minutes)"
    cargo install wasm-pack
} else { Note "already installed" }

# --- 4. Terrain ---------------------------------------------------------------
# data/terrain is gitignored, so a fresh clone has NO world: flat sea level,
# no water, fishing impossible. This bakes the spawn region.
Step 4 "Baking terrain (~6 minutes, one time)"
$spawnTile = Join-Path $RepoDir "data\terrain\water-field\r-02_+04\wf_-0023_+0074.bin"
if (Test-Path $spawnTile) {
    Note "spawn region already baked - skipping"
} else {
    cargo build --release -p terrain-gen
    & (Join-Path $RepoDir "target\release\terrain-gen.exe") bake `
        --region-x-min -2 --region-x-max -2 --region-z-min 4 --region-z-max 4
    if (-not (Test-Path $spawnTile)) { throw "bake finished but the spawn tile is missing" }
    Note "spawn region baked - you spawn on a river bank, water ~1 m away"
}

# --- 5. Client ----------------------------------------------------------------
Step 5 "Client setup"
$envLocal = Join-Path $RepoDir "client\.env.local"
if ($GoogleClientId) {
    "VITE_GOOGLE_CLIENT_ID=$GoogleClientId" | Set-Content -Path $envLocal -Encoding utf8
    Note "wrote client\.env.local"
} elseif (Test-Path $envLocal) {
    Note "client\.env.local already exists - leaving it alone"
} else {
    Warn "No -GoogleClientId given. Login will not work until you create"
    Warn "client\.env.local containing:  VITE_GOOGLE_CLIENT_ID=<your id>"
    Warn "Get one at https://console.cloud.google.com/apis/credentials"
    Warn "(OAuth client ID -> Web application -> add origin http://localhost:10004)"
}

if ($bash) {
    npm config set script-shell $bash.Source | Out-Null
    Note "npm script-shell -> bash (build:wasm uses rm -rf)"
} else {
    Warn "bash not found - 'npm run dev' will fail. Install Git for Windows."
}
Push-Location (Join-Path $RepoDir "client")
npm install
Pop-Location

# --- 6. Server ----------------------------------------------------------------
Step 6 "Building the server (several minutes)"
cargo build -p onlinerpg-server

# --- Done ---------------------------------------------------------------------
$id = if ($GoogleClientId) { $GoogleClientId } else { "<your client id>" }
Write-Host "`n=== Ready ===" -ForegroundColor Green
Write-Host "`nTerminal 1 - server (PowerShell, from $RepoDir):" -ForegroundColor Yellow
Write-Host "  `$env:GOOGLE_CLIENT_ID='$id'; `$env:ADMIN_EMAILS='<your gmail>'; cargo run -p onlinerpg-server"
Write-Host "`nTerminal 2 - client (Git Bash):" -ForegroundColor Yellow
Write-Host "  cd `"$RepoDir/client`" && npm run dev -- --port 10004"
Write-Host "`nThen open http://localhost:10004, sign in, create a character." -ForegroundColor Green
Write-Host "`nTo get a rod (new characters have 0 gold): stop the server and run" -ForegroundColor Green
Write-Host "  powershell -File grant-fishing-rod.ps1 -CharacterName 'YourName' -RepoDir '$RepoDir'"
Write-Host "`nYou spawn on a river bank. Equip the rod in your MAIN HAND and click" -ForegroundColor Green
Write-Host "the water. SPACE hooks and reels, S gives line." -ForegroundColor Green
