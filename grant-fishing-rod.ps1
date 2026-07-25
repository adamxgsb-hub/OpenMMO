# grant-fishing-rod.ps1 — hand a character a fishing rod (and optionally admin
# rights and gold) by editing the server's SQLite database directly.
#
#   .\grant-fishing-rod.ps1 -CharacterName "Bob"
#   .\grant-fishing-rod.ps1 -CharacterName "Bob" -Admin -Gold 50000
#
# Why this is needed: new characters start with 0 gold, and the rod costs 3
# silver from the merchant Rica — who only exists in the world if you also run
# an agent-client for her. This is the shortcut for a quick test.
#
# STOP THE SERVER FIRST. It keeps inventory in memory and writes it back on
# logout, so edits made while it runs can be overwritten.

param(
    [Parameter(Mandatory = $true)]
    [string]$CharacterName,

    [string]$RepoDir = (Join-Path $HOME "OpenMMO"),

    # Also set admin_role = 1, enabling /drop, /time and /give in chat.
    # Your Google email must ALSO be in the server's ADMIN_EMAILS for these
    # to work — the server requires both.
    [switch]$Admin,

    # Optional starting gold, in copper (100 c = 1 silver, 10000 c = 1 gold).
    [int]$Gold = 0
)

$ErrorActionPreference = "Stop"

$db = Join-Path $RepoDir "data\game_data.db"
if (-not (Test-Path $db)) {
    throw "No database at $db - start the server and create a character first."
}

if (-not (Get-Command sqlite3 -ErrorAction SilentlyContinue)) {
    Write-Host "sqlite3 not found; installing via winget..." -ForegroundColor Yellow
    winget install --id SQLite.SQLite -e --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not (Get-Command sqlite3 -ErrorAction SilentlyContinue)) {
        throw "sqlite3 still not on PATH. Open a new terminal and re-run."
    }
}

# Guard against a typo'd name silently doing nothing.
$safeName = $CharacterName.Replace("'", "''")
$exists = (sqlite3 $db "SELECT COUNT(*) FROM characters WHERE character_name = '$safeName';").Trim()
if ($exists -ne "1") {
    $all = sqlite3 $db "SELECT character_name FROM characters;"
    throw "No character named '$CharacterName'. Characters in this database:`n$all"
}

$sql = @"
INSERT INTO character_items (character_id, item_def_id, quantity, equip_slot, enchant)
SELECT id, 'fishing_rod', 1, 'main_hand', 0 FROM characters
WHERE character_name = '$safeName'
  AND NOT EXISTS (
    SELECT 1 FROM character_items ci
    JOIN characters c ON c.id = ci.character_id
    WHERE c.character_name = '$safeName' AND ci.item_def_id = 'fishing_rod'
  );
"@
if ($Admin)   { $sql += "`nUPDATE characters SET admin_role = 1 WHERE character_name = '$safeName';" }
if ($Gold -gt 0) { $sql += "`nUPDATE characters SET gold = $Gold WHERE character_name = '$safeName';" }

sqlite3 $db $sql

Write-Host ""
Write-Host "Done. $CharacterName now has:" -ForegroundColor Green
sqlite3 -header -column $db @"
SELECT c.character_name AS name, c.gold, c.admin_role AS admin,
       COALESCE(i.equip_slot,'(bag)') AS rod_slot
FROM characters c
LEFT JOIN character_items i
  ON i.character_id = c.id AND i.item_def_id = 'fishing_rod'
WHERE c.character_name = '$safeName';
"@
Write-Host ""
Write-Host "Start the server again and log in. The rod is already in your main hand." -ForegroundColor Green
if ($Admin) {
    Write-Host "Admin also needs your email in ADMIN_EMAILS when starting the server," -ForegroundColor DarkGray
    Write-Host "then '/drop <item_def_id>' works in chat (e.g. /drop healing_potion)." -ForegroundColor DarkGray
}
