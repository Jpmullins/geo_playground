#!/usr/bin/env sh
set -eu

STATE_DIR="/root/.openclaw"
BOOTSTRAP_DIR="/bootstrap"

mkdir -p "$STATE_DIR/workspace"

# Always sync bootstrap config so endpoint/security changes are applied on restart.
cp "$BOOTSTRAP_DIR/openclaw.json" "$STATE_DIR/openclaw.json"

if [ ! -f "$STATE_DIR/workspace/AGENTS.md" ]; then
  cp "$BOOTSTRAP_DIR/AGENTS.md" "$STATE_DIR/workspace/AGENTS.md"
fi

exec openclaw gateway --bind lan --port 18789 --verbose
