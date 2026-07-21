---
description: "Deploy the current master to the prod server (build both binaries + client bundle on the prod host, publish, restart the systemd units) and verify it came up. Use when the user asks to deploy, ship, or push to prod. Restarts the game — it disconnects every live player."
---

You are deploying OnlineRPG to production. The deploy script (`tools/deploy-prod.sh`)
runs **on the prod host**: it `git pull --ff-only`s master, builds both Rust
binaries and the client bundle, rsyncs the bundle to the webroot, then restarts
both systemd units. Restarting disconnects everyone currently playing.

The prod host is the `prod` SSH alias. See README.md "Production Deployment" for
the reference.

## 1. Preflight — before touching prod

- **Push first.** The script pulls `master` on prod, so anything not on
  `origin/master` will not deploy. Run `git status` and `git log origin/master..HEAD`;
  if HEAD is ahead of origin or the tree is dirty, stop and get it committed and
  pushed (this repo commits straight to master — no feature branch). Confirm the
  commit you intend to ship is the one at `origin/master`.
- **Player-facing change? Write an announcement first.** Announcements show on the
  login screen. They live in `data/announcements/` but are **gitignored**
  (operator content — `.gitignore` excludes `*.md` except `_README.md`), so they
  do **not** ride the deploy. Format is in `data/announcements/_README.md`
  (`YYYY-MM-DD-title.md`, `title`/`title_en`/`category` frontmatter, `[en]` marker
  for the English body). Match the existing files' habits: include the
  server-restart notice ("업데이트 적용을 위해 서버가 잠시 재시작됩니다…"), write from
  the player's point of view (what they saw, not the mechanism), and if the fix is
  unverified in live play, say so. Then copy it up:
  ```bash
  scp data/announcements/<file>.md prod:~/work/OnlineRPG/data/announcements/
  ```
  A pure internal change (logging, refactor with no player-visible effect) needs
  no announcement — say so and skip it.

## 2. Launch the deploy, detached

A foreground run dies with the SSH connection and loses the whole build, so
detach it:
```bash
ssh prod 'setsid nohup bash ~/work/OnlineRPG/tools/deploy-prod.sh > ~/deploy-latest.log 2>&1 < /dev/null &'
```
The script builds everything before it touches live state (rsync + restarts at the
very end), so an interruption before that leaves the old bundle and old server
running as a matched pair — never a half-deploy.

## 3. Watch it to completion

Monitor `~/deploy-latest.log`. Use the Monitor tool with a filter that catches
both the success marker and failure signatures, e.g. grep for
`==> deployed|error|Error|error\[|failed|FAILED|panic|Killed|No space|fatal|is not running`.
The log ends at `==> deployed <commit>`. A typical run is a few minutes (two
release builds + wasm + Vite bundle).

## 4. Verify it came up

```bash
ssh prod 'systemctl is-active openmmo-server openmmo-agent-client'
ssh prod 'journalctl -u openmmo-server --since "2 min ago" -p err --no-pager -o cat | tail'
ssh prod 'journalctl -u openmmo-server -n 15 --no-pager -o cat'   # startup + passability cache line
```
Confirm both units are `active`, the startup log shows no panics, and the
"Passability cache ready" / "Server started successfully" lines are present.
A dead `openmmo-agent-client` (expired LLM login, outage) does **not** fail the
deploy — the game is already live — but flag it.

## 5. Report

Tell the user the deployed commit (`==> deployed <hash>`), that both units are up,
and whether the announcement shipped. If the deploy was to fix a bug with a log
signal (e.g. the `Blocked move` warns), compare its rate before vs after the
restart with `journalctl` rather than claiming success from a clean build alone —
a clean build only proves it compiled, not that the fix worked in play.

$ARGUMENTS
