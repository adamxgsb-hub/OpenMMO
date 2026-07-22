#!/usr/bin/env bash
# Build a tarball someone can unpack on their own machine and run.
#
# The agent-client needs its data/ directory next to the binary (prompts,
# animation timings) but none of the 3 GB terrain tree — that comes over HTTP.
# Output: dist/agent-client-<commit>-<target>.tar.gz
#
# Defaults to a static musl build. A glibc build bakes in the build host's
# glibc version (ours needs 2.39, i.e. Ubuntu 24.04+), which strands everyone
# on an older distro; musl links libc in, so the binary runs anywhere x86_64.
# Needs: rustup target add x86_64-unknown-linux-musl && apt install musl-tools
# (ring compiles C, so a musl-targeting cc has to exist).
set -euo pipefail

REPO=${REPO:-$(cd "$(dirname "$0")/.." && pwd)}
OUT_DIR=${OUT_DIR:-$REPO/dist}
# Host only: the WebSocket lives at /ws (the reverse proxy upgrades that path
# and serves the game page at /), and the tile API at /api/terrain.
HOST=${HOST:-openmmo.to.nexus}

# Google's device flow requires the installed-app secret in the token
# exchange. It is not confidential (RFC 8252 section 8.5) and every shipped
# copy needs it, but it stays out of the repo: committing it trips secret
# scanners, so it is injected here from the packaging environment instead.
CLIENT_SECRET=${GOOGLE_CLI_CLIENT_SECRET:-}
if [[ -z $CLIENT_SECRET ]]; then
    echo "error: set GOOGLE_CLI_CLIENT_SECRET (Google Cloud → the CLI OAuth client)." >&2
    echo "       Without it the packaged client cannot complete Google sign-in." >&2
    exit 1
fi

TARGET=${TARGET:-x86_64-unknown-linux-musl}

cd "$REPO"
commit=$(git rev-parse --short HEAD)
name="agent-client-$commit-${TARGET%%-unknown-linux-*}-${TARGET##*-}"
stage="$OUT_DIR/$name"

cargo build --release --target "$TARGET" -p agent-client

rm -rf "$stage"
mkdir -p "$stage/data"
cp "target/$TARGET/release/agent-client" "$stage/"
# No data/templates: those are operator NPC roles (merchant, guard). A user
# agent has no template_prompt and falls back to data/system_prompt.txt.
cp agent-client/data/system_prompt.txt agent-client/data/animation_durations.json "$stage/data/"

# Registry NPC personas are operator-side; a user agent plays its own character.
cat > "$stage/data/config.toml" <<EOF
# agent-client configuration. Run the binary from this directory.
server = "wss://$HOST/ws"
terrain = "https://$HOST"

[auth]
mode = "google"
client_secret = "$CLIENT_SECRET"

[[npcs]]
character_name = "Change Me"
character_class = "ranger"
llm = "codex"

[codex]
model = "gpt-5.4-mini"
EOF

cp "$REPO/doc/AGENT_CLIENT_QUICKSTART.md" "$stage/README.md"

tar -czf "$OUT_DIR/$name.tar.gz" -C "$OUT_DIR" "$name"
rm -rf "$stage"
echo "==> $OUT_DIR/$name.tar.gz"
